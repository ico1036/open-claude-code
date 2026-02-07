import { EventEmitter } from "node:events";
import type { ChannelMessage, ChannelAccountSnapshot } from "./types.js";

export type AdapterEvents = {
  message: [msg: ChannelMessage];
  connected: [snapshot: ChannelAccountSnapshot];
  disconnected: [snapshot: ChannelAccountSnapshot, reason?: string];
  error: [error: Error, context?: string];
  qr: [dataUrl: string];
  status: [snapshot: ChannelAccountSnapshot];
};

export class TypedEventEmitter extends EventEmitter {
  override emit<K extends keyof AdapterEvents>(event: K, ...args: AdapterEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AdapterEvents>(event: K, listener: (...args: AdapterEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof AdapterEvents>(event: K, listener: (...args: AdapterEvents[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof AdapterEvents>(event: K, listener: (...args: AdapterEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}
