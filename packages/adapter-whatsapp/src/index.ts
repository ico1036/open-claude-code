import baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
type WASocket = ReturnType<typeof makeWASocket>;
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import {
  ChannelAdapter,
  type ChannelConfig,
  type ChannelMeta,
  type ChannelCapabilities,
  type ChannelMessage,
  type OutboundMessage,
  type SendResult,
} from "@open-claude-code/adapter-core";

const AUTH_DIR = join(homedir(), ".openclaudecode", "whatsapp-auth");

export class WhatsAppAdapter extends ChannelAdapter {
  readonly id = "whatsapp";
  readonly meta: ChannelMeta = {
    id: "whatsapp",
    label: "WhatsApp",
    description: "WhatsApp Web via Baileys",
    icon: "whatsapp",
  };
  readonly capabilities: ChannelCapabilities = {
    text: true,
    media: true,
    reactions: true,
    threads: false,
    edit: false,
    delete: true,
    polls: true,
    voice: false,
  };

  private socket: WASocket | null = null;
  private abortSignal: AbortSignal | null = null;

  async start(config: ChannelConfig, signal: AbortSignal): Promise<void> {
    this.abortSignal = signal;

    const authDir = join(AUTH_DIR, config.accountId ?? "default");
    mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this._status = {
      ...this._status,
      channel: "whatsapp",
      accountId: config.accountId,
      running: true,
    };

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    this.socket = sock;

    // Save creds on update
    sock.ev.on("creds.update", saveCreds);

    // Connection updates
    sock.ev.on("connection.update", (update: { connection?: string; lastDisconnect?: { error?: Error & { output?: { statusCode?: number } } }; qr?: string }) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Emit QR code for pairing
        this.emit("qr", qr);
        console.log(`[whatsapp] QR code generated for pairing`);
      }

      if (connection === "open") {
        this.updateStatus({
          connected: true,
          lastConnectedAt: Date.now(),
          lastError: null,
        });
        this.emit("connected", this.getStatus());
        console.log(`[whatsapp] Connected`);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.updateStatus({
          connected: false,
          lastDisconnectedAt: Date.now(),
          lastError: lastDisconnect?.error?.message ?? "disconnected",
        });

        if (shouldReconnect && !signal.aborted) {
          console.log(`[whatsapp] Reconnecting...`);
          // Reconnect after a delay
          setTimeout(() => {
            if (!signal.aborted) {
              this.start(config, signal).catch((err) => {
                this.emit("error", err instanceof Error ? err : new Error(String(err)), "reconnect");
              });
            }
          }, 3000);
        } else {
          this.emit("disconnected", this.getStatus(), "logged out or stopped");
        }
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }: { messages: Array<Record<string, any>>; type: string }) => {
      if (type !== "notify") return;

      for (const waMsg of messages) {
        if (!waMsg.message || waMsg.key.fromMe) continue;

        const jid = waMsg.key.remoteJid;
        if (!jid) continue;

        const isGroup = jid.endsWith("@g.us");
        const senderId = waMsg.key.participant ?? jid;
        const senderName = waMsg.pushName ?? undefined;

        // Extract text
        const text =
          waMsg.message.conversation ??
          waMsg.message.extendedTextMessage?.text ??
          waMsg.message.imageMessage?.caption ??
          waMsg.message.videoMessage?.caption ??
          undefined;

        const msg: ChannelMessage = {
          id: waMsg.key.id ?? `wa_${Date.now()}`,
          channel: "whatsapp",
          accountId: config.accountId,
          from: {
            id: senderId.replace(/@s\.whatsapp\.net$/, ""),
            name: senderName,
          },
          to: isGroup ? {
            id: jid,
            name: undefined, // Would need to resolve group metadata
          } : undefined,
          chatType: isGroup ? "group" : "dm",
          text,
          timestamp: (waMsg.messageTimestamp as number) * 1000,
          raw: waMsg,
        };

        // Handle media
        if (waMsg.message.imageMessage) {
          msg.media = [{
            type: "image",
            mimeType: waMsg.message.imageMessage.mimetype ?? "image/jpeg",
            caption: waMsg.message.imageMessage.caption ?? undefined,
          }];
        }
        if (waMsg.message.documentMessage) {
          msg.media = [{
            type: "document",
            fileName: waMsg.message.documentMessage.fileName ?? undefined,
            mimeType: waMsg.message.documentMessage.mimetype ?? undefined,
          }];
        }
        if (waMsg.message.audioMessage) {
          msg.media = [{
            type: "audio",
            mimeType: waMsg.message.audioMessage.mimetype ?? "audio/ogg",
          }];
        }

        if (waMsg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
          msg.replyToId = waMsg.message.extendedTextMessage.contextInfo.stanzaId ?? undefined;
        }

        this.emit("message", msg);
      }
    });

    // Abort handling
    signal.addEventListener("abort", () => {
      sock.end(undefined);
    });
  }

  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.updateStatus({ running: false, connected: false, lastStopAt: Date.now() });
    this.emit("disconnected", this.getStatus(), "stopped");
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.socket) {
      return { success: false, error: "Socket not connected", timestamp: Date.now() };
    }

    try {
      // Normalize JID - add @s.whatsapp.net if not present
      let jid = msg.to;
      if (!jid.includes("@")) {
        jid = `${jid}@s.whatsapp.net`;
      }

      if (msg.text) {
        const result = await this.socket.sendMessage(jid, {
          text: msg.text,
        });

        return {
          success: true,
          messageId: result?.key?.id ?? undefined,
          timestamp: Date.now(),
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

export default WhatsAppAdapter;
