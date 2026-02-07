#!/usr/bin/env node

import { serve } from "@hono/node-server";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDir, getPidFile, getDataDir, setChannelConfig } from "./config.js";
import { IpcServer, type IpcHandler } from "./daemon-ipc.js";
import { MessageStore } from "./message-store.js";
import { ChannelManager } from "./channel-manager.js";
import { MessageRouter } from "./message-router.js";
import { createHttpApp } from "./gateway-http.js";
import { AgentRunner } from "./agent-runner.js";
import { MemoryManager } from "./memory-manager.js";
import type { ChannelMessage, ChannelAccountSnapshot } from "@open-claude-code/adapter-core";

// --- Daemon Entry Point ---

async function main() {
  ensureDataDir();

  const config = loadConfig();
  const port = config.gateway.port;
  const host = config.gateway.host;

  console.log(`[gateway] Starting OpenClaudeCode Gateway Daemon...`);
  console.log(`[gateway] Data dir: ${getDataDir()}`);
  console.log(`[gateway] HTTP: ${host}:${port}`);

  // Write PID file
  writePidFile();

  // Initialize core services
  const store = new MessageStore();

  // Initialize memory manager (shares DB with message store so auto-responder
  // and MCP tool search the same index)
  const memoryManager = new MemoryManager(store.getDb());
  memoryManager.ensureSchema();
  console.log(`[gateway] Memory manager initialized (shared DB with message store)`);

  // Initialize agent runner (replaces legacy auto-responder)
  const agentRunnerConfig = config.gateway.agentRunner;
  const agentRunner = new AgentRunner(store, memoryManager, {
    enabled: agentRunnerConfig.enabled,
    model: agentRunnerConfig.model,
    maxConcurrent: agentRunnerConfig.maxConcurrent,
    debounceMs: agentRunnerConfig.debounceMs,
    maxTurns: agentRunnerConfig.maxTurns,
    maxBudgetPerMessage: agentRunnerConfig.maxBudgetPerMessage,
    systemPrompt: agentRunnerConfig.systemPrompt,
    personaFile: agentRunnerConfig.personaFile,
  });

  console.log(`[gateway] Agent runner: ${agentRunnerConfig.enabled ? "enabled" : "disabled"} (model: ${agentRunnerConfig.model})`);

  const channelManager = new ChannelManager(store, {
    onMessage: (msg: ChannelMessage) => {
      console.log(`[gateway] Message from ${msg.channel}/${msg.from.id}: ${msg.text?.slice(0, 50) ?? "(media)"}`);

      // Auto-respond via Agent SDK
      agentRunner.handleMessage(msg);

      // Notify IPC clients
      ipcServer.broadcast({
        jsonrpc: "2.0",
        method: "notification.message",
        params: {
          channel: msg.channel,
          from: msg.from,
          text: msg.text?.slice(0, 200),
          timestamp: msg.timestamp,
        },
      });
    },
    onStatusChange: (snapshot: ChannelAccountSnapshot) => {
      console.log(
        `[gateway] Channel ${snapshot.channel}/${snapshot.accountId}: connected=${snapshot.connected} running=${snapshot.running}`,
      );
      ipcServer.broadcast({
        jsonrpc: "2.0",
        method: "notification.channel_status",
        params: snapshot as unknown as Record<string, unknown>,
      });
    },
  });

  const messageRouter = new MessageRouter(channelManager, store);

  // Wire agent runner with channel manager + message router for typing and MCP tools
  agentRunner.setDependencies(channelManager, messageRouter);

  // Try to load adapter packages dynamically
  await loadAdapters(channelManager);

  // Start IPC server
  const ipcHandler = createIpcHandler(channelManager, messageRouter, store, agentRunner, memoryManager);
  const ipcServer = new IpcServer(ipcHandler);
  await ipcServer.start();
  console.log(`[gateway] IPC server listening`);

  // Start HTTP server
  const httpApp = createHttpApp({ channelManager, messageRouter, store });
  const httpServer = serve({ fetch: httpApp.fetch, port, hostname: host }, () => {
    console.log(`[gateway] HTTP server listening on http://${host}:${port}`);
  });

  // Auto-start configured channels
  await autoStartChannels(channelManager);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[gateway] Received ${signal}, shutting down...`);
    await channelManager.stopAll();
    await ipcServer.stop();
    httpServer.close();
    store.close();
    removePidFile();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`[gateway] Gateway daemon ready`);
}

// --- IPC Method Handler ---

function createIpcHandler(
  channelManager: ChannelManager,
  messageRouter: MessageRouter,
  store: MessageStore,
  agentRunner: AgentRunner,
  memoryManager: MemoryManager,
): IpcHandler {
  return async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ping":
        return { pong: true, timestamp: Date.now() };

      case "gateway.status":
        return {
          status: "running",
          uptime: process.uptime(),
          pid: process.pid,
          channels: channelManager.getStatus(),
          registeredAdapters: channelManager.getRegisteredChannels(),
          agentRunner: agentRunner.getStatus(),
        };

      case "gateway.stop":
        setTimeout(() => process.exit(0), 100);
        return { status: "stopping" };

      case "channel.connect": {
        const { channel, accountId, config } = params as {
          channel: string;
          accountId?: string;
          config?: Record<string, unknown>;
        };
        if (!channel) throw new Error("channel is required");
        const snapshot = await channelManager.startChannel(
          channel,
          accountId ?? "default",
          config,
        );
        return snapshot;
      }

      case "channel.disconnect": {
        const { channel, accountId } = params as {
          channel: string;
          accountId?: string;
        };
        if (!channel) throw new Error("channel is required");
        await channelManager.stopChannel(channel, accountId);
        return { status: "disconnected" };
      }

      case "channel.status": {
        const { channel } = params as { channel?: string };
        return channelManager.getStatus(channel);
      }

      case "message.send": {
        const { channel, to, text, replyToId, accountId } = params as {
          channel: string;
          to: string;
          text: string;
          replyToId?: string;
          accountId?: string;
        };
        if (!channel || !to || !text) throw new Error("channel, to, and text are required");
        return messageRouter.send(channel, { to, text, replyToId }, accountId);
      }

      case "message.list": {
        const { channel, from, limit, since } = params as {
          channel?: string;
          from?: string;
          limit?: number;
          since?: number;
        };
        return messageRouter.listMessages({ channel, from, limit, since });
      }

      case "conversation.list": {
        const { channel, limit } = params as {
          channel?: string;
          limit?: number;
        };
        return messageRouter.listConversations({ channel, limit });
      }

      case "channel.configure": {
        const { channel, config: channelConfig } = params as {
          channel: string;
          config: Record<string, unknown>;
        };
        if (!channel) throw new Error("channel is required");
        return setChannelConfig(channel, channelConfig);
      }

      case "autoresponder.status":
        return agentRunner.getStatus();

      case "autoresponder.enable": {
        agentRunner.setEnabled(true);
        return { enabled: true };
      }

      case "autoresponder.disable": {
        agentRunner.setEnabled(false);
        return { enabled: false };
      }

      case "memory.search": {
        const { query, maxResults, sessionKey } = params as {
          query: string;
          maxResults?: number;
          sessionKey?: string;
        };
        if (!query) throw new Error("query is required");
        return memoryManager.search(query, { maxResults, sessionKey });
      }

      case "memory.stats":
        return memoryManager.getStats();

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  };
}

// --- Adapter Loading ---

async function loadAdapters(channelManager: ChannelManager): Promise<void> {
  // Resolve adapter paths relative to this file's location
  // At runtime: packages/gateway/dist/gateway-daemon.js
  // Adapters:   packages/adapter-*/dist/index.js
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const adapters = [
    { id: "telegram", relPath: join(__dirname, "..", "..", "adapter-telegram", "dist", "index.js") },
    { id: "whatsapp", relPath: join(__dirname, "..", "..", "adapter-whatsapp", "dist", "index.js") },
    { id: "discord", relPath: join(__dirname, "..", "..", "adapter-discord", "dist", "index.js") },
  ] as const;

  for (const { id, relPath } of adapters) {
    try {
      if (!existsSync(relPath)) {
        console.log(`[gateway] Adapter not built: ${id} (${relPath})`);
        continue;
      }
      const mod = await import(relPath);
      const AdapterClass = mod.default ?? mod[`${id.charAt(0).toUpperCase()}${id.slice(1)}Adapter`];
      if (AdapterClass) {
        channelManager.registerAdapter(id, () => new AdapterClass());
        console.log(`[gateway] Loaded adapter: ${id}`);
      }
    } catch (err) {
      console.log(`[gateway] Failed to load adapter ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// --- Auto-start Channels ---

async function autoStartChannels(channelManager: ChannelManager): Promise<void> {
  const config = loadConfig();
  for (const [channelId, channelConfig] of Object.entries(config.channels)) {
    if (channelConfig.enabled) {
      try {
        await channelManager.startChannel(channelId, channelConfig.accountId);
        console.log(`[gateway] Auto-started channel: ${channelId}`);
      } catch (err) {
        console.error(`[gateway] Failed to auto-start ${channelId}:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

// --- PID File ---

function writePidFile(): void {
  try {
    writeFileSync(getPidFile(), String(process.pid), "utf-8");
  } catch {
    // ignore
  }
}

function removePidFile(): void {
  try {
    if (existsSync(getPidFile())) {
      unlinkSync(getPidFile());
    }
  } catch {
    // ignore
  }
}

// Run
main().catch((err) => {
  console.error("[gateway] Fatal error:", err);
  removePidFile();
  process.exit(1);
});
