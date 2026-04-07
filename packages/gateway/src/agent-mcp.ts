/**
 * In-process MCP server for the Agent SDK.
 *
 * Unlike mcp-server.ts (which runs over stdio/IPC for interactive Claude Code),
 * this server runs in the same process as the gateway daemon and is passed
 * directly to Agent SDK query() calls. No IPC overhead.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MessageRouter } from "./message-router.js";
import type { MessageStore } from "./message-store.js";
import type { MemoryManager } from "./memory-manager.js";

/** Minimal interface for task spawning — avoids circular import of AgentRunner */
export type TaskSpawner = {
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
  }): { status: string; taskId: string; error?: string };
  getTaskStatus(taskId?: string, parentKey?: string): Array<{
    taskId: string;
    status: string;
    agent: string;
    task: string;
    startedAt: number;
    completedAt?: number;
    result?: string;
    error?: string;
    cost?: number;
  }>;
};

export type AgentMcpDeps = {
  messageRouter: MessageRouter;
  store: MessageStore;
  memoryManager: MemoryManager;
  dataDir: string;
  /** Per-conversation callbacks fired when send_message succeeds (key: "channel:to") */
  messageSentHandlers: Map<string, () => void>;
  /** Task spawner for background sub-agent tasks (null for sub-agent sessions) */
  taskSpawner?: TaskSpawner | null;
  /** Current conversation key (for task spawning context) */
  conversationKey?: string;
  /** Current channel (for task spawning context) */
  currentChannel?: string;
  /** Current reply-to target (for task spawning context) */
  currentReplyTo?: string;
  /** Current account ID (for task spawning context) */
  currentAccountId?: string;
};

/** Valid persona file names that the agent can read/write */
const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "MEMORY.md"] as const;

/** Resolve file path based on memory scope */
function resolveMemoryPath(dataDir: string, file: string, scope: "user" | "channel", conversationKey?: string): string {
  if (scope === "channel" && conversationKey) {
    // Sanitize key for filesystem (replace : with -)
    const safeKey = conversationKey.replace(/[:/\\]/g, "-");
    return join(dataDir, "memory", "channels", safeKey, file);
  }
  return join(dataDir, file);
}

/** Max message length per chunk (Telegram limit is 4096) */
const MAX_CHUNK_LENGTH = 4000;

/**
 * Split long text into chunks at markdown-aware boundaries.
 * Preserves code fences: when splitting inside a code block,
 * closes the fence and reopens it in the next chunk.
 */
