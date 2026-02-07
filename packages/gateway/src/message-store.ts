import Database from "better-sqlite3";
import { getDbPath, ensureDataDir } from "./config.js";
import type { ChannelMessage, ChannelAccountSnapshot } from "@open-claude-code/adapter-core";

export type StoredMessage = ChannelMessage & {
  storedAt: number;
};

export type Conversation = {
  channel: string;
  accountId: string;
  peerId: string;
  peerName?: string;
  chatType: string;
  lastMessageAt: number;
  lastMessageText?: string;
  messageCount: number;
  unreadCount: number;
};

export type ListMessagesFilter = {
  channel?: string;
  from?: string;
  to?: string;
  chatType?: string;
  since?: number;
  limit?: number;
};

export class MessageStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    ensureDataDir();
    this.db = new Database(dbPath ?? getDbPath());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'default',
        from_id TEXT NOT NULL,
        from_name TEXT,
        from_username TEXT,
        to_id TEXT,
        to_name TEXT,
        chat_type TEXT NOT NULL DEFAULT 'dm',
        text TEXT,
        media_json TEXT,
        reply_to_id TEXT,
        thread_id TEXT,
        timestamp INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        raw_json TEXT,
        read INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel, timestamp DESC);

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'default',
        name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        configured INTEGER NOT NULL DEFAULT 0,
        connected INTEGER NOT NULL DEFAULT 0,
        running INTEGER NOT NULL DEFAULT 0,
        last_connected_at INTEGER,
        last_disconnected_at INTEGER,
        last_message_at INTEGER,
        last_error TEXT,
        last_start_at INTEGER,
        last_stop_at INTEGER,
        config_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  storeMessage(msg: ChannelMessage): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, channel, account_id,
        from_id, from_name, from_username,
        to_id, to_name,
        chat_type, text, media_json,
        reply_to_id, thread_id,
        timestamp, stored_at, raw_json
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?
      )
    `);

    stmt.run(
      msg.id,
      msg.channel,
      msg.accountId,
      msg.from.id,
      msg.from.name ?? null,
      msg.from.username ?? null,
      msg.to?.id ?? null,
      msg.to?.name ?? null,
      msg.chatType,
      msg.text ?? null,
      msg.media ? JSON.stringify(msg.media) : null,
      msg.replyToId ?? null,
      msg.threadId ?? null,
      msg.timestamp,
      Date.now(),
      msg.raw ? JSON.stringify(msg.raw) : null,
    );
  }

  listMessages(filter: ListMessagesFilter = {}): StoredMessage[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.channel) {
      conditions.push("channel = ?");
      params.push(filter.channel);
    }
    if (filter.from) {
      conditions.push("from_id = ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("to_id = ?");
      params.push(filter.to);
    }
    if (filter.chatType) {
      conditions.push("chat_type = ?");
      params.push(filter.chatType);
    }
    if (filter.since) {
      conditions.push("timestamp > ?");
      params.push(filter.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 20;

    const rows = this.db
      .prepare(
        `SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map(rowToMessage);
  }

  listConversations(filter: { channel?: string; limit?: number } = {}): Conversation[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.channel) {
      conditions.push("channel = ?");
      params.push(filter.channel);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 20;

    const rows = this.db
      .prepare(
        `SELECT
          channel,
          account_id,
          from_id as peer_id,
          from_name as peer_name,
          chat_type,
          MAX(timestamp) as last_message_at,
          text as last_message_text,
          COUNT(*) as message_count,
          SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread_count
        FROM messages
        ${where}
        GROUP BY channel, from_id
        ORDER BY last_message_at DESC
        LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      channel: row.channel as string,
      accountId: row.account_id as string,
      peerId: row.peer_id as string,
      peerName: row.peer_name as string | undefined,
      chatType: row.chat_type as string,
      lastMessageAt: row.last_message_at as number,
      lastMessageText: row.last_message_text as string | undefined,
      messageCount: row.message_count as number,
      unreadCount: row.unread_count as number,
    }));
  }

  markRead(messageIds: string[]): void {
    const stmt = this.db.prepare("UPDATE messages SET read = 1 WHERE id = ?");
    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(id);
      }
    });
    transaction(messageIds);
  }

  // Channel status persistence
  saveChannelStatus(snapshot: ChannelAccountSnapshot): void {
    const key = `${snapshot.channel}:${snapshot.accountId}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO channels (
          id, channel, account_id, name, enabled, configured, connected, running,
          last_connected_at, last_disconnected_at, last_message_at, last_error,
          last_start_at, last_stop_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        snapshot.channel,
        snapshot.accountId,
        snapshot.name ?? null,
        snapshot.enabled ? 1 : 0,
        snapshot.configured ? 1 : 0,
        snapshot.connected ? 1 : 0,
        snapshot.running ? 1 : 0,
        snapshot.lastConnectedAt ?? null,
        snapshot.lastDisconnectedAt ?? null,
        snapshot.lastMessageAt ?? null,
        snapshot.lastError ?? null,
        snapshot.lastStartAt ?? null,
        snapshot.lastStopAt ?? null,
        Date.now(),
      );
  }

  getChannelStatuses(): ChannelAccountSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM channels ORDER BY channel, account_id")
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      accountId: row.account_id as string,
      channel: row.channel as string,
      name: row.name as string | undefined,
      enabled: row.enabled === 1,
      configured: row.configured === 1,
      connected: row.connected === 1,
      running: row.running === 1,
      lastConnectedAt: row.last_connected_at as number | null,
      lastDisconnectedAt: row.last_disconnected_at as number | null,
      lastMessageAt: row.last_message_at as number | null,
      lastError: row.last_error as string | null,
      lastStartAt: row.last_start_at as number | null,
      lastStopAt: row.last_stop_at as number | null,
    }));
  }

  /** Expose the underlying database for shared use (e.g., MemoryManager FTS tables) */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    channel: row.channel as string,
    accountId: row.account_id as string,
    from: {
      id: row.from_id as string,
      name: row.from_name as string | undefined,
      username: row.from_username as string | undefined,
    },
    to: row.to_id
      ? { id: row.to_id as string, name: row.to_name as string | undefined }
      : undefined,
    chatType: (row.chat_type as string) as "dm" | "group" | "channel",
    text: row.text as string | undefined,
    media: row.media_json ? JSON.parse(row.media_json as string) : undefined,
    replyToId: row.reply_to_id as string | undefined,
    threadId: row.thread_id as string | undefined,
    timestamp: row.timestamp as number,
    storedAt: row.stored_at as number,
    raw: row.raw_json ? JSON.parse(row.raw_json as string) : undefined,
  };
}
