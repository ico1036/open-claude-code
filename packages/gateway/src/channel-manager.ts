import type {
  ChannelAdapter,
  ChannelAccountSnapshot,
  ChannelConfig,
  ChannelMessage,
  ChannelId,
} from "@open-claude-code/adapter-core";
import { MessageStore } from "./message-store.js";
import { loadConfig, setChannelConfig } from "./config.js";

export type ChannelRegistration = {
  id: ChannelId;
  factory: () => ChannelAdapter;
};

export type ChannelRuntime = {
  adapter: ChannelAdapter;
  abortController: AbortController;
  status: ChannelAccountSnapshot;
};

export type ChannelManagerEvents = {
  onMessage?: (msg: ChannelMessage) => void;
  onStatusChange?: (snapshot: ChannelAccountSnapshot) => void;
};

export class ChannelManager {
  private registry = new Map<ChannelId, ChannelRegistration>();
  private runtimes = new Map<string, ChannelRuntime>();
  private store: MessageStore;
  private events: ChannelManagerEvents;

  constructor(store: MessageStore, events: ChannelManagerEvents = {}) {
    this.store = store;
    this.events = events;
  }

  // Register an adapter factory for a channel type
  registerAdapter(id: ChannelId, factory: () => ChannelAdapter): void {
    this.registry.set(id, { id, factory });
  }

  // Start a specific channel with given config
  async startChannel(
    channelId: ChannelId,
    accountId: string = "default",
    config?: Partial<ChannelConfig>,
  ): Promise<ChannelAccountSnapshot> {
    const key = `${channelId}:${accountId}`;

    // Stop existing instance if any
    if (this.runtimes.has(key)) {
      await this.stopChannel(channelId, accountId);
    }

    const registration = this.registry.get(channelId);
    if (!registration) {
      throw new Error(`Unknown channel: ${channelId}`);
    }

    // Save config if provided
    if (config) {
      setChannelConfig(channelId, { ...config, accountId });
    }

    // Load channel config
    const appConfig = loadConfig();
    const channelConfig = appConfig.channels[channelId];
    if (!channelConfig) {
      throw new Error(`Channel ${channelId} is not configured. Provide config first.`);
    }

    const adapter = registration.factory();
    const abortController = new AbortController();

    const runtime: ChannelRuntime = {
      adapter,
      abortController,
      status: {
        accountId,
        channel: channelId,
        running: true,
        connected: false,
        lastStartAt: Date.now(),
      },
    };

    // Wire up events
    adapter.on("message", (msg: ChannelMessage) => {
      this.store.storeMessage(msg);
      this.events.onMessage?.(msg);
    });

    adapter.on("connected", (snapshot: ChannelAccountSnapshot) => {
      runtime.status = {
        ...runtime.status,
        ...snapshot,
        connected: true,
        lastConnectedAt: Date.now(),
      };
      this.store.saveChannelStatus(runtime.status);
      this.events.onStatusChange?.(runtime.status);
    });

    adapter.on("disconnected", (snapshot: ChannelAccountSnapshot, reason?: string) => {
      runtime.status = {
        ...runtime.status,
        ...snapshot,
        connected: false,
        lastDisconnectedAt: Date.now(),
        lastError: reason ?? null,
      };
      this.store.saveChannelStatus(runtime.status);
      this.events.onStatusChange?.(runtime.status);
    });

    adapter.on("error", (error: Error, context?: string) => {
      runtime.status = {
        ...runtime.status,
        lastError: `${context ? context + ": " : ""}${error.message}`,
      };
      this.store.saveChannelStatus(runtime.status);
      this.events.onStatusChange?.(runtime.status);
    });

    adapter.on("status", (snapshot: ChannelAccountSnapshot) => {
      runtime.status = { ...runtime.status, ...snapshot };
      this.store.saveChannelStatus(runtime.status);
      this.events.onStatusChange?.(runtime.status);
    });

    this.runtimes.set(key, runtime);

    try {
      await adapter.start(channelConfig, abortController.signal);
      runtime.status.configured = true;
      this.store.saveChannelStatus(runtime.status);
    } catch (err) {
      runtime.status = {
        ...runtime.status,
        running: false,
        lastError: err instanceof Error ? err.message : String(err),
        lastStopAt: Date.now(),
      };
      this.store.saveChannelStatus(runtime.status);
      this.runtimes.delete(key);
      throw err;
    }

    return runtime.status;
  }

  async stopChannel(channelId: ChannelId, accountId: string = "default"): Promise<void> {
    const key = `${channelId}:${accountId}`;
    const runtime = this.runtimes.get(key);
    if (!runtime) return;

    runtime.abortController.abort();

    try {
      await runtime.adapter.stop();
    } catch {
      // best effort
    }

    runtime.status = {
      ...runtime.status,
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    };
    this.store.saveChannelStatus(runtime.status);
    this.events.onStatusChange?.(runtime.status);
    this.runtimes.delete(key);
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.runtimes.entries()).map(([key]) => {
      const [channelId, accountId] = key.split(":");
      return this.stopChannel(channelId, accountId);
    });
    await Promise.allSettled(stops);
  }

  getStatus(channelId?: ChannelId): ChannelAccountSnapshot[] {
    if (channelId) {
      const results: ChannelAccountSnapshot[] = [];
      for (const [key, runtime] of this.runtimes) {
        if (key.startsWith(`${channelId}:`)) {
          results.push({ ...runtime.status });
        }
      }
      // Also check persisted statuses for non-running channels
      if (results.length === 0) {
        const persisted = this.store.getChannelStatuses();
        return persisted.filter((s) => s.channel === channelId);
      }
      return results;
    }

    // All channels - combine running + persisted
    const running = new Map<string, ChannelAccountSnapshot>();
    for (const [key, runtime] of this.runtimes) {
      running.set(key, { ...runtime.status });
    }

    const persisted = this.store.getChannelStatuses();
    for (const status of persisted) {
      const key = `${status.channel}:${status.accountId}`;
      if (!running.has(key)) {
        running.set(key, status);
      }
    }

    return Array.from(running.values());
  }

  getRuntime(channelId: ChannelId, accountId: string = "default"): ChannelRuntime | undefined {
    return this.runtimes.get(`${channelId}:${accountId}`);
  }

  getRegisteredChannels(): ChannelId[] {
    return Array.from(this.registry.keys());
  }

  isRunning(channelId: ChannelId, accountId: string = "default"): boolean {
    return this.runtimes.has(`${channelId}:${accountId}`);
  }

  async sendTyping(channelId: ChannelId, chatId: string, accountId: string = "default"): Promise<void> {
    const runtime = this.runtimes.get(`${channelId}:${accountId}`);
    if (runtime) {
      await runtime.adapter.sendTyping(chatId);
    }
  }
}
