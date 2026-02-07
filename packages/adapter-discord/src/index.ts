import {
  Client,
  GatewayIntentBits,
  type Message as DiscordMessage,
  type TextChannel,
} from "discord.js";
import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelMeta,
  type ChannelCapabilities,
  type ChannelMessage,
  type OutboundMessage,
  type SendResult,
} from "@open-claude-code/adapter-core";

export class DiscordAdapter extends ChannelAdapter {
  readonly id = "discord";
  readonly meta: ChannelMeta = {
    id: "discord",
    label: "Discord",
    description: "Discord Bot via discord.js",
    icon: "discord",
  };
  readonly capabilities: ChannelCapabilities = {
    text: true,
    media: true,
    reactions: true,
    threads: true,
    edit: true,
    delete: true,
    polls: false,
    voice: false,
  };

  private client: Client | null = null;

  async start(config: ChannelConfig, signal: AbortSignal): Promise<void> {
    const token = config.botToken as string;
    if (!token) throw new Error("Discord botToken is required");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this._status = {
      ...this._status,
      channel: "discord",
      accountId: config.accountId,
      running: true,
    };

    // Ready event
    this.client.once("ready", (readyClient) => {
      this.updateStatus({
        connected: true,
        lastConnectedAt: Date.now(),
        name: readyClient.user.tag,
        lastError: null,
      });
      this.emit("connected", this.getStatus());
      console.log(`[discord] Bot ready as ${readyClient.user.tag}`);
    });

    // Message handler
    this.client.on("messageCreate", (discordMsg: DiscordMessage) => {
      // Ignore bot messages
      if (discordMsg.author.bot) return;

      const isDm = !discordMsg.guild;
      const chatType = isDm ? "dm" as const : (discordMsg.channel.isThread?.() ? "channel" as const : "group" as const);

      const msg: ChannelMessage = {
        id: discordMsg.id,
        channel: "discord",
        accountId: config.accountId,
        from: {
          id: discordMsg.author.id,
          name: discordMsg.member?.displayName ?? discordMsg.author.displayName,
          username: discordMsg.author.username,
        },
        to: {
          id: discordMsg.channelId,
          name: "name" in discordMsg.channel ? (discordMsg.channel as TextChannel).name : undefined,
        },
        chatType,
        text: discordMsg.content || undefined,
        replyToId: discordMsg.reference?.messageId ?? undefined,
        threadId: discordMsg.channel.isThread?.() ? discordMsg.channelId : undefined,
        timestamp: discordMsg.createdTimestamp,
        raw: {
          guildId: discordMsg.guildId,
          guildName: discordMsg.guild?.name,
        },
      };

      // Handle attachments
      if (discordMsg.attachments.size > 0) {
        msg.media = discordMsg.attachments.map((att) => ({
          type: att.contentType?.startsWith("image/") ? "image" as const :
                att.contentType?.startsWith("video/") ? "video" as const :
                att.contentType?.startsWith("audio/") ? "audio" as const :
                "document" as const,
          url: att.url,
          fileName: att.name ?? undefined,
          mimeType: att.contentType ?? undefined,
        }));
      }

      this.emit("message", msg);
    });

    // Error handling
    this.client.on("error", (err) => {
      this.emit("error", err, "client");
      this.updateStatus({ lastError: err.message });
    });

    // Disconnect handling
    this.client.on("shardDisconnect", () => {
      if (!signal.aborted) {
        this.updateStatus({ connected: false, lastDisconnectedAt: Date.now() });
        this.emit("disconnected", this.getStatus(), "shard disconnected");
      }
    });

    this.client.on("shardReconnecting", () => {
      console.log(`[discord] Reconnecting...`);
    });

    // Abort signal
    signal.addEventListener("abort", () => {
      this.client?.destroy();
    });

    // Login
    await this.client.login(token);
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && "sendTyping" in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // ignore
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.updateStatus({ running: false, connected: false, lastStopAt: Date.now() });
    this.emit("disconnected", this.getStatus(), "stopped");
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.client) {
      return { success: false, error: "Client not started", timestamp: Date.now() };
    }

    try {
      const channel = await this.client.channels.fetch(msg.to);
      if (!channel || !("send" in channel)) {
        return { success: false, error: `Channel ${msg.to} not found or not a text channel`, timestamp: Date.now() };
      }

      const textChannel = channel as TextChannel;

      const options: Record<string, unknown> = {};
      if (msg.replyToId) {
        options.reply = { messageId: msg.replyToId };
      }

      if (msg.text) {
        const result = await textChannel.send({ content: msg.text, ...options });
        return {
          success: true,
          messageId: result.id,
          timestamp: result.createdTimestamp,
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

export default DiscordAdapter;
