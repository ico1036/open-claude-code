/**
 * AgentRunner - Agent SDK-based auto-responder.
 *
 * Replaces the legacy AutoResponder that spawned `claude --print`.
 * Uses Agent SDK query() for in-process agent execution with:
 *  - Session resume (per conversation key)
 *  - In-process MCP tools (no IPC overhead)
 *  - Multi-file persona system (SOUL.md, IDENTITY.md, USER.md, AGENTS.md)
 *  - Subagents (translator, researcher, coder)
 *  - Hooks (message policy, tool logging, stop guard)
 *  - Skills system (SKILL.md loading from ~/.openclaudecode/skills/)
 *  - Enhanced memory (MEMORY.md + daily logs)
 *  - Cost tracking + maxTurns / maxBudget guardrails
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import type { ChannelMessage } from "@open-claude-code/adapter-core";
import type { ChannelManager } from "./channel-manager.js";
import type { MessageStore } from "./message-store.js";
import type { MemoryManager } from "./memory-manager.js";
import type { MessageRouter } from "./message-router.js";
import { createAgentMcpServer, type AgentMcpDeps } from "./agent-mcp.js";
import { loadConfig, getDataDir } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentRunnerConfig = {
  enabled: boolean;
  model: string;
  maxConcurrent: number;
  debounceMs: number;
  maxTurns: number;
  maxBudgetPerMessage: number;
  systemPrompt?: string;
  personaFile?: string;
  /** Max message length for send_message policy hook (0 = no limit) */
  maxMessageLength?: number;
  /** Banned words/patterns for send_message policy hook */
  bannedPatterns?: string[];
  /** Enable subagents (translator, researcher, coder) */
  enableSubagents?: boolean;
  /** Skills directory override */
  skillsDir?: string;
};

type QueueEntry = {
  message: ChannelMessage;
  timer?: ReturnType<typeof setTimeout>;
};

type SkillMeta = {
  name: string;
  description: string;
  path: string;
  body: string;
};

type AgentModel = "haiku" | "sonnet" | "opus" | "inherit";

