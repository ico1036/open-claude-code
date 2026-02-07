import type {
  ChannelMessage,
  OutboundMessage,
  SendResult,
  ChannelId,
} from "@open-claude-code/adapter-core";
import type { ChannelManager } from "./channel-manager.js";
import type { MessageStore } from "./message-store.js";

export class MessageRouter {
  private channelManager: ChannelManager;
  private store: MessageStore;

  constructor(channelManager: ChannelManager, store: MessageStore) {
    this.channelManager = channelManager;
    this.store = store;
  }

  // Send a message through a specific channel
  async send(
    channelId: ChannelId,
    message: OutboundMessage,
    accountId: string = "default",
  ): Promise<SendResult> {
    const runtime = this.channelManager.getRuntime(channelId, accountId);

    if (!runtime) {
      return {
        success: false,
        error: `Channel ${channelId} (account: ${accountId}) is not running`,
        timestamp: Date.now(),
      };
    }

    if (!runtime.status.connected) {
      return {
        success: false,
        error: `Channel ${channelId} (account: ${accountId}) is not connected`,
        timestamp: Date.now(),
      };
    }

    try {
      const result = await runtime.adapter.send(message);

      // Store outbound message for history
      if (result.success) {
        const outboundRecord: ChannelMessage = {
          id: result.messageId ?? `out_${Date.now()}`,
          channel: channelId,
          accountId,
          from: { id: "_self" },
          to: { id: message.to },
          chatType: "dm",
          text: message.text,
          media: message.media,
          replyToId: message.replyToId,
          threadId: message.threadId,
          timestamp: result.timestamp,
        };
        this.store.storeMessage(outboundRecord);
      }

      return result;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
    }
  }

  // List messages with filtering
  listMessages(filter: {
    channel?: string;
    from?: string;
    limit?: number;
    since?: number;
  } = {}) {
    return this.store.listMessages(filter);
  }

  // List conversations
  listConversations(filter: {
    channel?: string;
    limit?: number;
  } = {}) {
    return this.store.listConversations(filter);
  }
}
