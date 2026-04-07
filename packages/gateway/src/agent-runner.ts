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
import { createHash } from "node:crypto";
import type { ChannelMessage } from "@open-claude-code/adapter-core";
import type { ChannelManager } from "./channel-manager.js";
import type { MessageStore } from "./message-store.js";
import type { MemoryManager } from "./memory-manager.js";
import type { MessageRouter } from "./message-router.js";
import { createAgentMcpServer, type AgentMcpDeps } from "./agent-mcp.js";
import { createTypingController } from "./typing-controller.js";
import { createReplyTracker } from "./reply-tracker.js";
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
  /** Max spawned sub-tasks per conversation (0 = disabled) */
  maxChildrenPerSession?: number;
  /** Auto-abort timeout for spawned tasks in seconds */
  taskTimeoutSeconds?: number;
  /** Session idle timeout in ms (0 = never expire, default: 2h) */
  sessionIdleMs?: number;
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

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  turnCount: number;
};

type SpawnedTask = {
  taskId: string;
  parentKey: string;
  agent: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed";
  announce: boolean;
  channel: string;
  replyTo: string;
  accountId: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  cost?: number;
  abortController?: AbortController;
  timeoutTimer?: ReturnType<typeof setTimeout>;
};

// ─── Constants ───────────────────────────────────────────────────────────────

// TODO: Implement automatic block-reply pipeline (like OpenClaw's BlockReplyPipeline)
// that captures agent stream text_delta and sends intermediate chunks to the user
// without requiring explicit send_message calls. Current workaround: prompt-based.

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant responding to messages via the OpenClaudeCode messaging gateway.
You have access to MCP tools to send messages back. Use the send_message tool to reply.
Be concise and helpful. Match the language of the incoming message.
When you receive a message, respond directly using the send_message tool.

IMPORTANT - Progress reporting:
- For tasks that take more than a few steps, send progress updates via send_message.
- Example: "파일 3개 확인 완료, 이제 수정 시작합니다" or "50% 완료, CSS 작업 중입니다"
- Send an update at least every 3-5 tool calls during long tasks.
- Always send a final summary when the task is complete.
- Never leave the user waiting with no updates for a long time.

IMPORTANT - Mandatory memory recall:
- Before answering questions about prior work, decisions, preferences, or anything discussed in past sessions, you MUST call memory_search first.
- This ensures continuity across sessions even after gateway restarts.
- If memory_search returns relevant results, incorporate them into your response.

IMPORTANT - Auto memory capture:
- When the user shares important facts, preferences, decisions, or asks you to remember something, proactively save it to MEMORY.md using write_persona.
- When completing a significant task, save a brief summary of what was done to MEMORY.md.
- Keep MEMORY.md organized by topic, concise, and under 200 lines.
- Do NOT wait to be asked — capture important context automatically.

