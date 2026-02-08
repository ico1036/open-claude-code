/**
 * In-process MCP server for the Agent SDK.
 *
 * Unlike mcp-server.ts (which runs over stdio/IPC for interactive Claude Code),
 * this server runs in the same process as the gateway daemon and is passed
 * directly to Agent SDK query() calls. No IPC overhead.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MessageRouter } from "./message-router.js";
import type { MessageStore } from "./message-store.js";
import type { MemoryManager } from "./memory-manager.js";

export type AgentMcpDeps = {
  messageRouter: MessageRouter;
  store: MessageStore;
  memoryManager: MemoryManager;
  dataDir: string;
  /** Per-conversation callbacks fired when send_message succeeds (key: "channel:to") */
  messageSentHandlers: Map<string, () => void>;
};

/** Valid persona file names that the agent can read/write */
const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "MEMORY.md"] as const;

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
          const result = await messageRouter.send(
            args.channel,
            { to: args.to, text: args.text, replyToId: args.replyToId },
            args.accountId ?? "default",
          );
          // Notify the reply tracker for this conversation
          if (result.success) {
            const handlerKey = `${args.channel}:${args.to}`;
            deps.messageSentHandlers.get(handlerKey)?.();
          }
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
        "Read a persona or memory file. Use this to check your current personality, identity, user info, or long-term memory. Valid files: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, MEMORY.md",
        {
          file: z.string().describe("File name to read: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, or MEMORY.md"),
        },
        async (args) => {
          if (!PERSONA_FILES.includes(args.file as typeof PERSONA_FILES[number])) {
            return {
              content: [{ type: "text", text: `Invalid file. Must be one of: ${PERSONA_FILES.join(", ")}` }],
            };
          }
          const filePath = join(dataDir, args.file);
          if (!existsSync(filePath)) {
            return {
              content: [{ type: "text", text: `File ${args.file} does not exist yet. Use write_persona to create it.` }],
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
        "Write or update a persona or memory file. Use this to save user preferences, update your identity/personality, or store important facts in long-term memory. The content will take effect from the next conversation turn. Valid files: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, MEMORY.md",
        {
          file: z.string().describe("File name to write: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, or MEMORY.md"),
          content: z.string().describe("Full content to write to the file (replaces existing content)"),
        },
        async (args) => {
          if (!PERSONA_FILES.includes(args.file as typeof PERSONA_FILES[number])) {
            return {
              content: [{ type: "text", text: `Invalid file. Must be one of: ${PERSONA_FILES.join(", ")}` }],
            };
          }
          const filePath = join(dataDir, args.file);
          writeFileSync(filePath, args.content, "utf-8");
          return {
            content: [{ type: "text", text: `Successfully updated ${args.file}` }],
          };
        },
      ),
    ],
  });
}