type SubagentDef = {
  description: string;
  prompt: string;
  tools?: string[];
  model?: AgentModel;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant responding to messages via the OpenClaudeCode messaging gateway.
You have access to MCP tools to send messages back. Use the send_message tool to reply.
Be concise and helpful. Match the language of the incoming message.
When you receive a message, respond directly using the send_message tool.`;

const RESET_COMMANDS = ["/new", "/reset", "/리셋", "/새로"];

/** Persona files loaded in order, each becoming a section */
const PERSONA_FILES = [
  { file: "SOUL.md", header: "Soul & Personality" },
  { file: "IDENTITY.md", header: "Identity" },
  { file: "USER.md", header: "User Information" },
  { file: "AGENTS.md", header: "Behavior Rules" },
] as const;

// ─── AgentRunner ─────────────────────────────────────────────────────────────

export class AgentRunner {
  private config: AgentRunnerConfig;
  private store: MessageStore;
  private channelManager: ChannelManager | null = null;
  private memoryManager: MemoryManager;
  private messageRouter: MessageRouter | null = null;
  private sessions = new Map<string, string>(); // convKey → sessionId
  private queues = new Map<string, QueueEntry[]>();
  private activeSessions = new Set<string>();
  private inProcessMcp: ReturnType<typeof createAgentMcpServer> | null = null;
  private sessionsDir: string;
  private dataDir: string;
  private skillsCache: SkillMeta[] | null = null;

  constructor(
    store: MessageStore,
    memoryManager: MemoryManager,
    config: Partial<AgentRunnerConfig>,
  ) {
    this.store = store;
    this.memoryManager = memoryManager;
    this.dataDir = getDataDir();
    this.config = {
      enabled: true,
      model: "claude-sonnet-4-5-20250929",
      maxConcurrent: 3,
      debounceMs: 1500,
      maxTurns: 10,
      maxBudgetPerMessage: 0.50,
      maxMessageLength: 4000,
      bannedPatterns: [],
      enableSubagents: true,
      ...config,
    };

    this.sessionsDir = join(this.dataDir, "agent-sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }

    // Ensure persona directory structure
    this.ensurePersonaFiles();
    // Ensure skills directory
    this.ensureSkillsDir();
    // Ensure memory directory
    this.ensureMemoryDir();

    console.log(`[agent-runner] Initialized (model: ${this.config.model}, maxTurns: ${this.config.maxTurns}, budget: $${this.config.maxBudgetPerMessage})`);
  }

  // ─── Initialization ──────────────────────────────────────────────────────

  /** Set channel manager + message router and create in-process MCP */
  setDependencies(channelManager: ChannelManager, messageRouter: MessageRouter): void {
    this.channelManager = channelManager;
    this.messageRouter = messageRouter;

    this.inProcessMcp = createAgentMcpServer({
      messageRouter,
      store: this.store,
      memoryManager: this.memoryManager,
      dataDir: this.dataDir,
    });

    const skillCount = this.loadSkills().length;
    console.log(`[agent-runner] In-process MCP server created with 7 tools`);
    console.log(`[agent-runner] Loaded ${skillCount} skill(s)`);
    console.log(`[agent-runner] Persona files: ${this.getPersonaStatus()}`);
  }

  private ensurePersonaFiles(): void {
    // Create default persona files if none exist
    const hasAnyPersona = PERSONA_FILES.some(({ file }) =>
      existsSync(join(this.dataDir, file)),
    );
    if (hasAnyPersona) return;

    // Create starter SOUL.md
    const soulPath = join(this.dataDir, "SOUL.md");
    if (!existsSync(soulPath)) {
      writeFileSync(soulPath, [
        "# Soul",
        "",
        "You are a helpful, friendly AI assistant.",
        "Be concise and direct. Match the user's language.",
        "Use a warm but professional tone.",
        "",
      ].join("\n"), "utf-8");
    }

    // Create starter IDENTITY.md
    const identityPath = join(this.dataDir, "IDENTITY.md");
    if (!existsSync(identityPath)) {
      writeFileSync(identityPath, [
        "# Identity",
        "",
        "- Name: OpenClaudeCode Bot",
        "- Platform: OpenClaudeCode Gateway",
        "",
      ].join("\n"), "utf-8");
    }
  }

  private ensureSkillsDir(): void {
    const skillsDir = this.getSkillsDir();
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
  }

  private ensureMemoryDir(): void {
    const memDir = join(this.dataDir, "memory");
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }
    // Create MEMORY.md if it doesn't exist
    const memPath = join(this.dataDir, "MEMORY.md");
    if (!existsSync(memPath)) {
      writeFileSync(memPath, [
        "# Long-term Memory",
        "",
        "<!-- Agent writes important facts here. Loaded at session start. -->",
        "",
      ].join("\n"), "utf-8");
    }
  }

  private getSkillsDir(): string {
    return this.config.skillsDir ?? join(this.dataDir, "skills");
  }

  // ─── Persona System ──────────────────────────────────────────────────────

  /** Load multi-file persona: SOUL.md + IDENTITY.md + USER.md + AGENTS.md */
  private loadPersona(): string {
    const parts: string[] = [];

    // 1. Base system prompt
    parts.push(this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

    // 2. Load each persona file
    for (const { file, header } of PERSONA_FILES) {
      // Check custom persona file first, then data dir
      const customPath = this.config.personaFile
        ? join(this.config.personaFile, "..", file)
        : null;
      const defaultPath = join(this.dataDir, file);

      const path = (customPath && existsSync(customPath)) ? customPath : defaultPath;

      if (existsSync(path)) {
        try {
          const content = readFileSync(path, "utf-8").trim();
          if (content) {
            parts.push(`\n## ${header}\n${content}`);
          }
        } catch {
          // skip
        }
      }
    }

    // 3. Load long-term memory
    const memoryContent = this.loadMemory();
    if (memoryContent) {
      parts.push(`\n## Long-term Memory\n${memoryContent}`);
    }

    // 4. Load active skills summary
    const skillsSummary = this.getSkillsSummary();
    if (skillsSummary) {
      parts.push(`\n## Available Skills\n${skillsSummary}`);
    }

    return parts.join("\n");
  }

  private getPersonaStatus(): string {
    return PERSONA_FILES
      .filter(({ file }) => existsSync(join(this.dataDir, file)))
      .map(({ file }) => file)
      .join(", ") || "(none)";
  }

  // ─── Memory System ───────────────────────────────────────────────────────

  /** Load MEMORY.md for long-term context */
  private loadMemory(): string | null {
    const memPath = join(this.dataDir, "MEMORY.md");
    if (!existsSync(memPath)) return null;
    try {
      const content = readFileSync(memPath, "utf-8").trim();
      // Limit to ~200 lines to avoid context bloat
      const lines = content.split("\n");
      return lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n...(truncated)" : content;
    } catch {
      return null;
    }
  }

  /** Append to today's daily log */
  private appendDailyLog(key: string, userText: string, _assistantResult: string): void {
    try {
      const memDir = join(this.dataDir, "memory");
      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(memDir, `${today}.md`);

      const entry = [
        `\n## ${new Date().toISOString().slice(11, 19)} [${key}]`,
        `**User**: ${userText.slice(0, 200)}`,
        `**Result**: ${_assistantResult.slice(0, 200)}`,
        "",
      ].join("\n");

      appendFileSync(logPath, entry, "utf-8");
    } catch {
      // non-critical
    }
  }

  // ─── Skills System ───────────────────────────────────────────────────────

  /** Load all skills from skills directory */
  private loadSkills(): SkillMeta[] {
    if (this.skillsCache) return this.skillsCache;

    const skills: SkillMeta[] = [];
    const skillsDir = this.getSkillsDir();

    if (!existsSync(skillsDir)) {
      this.skillsCache = skills;
      return skills;
    }

    try {
      const entries = readdirSync(skillsDir);
      for (const entry of entries) {
        const skillDir = join(skillsDir, entry);
        if (!statSync(skillDir).isDirectory()) continue;

        const skillMd = join(skillDir, "SKILL.md");
        if (!existsSync(skillMd)) continue;

        try {
          const content = readFileSync(skillMd, "utf-8");
          const meta = this.parseSkillMd(content, entry, skillDir);
          if (meta) skills.push(meta);
        } catch {
          // skip broken skills
        }
      }
    } catch {
      // skip
    }

    this.skillsCache = skills;
    return skills;
  }

  /** Parse SKILL.md frontmatter + body */
  private parseSkillMd(content: string, dirName: string, dirPath: string): SkillMeta | null {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fmMatch) {
      // No frontmatter - use directory name
      return {
        name: dirName,
        description: content.slice(0, 200),
        path: dirPath,
        body: content,
      };
    }

    const frontmatter = fmMatch[1];
    const body = fmMatch[2];

    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);

    return {
      name: nameMatch?.[1]?.trim() ?? dirName,
      description: descMatch?.[1]?.trim() ?? body.slice(0, 200),
      path: dirPath,
      body,
    };
  }

  /** Get skills summary for system prompt */
  private getSkillsSummary(): string | null {
    const skills = this.loadSkills();
    if (skills.length === 0) return null;

    const lines = skills.map(
      (s) => `- **${s.name}**: ${s.description.slice(0, 150)}`,
    );
    return [
      "The following skills are available. When a task matches a skill description, follow the skill's instructions.",
      ...lines,
      "",
      "To use a skill, read its SKILL.md and follow the workflow defined there.",
    ].join("\n");
  }

  // ─── Subagents ───────────────────────────────────────────────────────────

  /** Build subagent definitions */
  private buildSubagents(): Record<string, SubagentDef> {
    if (!this.config.enableSubagents) return {};

    const agents: Record<string, SubagentDef> = {
      translator: {
        description: "Language translation specialist. Use when the user asks for translation or when you need to translate content between languages.",
        prompt: `You are a professional translator. Translate accurately while preserving tone and nuance.
Provide only the translation, no explanations unless asked.
If the source language is ambiguous, ask for clarification.`,
        tools: ["Read", "Grep", "Glob"],
        model: "haiku",
      },
      researcher: {
        description: "Web research specialist. Use when you need to search the web, look up current information, or gather data from URLs.",
        prompt: `You are a research assistant. Search the web and gather accurate information.
Summarize findings concisely. Always cite sources.
Focus on factual, up-to-date information.`,
        tools: ["WebSearch", "WebFetch", "Read"],
        model: "haiku",
      },
      coder: {
        description: "Code generation and analysis specialist. Use for writing code, debugging, running tests, or analyzing codebases.",
        prompt: `You are a senior software engineer. Write clean, efficient, well-tested code.
Follow the project's existing patterns and conventions.
Be concise - code speaks louder than comments.`,
        tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob"],
        model: "sonnet",
      },
    };

    // Load custom agents from AGENTS.md agent definitions section
    const agentsPath = join(this.dataDir, "AGENTS.md");
    if (existsSync(agentsPath)) {
      try {
        const content = readFileSync(agentsPath, "utf-8");
        const customAgents = this.parseCustomAgents(content);
        Object.assign(agents, customAgents);
      } catch {
        // use defaults only
      }
    }

    return agents;
  }

  /** Parse custom agent definitions from AGENTS.md */
  private parseCustomAgents(content: string): Record<string, SubagentDef> {
    const agents: Record<string, SubagentDef> = {};

    // Look for ```agent blocks in AGENTS.md
    // Format:
    // ```agent name=my-agent model=haiku
    // description: What this agent does
    // tools: Read, Grep, Bash
    // ---
    // System prompt for the agent goes here
    // ```
    const blockRegex = /```agent\s+name=(\S+)(?:\s+model=(\S+))?\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = blockRegex.exec(content)) !== null) {
      const name = match[1];
      const model = match[2];
      const body = match[3];

      const descMatch = body.match(/^description:\s*(.+)$/m);
      const toolsMatch = body.match(/^tools:\s*(.+)$/m);
      const promptSep = body.indexOf("---");
      const prompt = promptSep >= 0 ? body.slice(promptSep + 3).trim() : body.trim();

      agents[name] = {
        description: descMatch?.[1]?.trim() ?? `Custom agent: ${name}`,
        prompt: prompt || `You are a specialized agent named ${name}.`,
        tools: toolsMatch?.[1]?.split(",").map((t) => t.trim()).filter(Boolean),
        model: (["haiku", "sonnet", "opus", "inherit"].includes(model ?? "") ? model as AgentModel : "sonnet"),
      };
    }

    return agents;
  }

  // ─── Hooks ───────────────────────────────────────────────────────────────

  /** Build hooks configuration */
  private buildHooks() {
    const hooks: Record<string, Array<{ matcher?: string; hooks: Array<(input: unknown, toolUseID: string, ctx: { signal: AbortSignal }) => Promise<Record<string, unknown>>> }>> = {};

    // PreToolUse: Message policy enforcement
    hooks.PreToolUse = [
      {
        matcher: "mcp__gateway__send_message",
        hooks: [
          async (input: unknown) => {
            const inp = input as { tool_input?: { text?: string } };
            const text = inp.tool_input?.text;

            if (!text) return {};

            // Length limit
            const maxLen = this.config.maxMessageLength ?? 4000;
            if (maxLen > 0 && text.length > maxLen) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: `Message too long (${text.length} chars, max ${maxLen})`,
                },
              };
            }

            // Banned patterns
            const banned = this.config.bannedPatterns ?? [];
            for (const pattern of banned) {
              if (new RegExp(pattern, "i").test(text)) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: `Message contains banned pattern: ${pattern}`,
                  },
                };
              }
            }

            return {};
          },
        ],
      },
    ];

    // PostToolUse: Log tool usage
    hooks.PostToolUse = [
      {
        hooks: [
          async (input: unknown) => {
            const inp = input as { tool_name?: string };
            if (inp.tool_name) {
              console.log(`[agent-runner/hook] Tool used: ${inp.tool_name}`);
            }
            return {};
          },
        ],
      },
    ];

    return hooks;
  }

  // ─── Queue & Session Management ──────────────────────────────────────────

  private getConversationKey(msg: ChannelMessage): string {
    if (msg.chatType === "group" || msg.chatType === "channel") {
      return `${msg.channel}:${msg.to?.id ?? msg.from.id}`;
    }
    return `${msg.channel}:${msg.from.id}`;
  }

  private shouldRespond(msg: ChannelMessage): boolean {
    if (!this.config.enabled) return false;
    if (msg.from.id === "_self") return false;

    const appConfig = loadConfig();
    const channelConfig = appConfig.channels[msg.channel];
    if (!channelConfig?.autoReply) return false;

    if (channelConfig.allowFrom && channelConfig.allowFrom.length > 0) {
      const allowed = channelConfig.allowFrom.some(
        (entry) => entry === msg.from.id || entry === msg.from.username || entry === msg.from.name,
      );
      if (!allowed) {
        console.log(`[agent-runner] Ignoring message from ${msg.from.id} (not in allowlist)`);
        return false;
      }
    }

    return true;
  }

  /** Handle an incoming message */
  handleMessage(msg: ChannelMessage): void {
    if (!this.shouldRespond(msg)) return;

    const key = this.getConversationKey(msg);

    if (!this.queues.has(key)) {
      this.queues.set(key, []);
    }

    const queue = this.queues.get(key)!;

    const lastEntry = queue[queue.length - 1];
    if (lastEntry?.timer) {
      clearTimeout(lastEntry.timer);
      lastEntry.timer = undefined;
    }

    const entry: QueueEntry = { message: msg };
    queue.push(entry);

    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.processQueue(key);
    }, this.config.debounceMs);
  }

  private async processQueue(key: string): Promise<void> {
    if (this.activeSessions.size >= this.config.maxConcurrent) {
      console.log(`[agent-runner] Max concurrent sessions (${this.config.maxConcurrent}), deferring ${key}`);
      setTimeout(() => this.processQueue(key), 5000);
      return;
    }

    if (this.activeSessions.has(key)) return;

    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    const messages = [...queue];
    this.queues.delete(key);

    this.activeSessions.add(key);

    try {
      await this.invokeAgent(key, messages.map((e) => e.message));
    } catch (err) {
      console.error(`[agent-runner] Error processing ${key}:`, err);
    } finally {
      this.activeSessions.delete(key);

      if (this.queues.has(key) && this.queues.get(key)!.length > 0) {
        this.processQueue(key);
      }
    }
  }

  private isResetCommand(text: string | undefined): boolean {
    if (!text) return false;
    const trimmed = text.trim().toLowerCase();
    return RESET_COMMANDS.some((cmd) => trimmed === cmd || trimmed.startsWith(cmd + " "));
  }

  // ─── Agent Invocation ────────────────────────────────────────────────────

  private async invokeAgent(key: string, messages: ChannelMessage[]): Promise<void> {
    if (!this.inProcessMcp) {
      console.error(`[agent-runner] In-process MCP not initialized. Call setDependencies() first.`);
      return;
    }

    const lastMsg = messages[messages.length - 1];

    // Handle reset commands
    for (const m of messages) {
      if (this.isResetCommand(m.text)) {
        this.sessions.delete(key);
        console.log(`[agent-runner] Session reset for ${key}`);
        return;
      }
    }

    // Build prompt
    const senderLabel = lastMsg.from.name
      ? `${lastMsg.from.name} (${lastMsg.from.id})`
      : lastMsg.from.id;

    const messageTexts = messages
      .map((m) => m.text ?? "(media/attachment)")
      .join("\n");

    const userPrompt = [
      `## Incoming message`,
      `- **Channel**: ${lastMsg.channel}`,
      `- **From**: ${senderLabel}`,
      `- **Chat type**: ${lastMsg.chatType}${lastMsg.to?.name ? ` in ${lastMsg.to.name}` : lastMsg.chatType === "dm" ? " in DM" : ""}`,
      `- **Time**: ${new Date(lastMsg.timestamp).toISOString()}`,
      "",
      `**Message:**`,
      messageTexts,
      "",
      `Reply using the send_message tool with channel="${lastMsg.channel}" and to="${lastMsg.chatType === "dm" ? lastMsg.from.id : (lastMsg.to?.id ?? lastMsg.from.id)}".`,
    ].join("\n");

    console.log(`[agent-runner] Invoking agent for ${key} (${messages.length} message(s))`);

    // Send typing indicator
    const typingChatId = lastMsg.chatType === "dm" ? lastMsg.from.id : (lastMsg.to?.id ?? lastMsg.from.id);
    const sendTyping = () => {
      this.channelManager?.sendTyping(lastMsg.channel, typingChatId, lastMsg.accountId).catch(() => {});
    };
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    const abortController = new AbortController();
    const sessionId = this.sessions.get(key);

    try {
      const systemPrompt = this.loadPersona();
      const subagents = this.buildSubagents();
      const hooks = this.buildHooks();
      const hasSubagents = Object.keys(subagents).length > 0;

      // Build allowed tools list
      const allowedTools = [
        "mcp__gateway__send_message",
        "mcp__gateway__list_messages",
        "mcp__gateway__list_conversations",
        "mcp__gateway__memory_search",
        "mcp__gateway__memory_stats",
        "mcp__gateway__read_persona",
        "mcp__gateway__write_persona",
      ];
      if (hasSubagents) {
        allowedTools.push("Task");
      }

      const q = query({
        prompt: userPrompt,
        options: {
          model: this.config.model,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemPrompt,
          },
          resume: sessionId,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          cwd: this.sessionsDir,
          mcpServers: {
            gateway: this.inProcessMcp,
          },
          allowedTools,
          ...(hasSubagents ? { agents: subagents } : {}),
          hooks,
          maxTurns: this.config.maxTurns,
          maxBudgetUsd: this.config.maxBudgetPerMessage,
          abortController,
        },
      });

      let resultSubtype = "unknown";

      for await (const msg of q) {
        // Capture session ID for resume
        if ("session_id" in msg && msg.session_id) {
          this.sessions.set(key, msg.session_id);
        }

        // Refresh typing indicator on activity
        if (msg.type === "assistant") {
          sendTyping();
        }

        // Track costs from result
        if (msg.type === "result") {
          resultSubtype = msg.subtype;
          if (msg.subtype === "success") {
            const cost = (msg as { usage?: { total_cost_usd?: number } }).usage?.total_cost_usd ?? 0;
            console.log(`[agent-runner] Session ${key} completed. Cost: $${cost.toFixed(4)}`);
          } else {
            console.error(`[agent-runner] Session ${key} ended: ${msg.subtype}`);
          }
        }
      }

      // Daily log
      this.appendDailyLog(key, messageTexts.slice(0, 300), resultSubtype);

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log(`[agent-runner] Session ${key} aborted`);
      } else {
        console.error(`[agent-runner] Session ${key} failed:`, err);
      }
    } finally {
      clearInterval(typingInterval);
    }
  }

  // ─── Status & Control ────────────────────────────────────────────────────

  getStatus() {
    const skills = this.loadSkills();
    const subagents = this.buildSubagents();
    return {
      enabled: this.config.enabled,
      model: this.config.model,
      activeSessions: this.activeSessions.size,
      maxConcurrent: this.config.maxConcurrent,
      queuedConversations: this.queues.size,
      trackedSessions: this.sessions.size,
      maxTurns: this.config.maxTurns,
      maxBudgetPerMessage: this.config.maxBudgetPerMessage,
      persona: this.getPersonaStatus(),
      skills: skills.map((s) => s.name),
      subagents: Object.keys(subagents),
      hooks: ["PreToolUse:message_policy", "PostToolUse:tool_logger"],
    };
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    console.log(`[agent-runner] ${enabled ? "Enabled" : "Disabled"}`);
  }

  /** Force reload skills cache */
  reloadSkills(): void {
    this.skillsCache = null;
    const count = this.loadSkills().length;
    console.log(`[agent-runner] Reloaded ${count} skill(s)`);
  }
}
