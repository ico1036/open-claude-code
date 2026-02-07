import { Bot, type Context } from "grammy";
import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelMeta,
  type ChannelCapabilities,
  type ChannelMessage,
  type OutboundMessage,
  type SendResult,
} from "@open-claude-code/adapter-core";

export class TelegramAdapter extends ChannelAdapter {
  readonly id = "telegram";
  readonly meta: ChannelMeta = {
    id: "telegram",
    label: "Telegram",
    description: "Telegram Bot API via grammY",
    icon: "telegram",
  };
  readonly capabilities: ChannelCapabilities = {
    text: true,
    media: true,
    reactions: true,
    threads: true,
    edit: true,
    delete: true,
    polls: true,
    voice: false,
  };

  private bot: Bot | null = null;

  async start(config: ChannelConfig, signal: AbortSignal): Promise<void> {
    const token = config.botToken as string;
    if (!token) throw new Error("Telegram botToken is required");

    this.bot = new Bot(token);

    this._status = {
      ...this._status,
      channel: "telegram",
      accountId: config.accountId,
      running: true,
    };

    // Handle incoming messages
    this.bot.on("message", (ctx: Context) => {
      if (!ctx.message) return;

      const msg: ChannelMessage = {
        id: String(ctx.message.message_id),
        channel: "telegram",
        accountId: config.accountId,
        from: {
          id: String(ctx.message.from?.id ?? "unknown"),
          name: [ctx.message.from?.first_name, ctx.message.from?.last_name].filter(Boolean).join(" ") || undefined,
          username: ctx.message.from?.username,
        },
        to: ctx.message.chat ? {
          id: String(ctx.message.chat.id),
          name: "title" in ctx.message.chat ? ctx.message.chat.title : undefined,
        } : undefined,
        chatType: ctx.message.chat.type === "private" ? "dm" : "group",
        text: ctx.message.text ?? ctx.message.caption,
        replyToId: ctx.message.reply_to_message ? String(ctx.message.reply_to_message.message_id) : undefined,
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
      };

      // Handle media
      if (ctx.message.photo) {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        msg.media = [{
          type: "image",
          mimeType: "image/jpeg",
          caption: ctx.message.caption,
        }];
      }
      if (ctx.message.document) {
        msg.media = [{
          type: "document",
          fileName: ctx.message.document.file_name,
          mimeType: ctx.message.document.mime_type,
          caption: ctx.message.caption,
        }];
      }
      if (ctx.message.voice) {
        msg.media = [{
          type: "audio",
          mimeType: ctx.message.voice.mime_type ?? "audio/ogg",
        }];
      }

      this.emit("message", msg);
    });

    // Handle abort signal
    signal.addEventListener("abort", () => {
      this.bot?.stop();
    });

    // Emit connected once bot info is fetched
    try {
      const botInfo = await this.bot.api.getMe();
      this.updateStatus({
        connected: true,
        lastConnectedAt: Date.now(),
        name: botInfo.username,
      });
      this.emit("connected", this.getStatus());
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)), "getMe");
    }

    // Start polling (long-running)
    this.bot.start({
      onStart: () => {
        console.log(`[telegram] Bot started polling`);
      },
    }).catch((err) => {
      if (!signal.aborted) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)), "polling");
        this.updateStatus({ connected: false, lastError: err instanceof Error ? err.message : String(err) });
        this.emit("disconnected", this.getStatus(), err instanceof Error ? err.message : String(err));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this.updateStatus({ running: false, connected: false, lastStopAt: Date.now() });
    this.emit("disconnected", this.getStatus(), "stopped");
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch {
      // ignore typing errors
    }
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.bot) {
      return { success: false, error: "Bot not started", timestamp: Date.now() };
    }

    try {
      const chatId = msg.to;

      if (msg.text) {
        const params: Record<string, unknown> = {};
        if (msg.replyToId) {
          params.reply_parameters = { message_id: parseInt(msg.replyToId, 10) };
        }

        const result = await this.bot.api.sendMessage(chatId, msg.text, params);
        return {
          success: true,
          messageId: String(result.message_id),
          timestamp: result.date * 1000,
        };
      }

      return { success: false, error: "No content to send", timestamp: Date.now() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
    }
  }
}

export default TelegramAdapter;