function chunkMarkdownText(text: string, maxLen = MAX_CHUNK_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLen;

    // Try to split at a double newline (paragraph break)
    const paraBreak = remaining.lastIndexOf("\n\n", maxLen);
    if (paraBreak > maxLen * 0.3) {
      splitAt = paraBreak + 2;
    } else {
      // Fall back to single newline
      const lineBreak = remaining.lastIndexOf("\n", maxLen);
      if (lineBreak > maxLen * 0.3) {
        splitAt = lineBreak + 1;
      }
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Handle code fences: check if we're splitting inside a code block
    const fenceMatches = chunk.match(/```[\w]*/g) ?? [];
    const isInsideCodeBlock = fenceMatches.length % 2 !== 0;

    if (isInsideCodeBlock) {
      // Find what language the last opening fence used
      const lastOpenFence = chunk.match(/```[\w]*(?![\s\S]*```)/)?.[0] ?? "```";
      chunk += "\n```";
      remaining = lastOpenFence + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

export function createAgentMcpServer(deps: AgentMcpDeps) {
  const { messageRouter, store, memoryManager, dataDir } = deps;

  return createSdkMcpServer({
    name: "gateway",
    version: "0.1.0",
    tools: [
      tool(
        "send_message",
        "Send a message to a specific recipient on a connected channel. Use this to reply to the user.",
        {
          channel: z.string().describe("Channel to send through: whatsapp, telegram, or discord"),
          to: z.string().describe("Recipient identifier (phone number, chat ID, channel ID)"),
          text: z.string().describe("Message text to send"),
          replyToId: z.string().optional().describe("Message ID to reply to (optional)"),
          accountId: z.string().optional().describe("Account ID to use (optional, default: 'default')"),
        },
        async (args) => {
          const chunks = chunkMarkdownText(args.text);
          let lastResult: unknown = null;
          let allSuccess = true;

          for (const chunk of chunks) {
            const result = await messageRouter.send(
              args.channel,
              { to: args.to, text: chunk, replyToId: args.replyToId },
              args.accountId ?? "default",
            );
            lastResult = result;
            if (!(result as { success?: boolean }).success) {
              allSuccess = false;
              break;
            }
          }

          // Notify the reply tracker for this conversation
          if (allSuccess) {
            const handlerKey = `${args.channel}:${args.to}`;
            deps.messageSentHandlers.get(handlerKey)?.();
          }
          return {
            content: [{ type: "text", text: JSON.stringify(
              chunks.length > 1
                ? { ...lastResult as object, chunked: true, totalChunks: chunks.length }
                : lastResult,
              null, 2,
            ) }],
          };
        },
      ),

      tool(
        "list_messages",
        "List recent messages received by the gateway, optionally filtered by channel, sender, or time range.",
        {
          channel: z.string().optional().describe("Filter by channel"),
          from: z.string().optional().describe("Filter by sender ID"),
          limit: z.number().optional().describe("Max messages to return (default: 20)"),
          since: z.number().optional().describe("Only messages after this Unix timestamp"),
        },
        async (args) => {
          const messages = store.listMessages({
            channel: args.channel,
            from: args.from,
            limit: args.limit,
            since: args.since,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
          };
        },
      ),

      tool(
        "list_conversations",
        "List active conversations across all connected channels. Groups messages by sender.",
        {
          channel: z.string().optional().describe("Filter by channel"),
          limit: z.number().optional().describe("Max conversations (default: 20)"),
        },
        async (args) => {
          const conversations = store.listConversations({
            channel: args.channel,
            limit: args.limit,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(conversations, null, 2) }],
          };
        },
      ),

      tool(
        "memory_search",
        "Search past conversation memories using full-text search. Returns relevant snippets from previous conversations ranked by relevance.",
        {
          query: z.string().describe("Search query - keywords to find in past conversations"),
          maxResults: z.number().optional().describe("Maximum number of results to return (default: 10)"),
          sessionKey: z.string().optional().describe("Filter by session key, e.g. 'telegram:12345' (optional)"),
        },
        async (args) => {
          const results = memoryManager.search(args.query, {
            maxResults: args.maxResults,
            sessionKey: args.sessionKey,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          };
        },
      ),

      tool(
        "memory_stats",
        "Get statistics about the memory index - total indexed chunks and distinct sessions.",
        {},
        async () => {
          const stats = memoryManager.getStats();
          return {
            content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
          };
        },
      ),

      tool(
        "read_persona",
        "Read a persona or memory file. Scope: 'user' (global, default) or 'channel' (per-conversation). Valid files: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, MEMORY.md",
        {
          file: z.string().describe("File name to read: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, or MEMORY.md"),
          scope: z.enum(["user", "channel"]).optional().describe("Memory scope: 'user' (global, default) or 'channel' (per-conversation)"),
        },
        async (args) => {
          if (!PERSONA_FILES.includes(args.file as typeof PERSONA_FILES[number])) {
            return {
              content: [{ type: "text", text: `Invalid file. Must be one of: ${PERSONA_FILES.join(", ")}` }],
            };
          }
          const filePath = resolveMemoryPath(dataDir, args.file, args.scope ?? "user", deps.conversationKey);
          if (!existsSync(filePath)) {
            return {
              content: [{ type: "text", text: `File ${args.file} does not exist yet (scope: ${args.scope ?? "user"}). Use write_persona to create it.` }],
            };
          }
          const content = readFileSync(filePath, "utf-8");
          return {
            content: [{ type: "text", text: content }],
          };
        },
      ),

      tool(
        "write_persona",
        "Write or update a persona or memory file. Scope: 'user' (global, default) or 'channel' (per-conversation). Use 'channel' scope to store conversation-specific preferences. Valid files: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, MEMORY.md",
        {
          file: z.string().describe("File name to write: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, or MEMORY.md"),
          content: z.string().describe("Full content to write to the file (replaces existing content)"),
          scope: z.enum(["user", "channel"]).optional().describe("Memory scope: 'user' (global, default) or 'channel' (per-conversation)"),
        },
        async (args) => {
          if (!PERSONA_FILES.includes(args.file as typeof PERSONA_FILES[number])) {
            return {
              content: [{ type: "text", text: `Invalid file. Must be one of: ${PERSONA_FILES.join(", ")}` }],
            };
          }
          const filePath = resolveMemoryPath(dataDir, args.file, args.scope ?? "user", deps.conversationKey);
          // Ensure parent directory exists for channel-scoped files
          const dir = filePath.substring(0, filePath.lastIndexOf("/"));
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(filePath, args.content, "utf-8");
          return {
            content: [{ type: "text", text: `Successfully updated ${args.file} (scope: ${args.scope ?? "user"})` }],
          };
        },
      ),

      // ─── Task Spawning Tools ───────────────────────────────────────────

      tool(
        "spawn_task",
        "Spawn a background sub-agent task. Returns immediately — the task runs in the background. Use this for long-running work (file analysis, refactoring, research) so you can keep chatting with the user. The sub-agent will announce its result to the chat when done.",
        {
          task: z.string().describe("Full instruction for the sub-agent — include all context it needs"),
          agent: z.string().optional().describe("Agent profile to use: 'coder', 'researcher', 'translator', or a custom agent name (default: 'coder')"),
          announce: z.boolean().optional().describe("Auto-send result to chat on completion (default: true)"),
          timeoutSeconds: z.number().optional().describe("Abort timeout in seconds (default: 300)"),
        },
        async (args) => {
          if (!deps.taskSpawner) {
            return {
              content: [{ type: "text", text: JSON.stringify({ status: "rejected", error: "Task spawning not available in this context" }) }],
            };
          }
          if (!deps.conversationKey || !deps.currentChannel || !deps.currentReplyTo) {
            return {
              content: [{ type: "text", text: JSON.stringify({ status: "rejected", error: "Missing conversation context" }) }],
            };
          }

          const result = deps.taskSpawner.spawnTask({
            task: args.task,
            parentKey: deps.conversationKey,
            agent: args.agent,
            announce: args.announce,
            timeoutSeconds: args.timeoutSeconds,
            channel: deps.currentChannel,
            replyTo: deps.currentReplyTo,
            accountId: deps.currentAccountId ?? "default",
          });

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        },
      ),

      tool(
        "task_status",
        "Check the status of spawned background tasks. Call without taskId to list all tasks for this conversation.",
        {
          taskId: z.string().optional().describe("Specific task ID to check (omit to list all)"),
        },
        async (args) => {
          if (!deps.taskSpawner) {
            return {
              content: [{ type: "text", text: "Task spawning not available in this context" }],
            };
          }

          const tasks = deps.taskSpawner.getTaskStatus(args.taskId, deps.conversationKey);
          return {
            content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
          };
        },
      ),
    ],
  });
}
