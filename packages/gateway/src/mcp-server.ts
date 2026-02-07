import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { IpcClient, isDaemonRunning } from "./daemon-ipc.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function getDaemonScript(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "gateway-daemon.js");
}

export function createMcpServer() {
  let ipcClient: IpcClient | null = null;

  async function ensureClient(): Promise<IpcClient> {
    if (ipcClient?.isConnected) return ipcClient;

    ipcClient = new IpcClient({
      onNotification: (method, params) => {
        if (method === "notification.message") {
          const p = params as Record<string, unknown>;
          console.error(`[mcp] New message: ${p.channel}/${JSON.stringify(p.from)}`);
        }
      },
    });

    try {
      await ipcClient.connect();
      return ipcClient;
    } catch {
      ipcClient = null;
      throw new Error("Gateway daemon is not running. Use gateway_start to start it.");
    }
  }

  async function callDaemon(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const client = await ensureClient();
    return client.call(method, params);
  }

  async function startDaemon(): Promise<{ status: string; message: string }> {
    const running = await isDaemonRunning();
    if (running) {
      return { status: "already_running", message: "Gateway daemon is already running" };
    }

    const daemonScript = getDaemonScript();
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    // Wait for daemon to start
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const nowRunning = await isDaemonRunning();
    if (nowRunning) {
      return { status: "started", message: "Gateway daemon started successfully" };
    }

    return { status: "error", message: "Failed to start gateway daemon. Check logs." };
  }

  const server = new Server(
    { name: "open-claude-code", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "gateway_status",
        description: "Check the status of the OpenClaudeCode gateway daemon. Returns running state, uptime, and connected channels.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "gateway_start",
        description: "Start the OpenClaudeCode gateway daemon as a background process. The daemon manages messaging channel connections and persists messages.",
        inputSchema: {
          type: "object" as const,
          properties: {
            port: { type: "number", description: "HTTP port for the dashboard (default: 19280)" },
          },
        },
      },
      {
        name: "channel_connect",
        description: "Connect a messaging channel to the gateway. Requires channel type and config (e.g., botToken for Telegram).",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Channel type: whatsapp, telegram, or discord", enum: ["whatsapp", "telegram", "discord"] },
            config: { type: "object", description: "Channel-specific configuration. For telegram: { botToken: '...' }. For discord: { botToken: '...' }. For whatsapp: {}." },
            accountId: { type: "string", description: "Account identifier (default: 'default')" },
          },
          required: ["channel"],
        },
      },
      {
        name: "channel_disconnect",
        description: "Disconnect a messaging channel from the gateway.",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Channel to disconnect", enum: ["whatsapp", "telegram", "discord"] },
            accountId: { type: "string", description: "Specific account ID (optional)" },
          },
          required: ["channel"],
        },
      },
      {
        name: "channel_status",
        description: "Get the status of all connected channels or a specific channel. Shows connection state, last activity, errors.",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Specific channel to check (optional, checks all if omitted)" },
          },
        },
      },
      {
        name: "send_message",
        description: "Send a message to a specific recipient on a connected channel.",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Channel to send through", enum: ["whatsapp", "telegram", "discord"] },
            to: { type: "string", description: "Recipient identifier (phone number, chat ID, channel ID)" },
            text: { type: "string", description: "Message text to send" },
            replyToId: { type: "string", description: "Message ID to reply to (optional)" },
            accountId: { type: "string", description: "Account ID to use (optional)" },
          },
          required: ["channel", "to", "text"],
        },
      },
      {
        name: "list_messages",
        description: "List recent messages received by the gateway, optionally filtered by channel, sender, or time range.",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Filter by channel" },
            from: { type: "string", description: "Filter by sender ID" },
            limit: { type: "number", description: "Max messages to return (default: 20)" },
            since: { type: "number", description: "Only messages after this Unix timestamp" },
          },
        },
      },
      {
        name: "list_conversations",
        description: "List active conversations across all connected channels. Groups messages by sender.",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Filter by channel" },
            limit: { type: "number", description: "Max conversations (default: 20)" },
          },
        },
      },
      {
        name: "configure_channel",
        description: "Update configuration for a connected channel (e.g., allowlist, auto-reply settings). Set autoReply=true to enable automatic Claude responses for this channel.",
        inputSchema: {
          type: "object" as const,
          properties: {
            channel: { type: "string", description: "Channel to configure", enum: ["whatsapp", "telegram", "discord"] },
            config: { type: "object", description: "Configuration key-value pairs. Set autoReply: true to enable auto-response, allowFrom: ['user1','user2'] to restrict." },
          },
          required: ["channel", "config"],
        },
      },
      {
        name: "auto_responder_status",
        description: "Get the status of the auto-responder (active sessions, queue, enabled state).",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "auto_responder_toggle",
        description: "Enable or disable the auto-responder globally.",
        inputSchema: {
          type: "object" as const,
          properties: {
            enabled: { type: "boolean", description: "true to enable, false to disable" },
          },
          required: ["enabled"],
        },
      },
      {
        name: "memory_search",
        description: "Search past conversation memories using full-text search. Returns relevant snippets from previous conversations ranked by relevance.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search query - keywords to find in past conversations" },
            maxResults: { type: "number", description: "Maximum number of results to return (default: 10)" },
            sessionKey: { type: "string", description: "Filter by session key, e.g. 'telegram:12345' (optional)" },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_stats",
        description: "Get statistics about the memory index - total indexed chunks and distinct sessions.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "gateway_status": {
          try {
            const result = await callDaemon("gateway.status");
            return jsonResult(result);
          } catch {
            return jsonResult({
              status: "not_running",
              message: "Gateway daemon is not running. Use gateway_start to start it.",
            });
          }
        }

        case "gateway_start":
          return jsonResult(await startDaemon());

        case "channel_connect":
          return jsonResult(
            await callDaemon("channel.connect", {
              channel: params.channel,
              accountId: params.accountId,
              config: params.config,
            }),
          );

        case "channel_disconnect":
          return jsonResult(
            await callDaemon("channel.disconnect", {
              channel: params.channel,
              accountId: params.accountId,
            }),
          );

        case "channel_status":
          return jsonResult(await callDaemon("channel.status", { channel: params.channel }));

        case "send_message":
          return jsonResult(
            await callDaemon("message.send", {
              channel: params.channel,
              to: params.to,
              text: params.text,
              replyToId: params.replyToId,
              accountId: params.accountId,
            }),
          );

        case "list_messages":
          return jsonResult(
            await callDaemon("message.list", {
              channel: params.channel,
              from: params.from,
              limit: params.limit,
              since: params.since,
            }),
          );

        case "list_conversations":
          return jsonResult(
            await callDaemon("conversation.list", {
              channel: params.channel,
              limit: params.limit,
            }),
          );

        case "configure_channel":
          return jsonResult(
            await callDaemon("channel.configure", {
              channel: params.channel,
              config: params.config,
            }),
          );

        case "auto_responder_status":
          return jsonResult(await callDaemon("autoresponder.status"));

        case "auto_responder_toggle":
          return jsonResult(
            await callDaemon(
              params.enabled ? "autoresponder.enable" : "autoresponder.disable",
            ),
          );

        case "memory_search":
          return jsonResult(
            await callDaemon("memory.search", {
              query: params.query,
              maxResults: params.maxResults,
              sessionKey: params.sessionKey,
            }),
          );

        case "memory_stats":
          return jsonResult(await callDaemon("memory.stats"));

        default:
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
