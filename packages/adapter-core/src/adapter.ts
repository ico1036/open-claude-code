import type { ChannelAccountSnapshot, ChannelCapabilities, ChannelConfig, ChannelMeta, OutboundMessage, SendResult } from "./types.js";
import { TypedEventEmitter } from "./events.js";

export abstract class ChannelAdapter extends TypedEventEmitter {
  abstract readonly id: string;
  abstract readonly meta: ChannelMeta;
  abstract readonly capabilities: ChannelCapabilities;

  protected _status: ChannelAccountSnapshot;

  constructor() {
    super();
    this._status = {
      accountId: "default",
      channel: "unknown",
      running: false,
      connected: false,
    };
  }

  abstract start(config: ChannelConfig, signal: AbortSignal): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(msg: OutboundMessage): Promise<SendResult>;

  /** Send a typing indicator to the chat. Override in adapters that support it. */
  async sendTyping(_chatId: string): Promise<void> {
    // no-op by default
  }

  getStatus(): ChannelAccountSnapshot {
    return { ...this._status };
  }

  protected updateStatus(patch: Partial<ChannelAccountSnapshot>): void {
    this._status = { ...this._status, ...patch };
    this.emit("status", this._status);
  }
}