IMPORTANT - Task delegation:
- For tasks that will take many steps (file analysis, refactoring, research, web lookups), use spawn_task to delegate to a background sub-agent.
- spawn_task returns immediately — you can keep chatting with the user while the task runs.
- After spawning, tell the user what you delegated and that they can keep chatting with you.
- For simple questions, greetings, or quick responses, reply directly — don't over-delegate.
- Use task_status to check on running tasks if the user asks about progress.
- Available agents: "coder" (code tasks), "researcher" (web research), "translator" (translation), plus any custom agents from AGENTS.md.`;

const RESET_COMMANDS = ["/new", "/reset", "/리셋", "/새로"];

/** Error fallback messages by Agent SDK result subtype */
const ERROR_FALLBACK: Record<string, string> = {
  error_max_turns: "처리 시간이 초과되었습니다. 다시 시도해 주세요.",
  error_max_budget_usd: "처리 예산이 초과되었습니다. 다시 시도해 주세요.",
  error_during_execution: "처리 중 오류가 발생했습니다. 다시 시도해 주세요.",
};
const DEFAULT_ERROR = "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const NO_REPLY_FALLBACK = "죄송합니다, 응답을 생성하지 못했습니다. 다시 시도해 주세요.";

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
  private sessions = new Map<string, SessionEntry>(); // convKey → session entry
  private queues = new Map<string, QueueEntry[]>();
  private activeSessions = new Set<string>();
  private inProcessMcp: ReturnType<typeof createAgentMcpServer> | null = null;
  private mcpDeps: AgentMcpDeps | null = null;
  private spawnedTasks = new Map<string, SpawnedTask>();
  private sessionsDir: string;
  private dataDir: string;
  private skillsCache: SkillMeta[] | null = null;
  private sessionsFile: string; // Disk-backed session store

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
      maxTurns: 0,
      maxBudgetPerMessage: 999,
      maxMessageLength: 4000,
      bannedPatterns: [],
      enableSubagents: true,
      maxChildrenPerSession: 3,
      taskTimeoutSeconds: 300,
      sessionIdleMs: 2 * 60 * 60 * 1000, // 2 hours
      ...config,
    };

    this.sessionsDir = join(this.dataDir, "agent-sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }

    // Load persisted sessions from disk
    this.sessionsFile = join(this.dataDir, "sessions.json");
    this.loadSessionsFromDisk();

    // Ensure persona directory structure
    this.ensurePersonaFiles();
    // Ensure skills directory
    this.ensureSkillsDir();
    // Ensure memory directory
    this.ensureMemoryDir();

    console.log(`[agent-runner] Initialized (model: ${this.config.model}, maxTurns: ${this.config.maxTurns}, budget: $${this.config.maxBudgetPerMessage})`);
  }

  // ─── Session Persistence ─────────────────────────────────────────────────

  /** Load sessions map from disk (survives gateway restart) */
  private loadSessionsFromDisk(): void {
    try {
      if (existsSync(this.sessionsFile)) {
        const raw = readFileSync(this.sessionsFile, "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === "string") {
            // Backward compat: old format was just sessionId string
            this.sessions.set(key, { sessionId: val, updatedAt: Date.now(), totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, turnCount: 0 });
          } else if (val && typeof val === "object" && "sessionId" in val) {
            const entry = val as Partial<SessionEntry> & { sessionId: string };
            this.sessions.set(key, {
              sessionId: entry.sessionId,
              updatedAt: entry.updatedAt ?? Date.now(),
              totalInputTokens: entry.totalInputTokens ?? 0,
              totalOutputTokens: entry.totalOutputTokens ?? 0,
              totalCostUsd: entry.totalCostUsd ?? 0,
              turnCount: entry.turnCount ?? 0,
            });
          }
        }
        console.log(`[agent-runner] Restored ${this.sessions.size} session(s) from disk`);
      }
    } catch (err) {
      console.warn(`[agent-runner] Failed to load sessions from disk:`, err);
    }
  }

  /** Persist sessions map to disk */
  private saveSessionsToDisk(): void {
    try {
      const data: Record<string, { sessionId: string; updatedAt: number }> = {};
      for (const [key, entry] of this.sessions) {
        data[key] = entry;
      }
      writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[agent-runner] Failed to save sessions to disk:`, err);
    }
  }

  /** Check if a session is stale (idle too long) */
  private isSessionStale(key: string): boolean {
    const idleMs = this.config.sessionIdleMs ?? 0;
    if (idleMs <= 0) return false;
    const entry = this.sessions.get(key);
    if (!entry) return false;
    return Date.now() - entry.updatedAt > idleMs;
  }

  // ─── Initialization ──────────────────────────────────────────────────────

  /** Set channel manager + message router and create in-process MCP */
  setDependencies(channelManager: ChannelManager, messageRouter: MessageRouter): void {
    this.channelManager = channelManager;
    this.messageRouter = messageRouter;

    const deps: AgentMcpDeps = {
      messageRouter,
      store: this.store,
      memoryManager: this.memoryManager,
      dataDir: this.dataDir,
      messageSentHandlers: new Map(),
      taskSpawner: this,
    };
    this.mcpDeps = deps;
    this.inProcessMcp = createAgentMcpServer(deps);

    const skillCount = this.loadSkills().length;
    console.log(`[agent-runner] In-process MCP server created with 9 tools`);
    console.log(`[agent-runner] Loaded ${skillCount} skill(s)`);
    console.log(`[agent-runner] Persona files: ${this.getPersonaStatus()}`);
  }

  private ensurePersonaFiles(): void {
    // Create default persona files if none exist
    const hasAnyPersona = PERSONA_FILES.some(({ file }) =>
      existsSync(join(this.dataDir, file)),
    );
    if (hasAnyPersona) return;

    // Create starter SOUL.md with first-conversation onboarding rules
    const soulPath = join(this.dataDir, "SOUL.md");
    if (!existsSync(soulPath)) {
      writeFileSync(soulPath, [
        "# Soul",
        "",
        "You are a helpful, friendly AI assistant.",
        "Be concise and direct. Match the user's language.",
        "Use a warm but professional tone.",
        "",
        "## First Conversation Rules",
        "",
        "On your very first conversation (when IDENTITY.md has no real name and USER.md doesn't exist), you MUST:",
        "",
        "1. **Greet the user warmly** and introduce yourself as a new AI assistant",
        "2. **Ask the user's name** and any preferences they'd like you to know",
        "3. **Negotiate your own name** — suggest a few names and let the user pick, or accept their suggestion",
        "4. **Ask about personality preferences** — do they want you casual or formal? humorous or serious? emoji-heavy or minimal?",
        "5. **Save everything** using the `write_persona` tool:",
        "   - Write the user's name, preferences to `USER.md`",
        "   - Write your agreed-upon name and role to `IDENTITY.md`",
        "   - Update `SOUL.md` with the personality traits you agreed on",
        "",
        "Do NOT skip this onboarding. If the persona files are empty/default, always start with this flow before answering any other questions.",
        "",
        "## Persona Evolution",
        "",
        "As conversations continue, naturally evolve your personality:",
        "- Notice patterns in the user's communication style and adapt",
        "- When you learn something important about the user, save it to `USER.md` via `write_persona`",
        "- When your personality naturally shifts, update `SOUL.md` via `write_persona`",
        "",
      ].join("\n"), "utf-8");
    }

    // Create starter IDENTITY.md (to be filled during first conversation)
    const identityPath = join(this.dataDir, "IDENTITY.md");
    if (!existsSync(identityPath)) {
      writeFileSync(identityPath, [
        "# Identity",
        "",
        "- Name: (to be decided with user)",
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

  /** Auto-index conversation exchange into FTS memory for future recall */
  private indexConversationMemory(key: string, userText: string, result: string): void {
    try {
      if (result !== "success" && result !== "unknown") return;
      const text = userText.trim();
      if (!text || text.length < 10) return; // skip trivial messages

      const id = createHash("sha256")
        .update(text + key + Date.now())
        .digest("hex")
        .slice(0, 16);

      this.memoryManager.indexChunk({
        id,
        sessionKey: key,
        text: `User: ${text.slice(0, 500)}`,
        source: "session",
        timestamp: Date.now(),
      });
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
    if (!this.inProcessMcp || !this.mcpDeps) {
      console.error(`[agent-runner] In-process MCP not initialized. Call setDependencies() first.`);
      return;
    }

    const lastMsg = messages[messages.length - 1];

    // Handle reset commands
    for (const m of messages) {
      if (this.isResetCommand(m.text)) {
        this.sessions.delete(key);
        this.saveSessionsToDisk();
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

    const replyTo = lastMsg.chatType === "dm" ? lastMsg.from.id : (lastMsg.to?.id ?? lastMsg.from.id);

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
      `Reply using the send_message tool with channel="${lastMsg.channel}" and to="${replyTo}".`,
    ].join("\n");

    console.log(`[agent-runner] Invoking agent for ${key} (${messages.length} message(s))`);

    // --- 1. TypingController ---
    const typingChatId = replyTo;
    const typing = createTypingController({
      sendTyping: () => {
        this.channelManager?.sendTyping(lastMsg.channel, typingChatId, lastMsg.accountId).catch(() => {});
      },
    });

    // --- 2. ReplyTracker ---
    const tracker = createReplyTracker();

    // --- 2b. Set conversation context on MCP deps for spawn_task ---
    this.mcpDeps.conversationKey = key;
    this.mcpDeps.currentChannel = lastMsg.channel;
    this.mcpDeps.currentReplyTo = replyTo;
    this.mcpDeps.currentAccountId = lastMsg.accountId ?? "default";

    // --- 3. Register messageSentHandlers callback ---
    const handlerKey = `${lastMsg.channel}:${replyTo}`;
    this.mcpDeps.messageSentHandlers.set(handlerKey, () => {
      tracker.recordSend();
      typing.refresh();
    });

    // --- 4. Helper: send fallback message ---
    const sendFallback = async (text: string) => {
      try {
        await this.messageRouter?.send(
          lastMsg.channel,
          { to: replyTo, text },
          lastMsg.accountId ?? "default",
        );
      } catch (fallbackErr) {
        console.error(`[agent-runner] Failed to send fallback for ${key}:`, fallbackErr);
      }
    };

    const abortController = new AbortController();

    // Check session freshness — expire stale sessions
    if (this.isSessionStale(key)) {
      const idleMin = Math.round((this.config.sessionIdleMs ?? 0) / 60000);
      console.log(`[agent-runner] Session ${key} expired (idle > ${idleMin}m), starting fresh`);
      this.sessions.delete(key);
      this.saveSessionsToDisk();
    }
    const sessionEntry = this.sessions.get(key);
    const sessionId = sessionEntry?.sessionId;

    try {
      // --- Start typing ---
      await typing.start();

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
        "mcp__gateway__spawn_task",
        "mcp__gateway__task_status",
      ];
      if (hasSubagents) {
        allowedTools.push("Task");
      }

      // --- 5. Agent SDK query() stream ---
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
          ...(this.config.maxTurns > 0 ? { maxTurns: this.config.maxTurns } : {}),
          maxBudgetUsd: this.config.maxBudgetPerMessage,
          abortController,
        },
      });

      console.log(`[agent-runner] query() started for ${key} (maxTurns: ${this.config.maxTurns || "unlimited"}, maxBudget: $${this.config.maxBudgetPerMessage})`);

      let resultSubtype = "unknown";
      let turnCount = 0;
      let lastToolUsed = "";

      for await (const msg of q) {
        // Capture session ID for resume (persist to disk)
        if ("session_id" in msg && msg.session_id) {
          const prev = this.sessions.get(key);
          const now = Date.now();
          const updated: SessionEntry = {
            sessionId: msg.session_id,
            updatedAt: now,
            totalInputTokens: prev?.totalInputTokens ?? 0,
            totalOutputTokens: prev?.totalOutputTokens ?? 0,
            totalCostUsd: prev?.totalCostUsd ?? 0,
            turnCount: prev?.turnCount ?? 0,
          };
          this.sessions.set(key, updated);
          if (prev?.sessionId !== msg.session_id) {
            this.saveSessionsToDisk();
          }
        }

        // Refresh typing on assistant activity
        if (msg.type === "assistant") {
          turnCount++;
          typing.refresh();
        }

        // Track last tool used for diagnostics
        if (msg.type === "assistant" && "message" in msg) {
          const assistantMsg = msg as { message?: { content?: Array<{ type: string; name?: string }> } };
          const toolUse = assistantMsg.message?.content?.findLast?.((b: { type: string }) => b.type === "tool_use");
          if (toolUse && "name" in toolUse) {
            lastToolUsed = (toolUse as { name: string }).name;
          }
        }

        // Track costs and token usage from result
        if (msg.type === "result") {
          resultSubtype = msg.subtype;
          const resultMsg = msg as {
            usage?: { total_cost_usd?: number; input_tokens?: number; output_tokens?: number };
            subtype: string;
          };
          const cost = resultMsg.usage?.total_cost_usd ?? 0;
          const inputTokens = resultMsg.usage?.input_tokens ?? 0;
          const outputTokens = resultMsg.usage?.output_tokens ?? 0;

          // Accumulate token stats in session entry
          const entry = this.sessions.get(key);
          if (entry) {
            entry.totalInputTokens += inputTokens;
            entry.totalOutputTokens += outputTokens;
            entry.totalCostUsd += cost;
            entry.turnCount += turnCount;
            entry.updatedAt = Date.now();
            this.saveSessionsToDisk();
          }

          if (msg.subtype === "success") {
            console.log(`[agent-runner] Session ${key} completed. turns=${turnCount}, cost=$${cost.toFixed(4)}, tokens=${inputTokens}+${outputTokens}, sent=${tracker.getSentCount()}`);
          } else {
            console.error(`[agent-runner] Session ${key} ended: ${msg.subtype} | turns=${turnCount}, cost=$${cost.toFixed(4)}, sent=${tracker.getSentCount()}, lastTool=${lastToolUsed}`);
          }
        }
      }

      // --- 6. Agent run complete ---
      typing.markRunComplete();

      // --- 7. Always notify user of outcome ---
      if (resultSubtype === "success") {
        // Success but agent never called send_message
        if (!tracker.hasSent()) {
          console.log(`[agent-runner] No reply sent for ${key} (success), sending fallback`);
          await sendFallback(NO_REPLY_FALLBACK);
        }
      } else {
        // Error exit: always tell the user, even if partial replies were sent
        const fallbackText = ERROR_FALLBACK[resultSubtype] ?? DEFAULT_ERROR;
        console.log(`[agent-runner] Error exit for ${key} (${resultSubtype}, sent=${tracker.getSentCount()}), notifying user`);
        await sendFallback(fallbackText);
      }

      // --- 8. Dispatch idle ---
      typing.markDispatchIdle();

      // --- 9. Memory flush check ---
      await this.maybeFlushMemory(key);

      // Daily log
      this.appendDailyLog(key, messageTexts.slice(0, 300), resultSubtype);

      // Auto-index conversation into memory for future recall
      this.indexConversationMemory(key, messageTexts, resultSubtype);

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log(`[agent-runner] Session ${key} aborted`);
      } else {
        console.error(`[agent-runner] Session ${key} failed:`, err);
        // Exception: always notify user
        await sendFallback(DEFAULT_ERROR);
      }
    } finally {
      // --- 9. Cleanup ---
      typing.cleanup();
      this.mcpDeps?.messageSentHandlers.delete(handlerKey);
    }
  }

  // ─── Memory Flush ──────────────────────────────────────────────────────

  /** Context window threshold for triggering memory flush (80% of 200k) */
  private static readonly FLUSH_TOKEN_THRESHOLD = 160_000;
  /** Track which sessions have already been flushed this lifecycle */
  private flushedSessions = new Set<string>();

  /**
   * When total tokens in a session approach the context window limit,
   * trigger a special query that saves important context to MEMORY.md
   * before the next compaction wipes it.
   */
  private async maybeFlushMemory(key: string): Promise<void> {
    const entry = this.sessions.get(key);
    if (!entry) return;

    const totalTokens = entry.totalInputTokens + entry.totalOutputTokens;
    if (totalTokens < AgentRunner.FLUSH_TOKEN_THRESHOLD) return;
    if (this.flushedSessions.has(key)) return; // already flushed this cycle

    console.log(`[agent-runner] Token threshold reached for ${key} (${totalTokens} tokens), triggering memory flush`);
    this.flushedSessions.add(key);

    try {
      const flushPrompt = [
        "SYSTEM: Context window is approaching its limit. Before your conversation history is compacted,",
        "review the current conversation and save any important information that should be preserved.",
        "",
        "Use the write_persona tool to update MEMORY.md with:",
        "- Key decisions or conclusions reached",
        "- Important user preferences or requests discovered",
        "- Task outcomes or status updates",
        "- Any context that would be needed to continue this conversation later",
        "",
        "Be concise — MEMORY.md has a 200-line cap. Update existing entries rather than duplicating.",
        "After saving, briefly confirm what you preserved.",
      ].join("\n");

      const flushQ = query({
        prompt: flushPrompt,
        options: {
          model: this.config.model,
          systemPrompt: { type: "preset", preset: "claude_code", append: "You are performing a memory flush. Save important context concisely." },
          resume: entry.sessionId,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          cwd: this.sessionsDir,
          mcpServers: { gateway: this.inProcessMcp! },
          allowedTools: [
            "mcp__gateway__read_persona",
            "mcp__gateway__write_persona",
            "mcp__gateway__memory_search",
          ],
          maxTurns: 3,
          maxBudgetUsd: 1,
          abortController: new AbortController(),
        },
      });

      for await (const msg of flushQ) {
        if ("session_id" in msg && msg.session_id) {
          entry.sessionId = msg.session_id;
          entry.updatedAt = Date.now();
          this.saveSessionsToDisk();
        }
      }

      console.log(`[agent-runner] Memory flush completed for ${key}`);
    } catch (err) {
      console.error(`[agent-runner] Memory flush failed for ${key}:`, err);
    }
  }

  // ─── Task Spawning ──────────────────────────────────────────────────────

  /** Spawn a background sub-agent task (non-blocking, returns immediately) */
  spawnTask(opts: {
    task: string;
    parentKey: string;
    agent?: string;
    model?: string;
    announce?: boolean;
    timeoutSeconds?: number;
    channel: string;
    replyTo: string;
    accountId: string;
  }): { status: string; taskId: string; error?: string } {
    const maxChildren = this.config.maxChildrenPerSession ?? 3;
    if (maxChildren <= 0) {
      return { status: "rejected", taskId: "", error: "Task spawning is disabled" };
    }

    // Check per-session child limit
    const childCount = this.countChildrenForSession(opts.parentKey);
    if (childCount >= maxChildren) {
      return { status: "rejected", taskId: "", error: `Max children reached (${maxChildren})` };
    }

    const taskId = this.generateTaskId();
    const timeout = opts.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 300;

    const task: SpawnedTask = {
      taskId,
      parentKey: opts.parentKey,
      agent: opts.agent ?? "coder",
      task: opts.task,
      status: "queued",
      announce: opts.announce ?? true,
      channel: opts.channel,
      replyTo: opts.replyTo,
      accountId: opts.accountId,
      startedAt: Date.now(),
    };

    this.spawnedTasks.set(taskId, task);

    // Fire and forget — execute in background
    this.executeSpawnedTask(task, timeout).catch((err) => {
      console.error(`[agent-runner] Spawned task ${taskId} fatal error:`, err);
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();
    });

    console.log(`[agent-runner] Spawned task ${taskId} (agent: ${task.agent}) for ${opts.parentKey}`);
    return { status: "accepted", taskId };
  }

  /** Get status of spawned tasks */
  getTaskStatus(taskId?: string, parentKey?: string): SpawnedTask[] {
    if (taskId) {
      const task = this.spawnedTasks.get(taskId);
      return task ? [this.sanitizeTask(task)] : [];
    }
    if (parentKey) {
      return Array.from(this.spawnedTasks.values())
        .filter((t) => t.parentKey === parentKey)
        .map((t) => this.sanitizeTask(t));
    }
    return Array.from(this.spawnedTasks.values()).map((t) => this.sanitizeTask(t));
  }

  private sanitizeTask(task: SpawnedTask): SpawnedTask {
    // Return a copy without internal fields
    const { abortController, timeoutTimer, ...clean } = task;
    return {
      ...clean,
      task: clean.task.slice(0, 500),
      result: clean.result?.slice(0, 2000),
    };
  }

  private countChildrenForSession(parentKey: string): number {
    let count = 0;
    for (const task of this.spawnedTasks.values()) {
      if (task.parentKey === parentKey && (task.status === "queued" || task.status === "running")) {
        count++;
      }
    }
    return count;
  }

  private generateTaskId(): string {
    return createHash("sha256")
      .update(Date.now().toString() + Math.random().toString())
      .digest("hex")
      .slice(0, 12);
  }

  /** Execute a spawned task in a background agent session */
  private async executeSpawnedTask(task: SpawnedTask, timeoutSeconds: number): Promise<void> {
    if (!this.inProcessMcp || !this.mcpDeps) {
      task.status = "failed";
      task.error = "MCP not initialized";
      task.completedAt = Date.now();
      return;
    }

    // Wait for concurrency slot
    while (this.activeSessions.size >= this.config.maxConcurrent) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const sessionKey = `${task.parentKey}:task:${task.taskId}`;
    this.activeSessions.add(sessionKey);
    task.status = "running";

    const abortController = new AbortController();
    task.abortController = abortController;

    // Timeout safety valve
    task.timeoutTimer = setTimeout(() => {
      console.log(`[agent-runner] Task ${task.taskId} timed out (${timeoutSeconds}s)`);
      abortController.abort();
    }, timeoutSeconds * 1000);

    // Build a restricted MCP server for the sub-agent (no spawn_task, no write_persona)
    const subMcp = createAgentMcpServer({
      ...this.mcpDeps,
      // Sub-agents share the message router but get no messageSentHandlers tracking
      messageSentHandlers: new Map(),
    });

    try {
      const agentDefs = this.buildSubagents();
      const agentDef = agentDefs[task.agent];
      const model = agentDef?.model === "inherit"
        ? this.config.model
        : agentDef?.model === "haiku"
          ? "claude-haiku-4-5-20251001"
          : agentDef?.model === "opus"
            ? "claude-opus-4-6-20250609"
            : this.config.model;

      const systemPrompt = agentDef?.prompt ?? `You are a task worker. Complete the assigned task.`;
      const fullPrompt = [
        systemPrompt,
        "",
        `You have access to send_message to communicate results back to the user.`,
        `Use send_message with channel="${task.channel}" and to="${task.replyTo}" to send results.`,
      ].join("\n");

      // Sub-agent allowed tools: messaging + reading, but NO spawn_task, NO write_persona
      const allowedTools = [
        "mcp__gateway__send_message",
        "mcp__gateway__list_messages",
        "mcp__gateway__list_conversations",
        "mcp__gateway__memory_search",
        "mcp__gateway__memory_stats",
        "mcp__gateway__read_persona",
      ];

      const q = query({
        prompt: task.task,
        options: {
          model,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: fullPrompt,
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          cwd: this.sessionsDir,
          mcpServers: { gateway: subMcp },
          allowedTools,
          ...(this.config.maxTurns > 0 ? { maxTurns: this.config.maxTurns } : {}),
          maxBudgetUsd: this.config.maxBudgetPerMessage,
          abortController,
        },
      });

      let resultSubtype = "unknown";
      let lastAssistantText = "";

      for await (const msg of q) {
        if (msg.type === "assistant" && "message" in msg) {
          const assistantMsg = msg as { message?: { content?: Array<{ type: string; text?: string }> } };
          const textBlock = assistantMsg.message?.content?.findLast?.((b: { type: string }) => b.type === "text");
          if (textBlock && "text" in textBlock) {
            lastAssistantText = (textBlock as { text: string }).text;
          }
        }
        if (msg.type === "result") {
          resultSubtype = msg.subtype;
          const resultMsg = msg as { usage?: { total_cost_usd?: number } };
          task.cost = resultMsg.usage?.total_cost_usd ?? 0;
        }
      }

      task.completedAt = Date.now();

      if (resultSubtype === "success") {
        task.status = "completed";
        task.result = lastAssistantText || "(completed without text output)";
      } else {
        task.status = "failed";
        task.error = resultSubtype;
        task.result = lastAssistantText || undefined;
      }

      console.log(`[agent-runner] Task ${task.taskId} ${task.status} (${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s, $${(task.cost ?? 0).toFixed(4)})`);

    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();
      console.error(`[agent-runner] Task ${task.taskId} error:`, err);
    } finally {
      // Cleanup
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      task.abortController = undefined;
      task.timeoutTimer = undefined;
      this.activeSessions.delete(sessionKey);

      // Announce result to user
      if (task.announce) {
        await this.announceTaskResult(task);
      }
    }
  }

  /** Send task completion announcement to user's chat */
  private async announceTaskResult(task: SpawnedTask): Promise<void> {
    if (!this.messageRouter) return;

    const duration = task.completedAt
      ? ((task.completedAt - task.startedAt) / 1000).toFixed(1)
      : "?";
    const costStr = task.cost != null ? `$${task.cost.toFixed(4)}` : "";

    let text: string;
    if (task.status === "completed") {
      text = [
        `[Task completed: ${task.agent}]`,
        task.result?.slice(0, 2000) ?? "(no output)",
        "",
        `(taskId: ${task.taskId}, ${duration}s${costStr ? `, ${costStr}` : ""})`,
      ].join("\n");
    } else {
      text = [
        `[Task failed: ${task.agent}]`,
        task.error ?? "Unknown error",
        "",
        `(taskId: ${task.taskId}, ${duration}s${costStr ? `, ${costStr}` : ""})`,
      ].join("\n");
    }

    try {
      await this.messageRouter.send(
        task.channel,
        { to: task.replyTo, text },
        task.accountId,
      );
    } catch (err) {
      console.error(`[agent-runner] Failed to announce task ${task.taskId}:`, err);
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
      spawnedTasks: {
        active: Array.from(this.spawnedTasks.values()).filter((t) => t.status === "running" || t.status === "queued").length,
        total: this.spawnedTasks.size,
      },
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
