import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

export interface MemorySearchResult {
  sessionKey: string;
  snippet: string;
  score: number;
  timestamp: number;
  source: "session" | "memory";
}

export interface MemoryChunk {
  id: string;
  sessionKey: string;
  text: string;
  source: "session" | "memory";
  timestamp: number;
}

export class MemoryManager {
  private db: Database.Database;
  private schemaReady = false;

  constructor(
    db: Database.Database,
    _options?: {
      maxChunkSize?: number;
      ftsEnabled?: boolean;
    }
  ) {
    this.db = db;
  }

  ensureSchema(): void {
    if (this.schemaReady) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'session',
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_session ON memory_chunks(session_key);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_timestamp ON memory_chunks(timestamp);
    `);

    // FTS5 virtual table - CREATE VIRTUAL TABLE IF NOT EXISTS is supported
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        text,
        id UNINDEXED,
        session_key UNINDEXED,
        source UNINDEXED
      );
    `);

    this.schemaReady = true;
  }

  indexChunk(chunk: MemoryChunk): void {
    this.ensureSchema();

    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO memory_chunks (id, session_key, text, source, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.prepare(`
      INSERT OR REPLACE INTO memory_fts (text, id, session_key, source)
      VALUES (?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      insertChunk.run(
        chunk.id,
        chunk.sessionKey,
        chunk.text,
        chunk.source,
        chunk.timestamp,
        Date.now()
      );
      insertFts.run(chunk.text, chunk.id, chunk.sessionKey, chunk.source);
    });

    txn();
  }

  search(
    query: string,
    options?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    }
  ): MemorySearchResult[] {
    this.ensureSchema();

    if (!query || query.trim().length === 0) {
      return [];
    }

    const maxResults = options?.maxResults ?? 10;
    const ftsQuery = this.buildFtsQuery(query);

    if (!ftsQuery) {
      return [];
    }

    try {
      let rows: Array<Record<string, unknown>>;

      if (options?.sessionKey) {
        rows = this.db
          .prepare(
            `SELECT f.text, f.id, f.session_key, f.source, f.rank,
                    c.timestamp
             FROM memory_fts f
             JOIN memory_chunks c ON c.id = f.id
             WHERE memory_fts MATCH ?
               AND f.session_key = ?
             ORDER BY f.rank
             LIMIT ?`
          )
          .all(ftsQuery, options.sessionKey, maxResults) as Array<
          Record<string, unknown>
        >;
      } else {
        rows = this.db
          .prepare(
            `SELECT f.text, f.id, f.session_key, f.source, f.rank,
                    c.timestamp
             FROM memory_fts f
             JOIN memory_chunks c ON c.id = f.id
             WHERE memory_fts MATCH ?
             ORDER BY f.rank
             LIMIT ?`
          )
          .all(ftsQuery, maxResults) as Array<Record<string, unknown>>;
      }

      return rows.map((row) => ({
        sessionKey: row.session_key as string,
        snippet: row.text as string,
        score: 1 / (1 + Math.abs(row.rank as number)),
        timestamp: row.timestamp as number,
        source: row.source as "session" | "memory",
      }));
    } catch {
      // FTS query syntax errors should return empty rather than crash
      return [];
    }
  }

  indexSession(sessionId: string, transcriptPath: string): void {
    this.ensureSchema();

    if (!fs.existsSync(transcriptPath)) {
      return;
    }

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    const events: Array<{
      type: string;
      timestamp?: string;
      message?: { role: string; content: string };
    }> = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    // Extract session key from header event or use sessionId
    let sessionKey = sessionId;
    const headerEvent = events.find((e) => e.type === "session");
    if (headerEvent && "sessionKey" in headerEvent) {
      sessionKey = (headerEvent as Record<string, unknown>).sessionKey as string;
    }

    // Collect message events
    const messages = events.filter(
      (e) => e.type === "message" && e.message?.content
    );

    // Chunk by user+assistant pairs
    const chunks: Array<{ text: string; timestamp: number }> = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.message?.role === "user") {
        const userText = msg.message.content;
        const userTimestamp = msg.timestamp
          ? new Date(msg.timestamp).getTime()
          : Date.now();

        // Look for following assistant message
        if (
          i + 1 < messages.length &&
          messages[i + 1].message?.role === "assistant"
        ) {
          const assistantText = messages[i + 1].message!.content;
          chunks.push({
            text: `User: ${userText}\nAssistant: ${assistantText}`,
            timestamp: userTimestamp,
          });
          i += 2;
        } else {
          // Lone user message
          chunks.push({
            text: `User: ${userText}`,
            timestamp: userTimestamp,
          });
          i += 1;
        }
      } else if (msg.message?.role === "assistant") {
        // Lone assistant message
        chunks.push({
          text: `Assistant: ${msg.message.content}`,
          timestamp: msg.timestamp
            ? new Date(msg.timestamp).getTime()
            : Date.now(),
        });
        i += 1;
      } else {
        i += 1;
      }
    }

    // Index each chunk
    for (const chunk of chunks) {
      const id = createHash("sha256")
        .update(chunk.text + sessionKey + chunk.timestamp)
        .digest("hex")
        .slice(0, 16);

      this.indexChunk({
        id,
        sessionKey,
        text: chunk.text,
        source: "session",
        timestamp: chunk.timestamp,
      });
    }
  }

  getStats(): { totalChunks: number; totalSessions: number } {
    this.ensureSchema();

    const chunkCount = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_chunks")
      .get() as { count: number };

    const sessionCount = this.db
      .prepare(
        "SELECT COUNT(DISTINCT session_key) as count FROM memory_chunks"
      )
      .get() as { count: number };

    return {
      totalChunks: chunkCount.count,
      totalSessions: sessionCount.count,
    };
  }

  close(): void {
    // db lifecycle is managed externally; nothing to do here
  }

  private buildFtsQuery(query: string): string | null {
    // Tokenize: split on whitespace, remove empty, strip non-alphanumeric edges
    const tokens = query
      .split(/\s+/)
      .map((t) => t.replace(/[^\w]/g, ""))
      .filter((t) => t.length > 0);

    if (tokens.length === 0) {
      return null;
    }

    // AND-join quoted tokens for precise matching
    return tokens.map((t) => `"${t}"`).join(" AND ");
  }
}
