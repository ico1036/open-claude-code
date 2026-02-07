import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { MemoryManager } from "./memory-manager.js";
import type { MemoryChunk } from "./memory-manager.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("MemoryManager", () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    mm = new MemoryManager(db);
    mm.ensureSchema();
  });

  afterEach(() => {
    mm.close();
  });

  // ---------- Test 1: ensureSchema ----------
  describe("ensureSchema", () => {
    it("creates FTS5 tables without error", () => {
      const freshDb = new Database(":memory:");
      const freshMm = new MemoryManager(freshDb);

      expect(() => freshMm.ensureSchema()).not.toThrow();

      // Verify memory_chunks table exists
      const tables = freshDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks'"
        )
        .all();
      expect(tables).toHaveLength(1);

      // Verify memory_fts virtual table exists
      const vtables = freshDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'"
        )
        .all();
      expect(vtables).toHaveLength(1);

      freshMm.close();
    });

    it("is idempotent - calling twice does not error", () => {
      const freshDb = new Database(":memory:");
      const freshMm = new MemoryManager(freshDb);

      freshMm.ensureSchema();
      expect(() => freshMm.ensureSchema()).not.toThrow();

      freshMm.close();
    });
  });

  // ---------- Test 2: indexChunk ----------
  describe("indexChunk", () => {
    it("stores a chunk and makes it searchable", () => {
      const chunk: MemoryChunk = {
        id: "abc123",
        sessionKey: "telegram:user1",
        text: "The quick brown fox jumped over the lazy dog",
        source: "session",
        timestamp: Date.now(),
      };

      mm.indexChunk(chunk);

      // Verify it was inserted into memory_chunks
      const row = db
        .prepare("SELECT * FROM memory_chunks WHERE id = ?")
        .get("abc123") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.session_key).toBe("telegram:user1");
      expect(row.text).toBe("The quick brown fox jumped over the lazy dog");
      expect(row.source).toBe("session");

      // Verify it was inserted into memory_fts
      const ftsRow = db
        .prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH ?")
        .get('"quick brown fox"') as Record<string, unknown>;
      expect(ftsRow).toBeDefined();
      expect(ftsRow.id).toBe("abc123");
    });
  });

  // ---------- Test 3: search returns relevant results ----------
  describe("search", () => {
    beforeEach(() => {
      mm.indexChunk({
        id: "chunk1",
        sessionKey: "telegram:user1",
        text: "We discussed deploying the application to production using Docker containers",
        source: "session",
        timestamp: 1000,
      });
      mm.indexChunk({
        id: "chunk2",
        sessionKey: "telegram:user1",
        text: "The user asked about setting up a PostgreSQL database with proper indexing",
        source: "session",
        timestamp: 2000,
      });
      mm.indexChunk({
        id: "chunk3",
        sessionKey: "discord:user2",
        text: "We talked about TypeScript generics and advanced type inference patterns",
        source: "session",
        timestamp: 3000,
      });
    });

    it("returns relevant results for matching query", () => {
      const results = mm.search("Docker containers production");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("Docker containers");
      expect(results[0].sessionKey).toBe("telegram:user1");
      expect(results[0].source).toBe("session");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });

    // ---------- Test 4: search returns empty for non-matching ----------
    it("returns empty array for non-matching query", () => {
      const results = mm.search("quantum computing blockchain");

      expect(results).toEqual([]);
    });

    // ---------- Test 5: search respects maxResults ----------
    it("respects maxResults limit", () => {
      // Add more chunks to have enough results
      mm.indexChunk({
        id: "chunk4",
        sessionKey: "telegram:user1",
        text: "Another discussion about deploying services and Docker orchestration",
        source: "session",
        timestamp: 4000,
      });
      mm.indexChunk({
        id: "chunk5",
        sessionKey: "telegram:user1",
        text: "Docker compose setup for deploying microservices architecture",
        source: "session",
        timestamp: 5000,
      });

      const results = mm.search("Docker deploying", { maxResults: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    // ---------- Test 6: search filters by sessionKey ----------
    it("filters by sessionKey when specified", () => {
      const results = mm.search("TypeScript", {
        sessionKey: "discord:user2",
      });

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.sessionKey).toBe("discord:user2");
      }

      // Searching with a different session key should not return discord results
      const filtered = mm.search("TypeScript", {
        sessionKey: "telegram:user1",
      });
      for (const result of filtered) {
        expect(result.sessionKey).toBe("telegram:user1");
      }
    });
  });

  // ---------- Test 7: indexSession ----------
  describe("indexSession", () => {
    let tmpDir: string;
    let transcriptPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
      transcriptPath = path.join(tmpDir, "test-session.jsonl");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("chunks a JSONL transcript and indexes it", () => {
      const events = [
        {
          type: "session",
          timestamp: new Date(1000).toISOString(),
          version: 1,
          id: "sess-001",
        },
        {
          type: "message",
          timestamp: new Date(2000).toISOString(),
          message: {
            role: "user",
            content: "How do I set up a REST API with Hono?",
          },
        },
        {
          type: "message",
          timestamp: new Date(3000).toISOString(),
          message: {
            role: "assistant",
            content:
              "You can create a Hono app by importing from the hono package and defining routes.",
          },
        },
        {
          type: "message",
          timestamp: new Date(4000).toISOString(),
          message: {
            role: "user",
            content: "What about middleware and error handling?",
          },
        },
        {
          type: "message",
          timestamp: new Date(5000).toISOString(),
          message: {
            role: "assistant",
            content:
              "Hono supports middleware via app.use() and you can add error handlers with app.onError().",
          },
        },
      ];

      fs.writeFileSync(
        transcriptPath,
        events.map((e) => JSON.stringify(e)).join("\n") + "\n"
      );

      mm.indexSession("sess-001", transcriptPath);

      // Should be able to find the indexed content
      const results = mm.search("Hono REST API");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("Hono");

      // Stats should reflect the indexed chunks
      const stats = mm.getStats();
      expect(stats.totalChunks).toBeGreaterThan(0);
    });
  });

  // ---------- Test 8: score normalization ----------
  describe("score normalization", () => {
    it("produces scores between 0 and 1 with higher relevance getting higher scores", () => {
      mm.indexChunk({
        id: "exact1",
        sessionKey: "test:user",
        text: "machine learning neural networks deep learning artificial intelligence",
        source: "session",
        timestamp: 1000,
      });
      mm.indexChunk({
        id: "partial1",
        sessionKey: "test:user",
        text: "we discussed cooking recipes for pasta and pizza with fresh ingredients",
        source: "session",
        timestamp: 2000,
      });

      const results = mm.search("machine learning neural networks");

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }

      // The more relevant result should have a higher score
      if (results.length > 1) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });
  });

  // ---------- Test 9: FTS query building ----------
  describe("FTS query building", () => {
    it("AND-joins query terms for precise matching", () => {
      mm.indexChunk({
        id: "both",
        sessionKey: "test:user",
        text: "Python Django framework for web development",
        source: "session",
        timestamp: 1000,
      });
      mm.indexChunk({
        id: "only-python",
        sessionKey: "test:user",
        text: "Python scripting for data analysis with pandas",
        source: "session",
        timestamp: 2000,
      });
      mm.indexChunk({
        id: "only-django",
        sessionKey: "test:user",
        text: "Django ORM for database management and migrations",
        source: "session",
        timestamp: 3000,
      });

      // Searching for "Python Django" should prefer the chunk with both terms
      const results = mm.search("Python Django");

      expect(results.length).toBeGreaterThan(0);
      // The result containing both terms should be first
      expect(results[0].snippet).toContain("Python");
      expect(results[0].snippet).toContain("Django");
    });

    it("handles single word queries", () => {
      mm.indexChunk({
        id: "single",
        sessionKey: "test:user",
        text: "Kubernetes container orchestration and cluster management",
        source: "session",
        timestamp: 1000,
      });

      const results = mm.search("Kubernetes");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("Kubernetes");
    });

    it("handles empty query gracefully", () => {
      const results = mm.search("");
      expect(results).toEqual([]);
    });

    it("handles query with special characters", () => {
      mm.indexChunk({
        id: "special",
        sessionKey: "test:user",
        text: "Using node.js with express for building APIs",
        source: "session",
        timestamp: 1000,
      });

      // Should not throw even with special chars
      expect(() => mm.search("node.js express")).not.toThrow();
    });
  });

  // ---------- Test 10: getStats ----------
  describe("getStats", () => {
    it("returns correct counts", () => {
      // Initially empty
      const emptyStats = mm.getStats();
      expect(emptyStats.totalChunks).toBe(0);
      expect(emptyStats.totalSessions).toBe(0);

      // Add chunks from different sessions
      mm.indexChunk({
        id: "s1c1",
        sessionKey: "telegram:user1",
        text: "First session first chunk",
        source: "session",
        timestamp: 1000,
      });
      mm.indexChunk({
        id: "s1c2",
        sessionKey: "telegram:user1",
        text: "First session second chunk",
        source: "session",
        timestamp: 2000,
      });
      mm.indexChunk({
        id: "s2c1",
        sessionKey: "discord:user2",
        text: "Second session first chunk",
        source: "session",
        timestamp: 3000,
      });

      const stats = mm.getStats();
      expect(stats.totalChunks).toBe(3);
      expect(stats.totalSessions).toBe(2);
    });
  });

  // ---------- Test 11: indexChunk deduplication ----------
  describe("indexChunk deduplication", () => {
    it("replaces chunk with same id on re-index", () => {
      mm.indexChunk({
        id: "dedup1",
        sessionKey: "test:user",
        text: "original text about JavaScript",
        source: "session",
        timestamp: 1000,
      });

      mm.indexChunk({
        id: "dedup1",
        sessionKey: "test:user",
        text: "updated text about TypeScript",
        source: "session",
        timestamp: 2000,
      });

      const stats = mm.getStats();
      expect(stats.totalChunks).toBe(1);

      // Search should find the updated text
      const results = mm.search("TypeScript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("TypeScript");
    });
  });

  // ---------- Test 12: indexSession with missing file ----------
  describe("indexSession edge cases", () => {
    it("handles missing transcript file gracefully", () => {
      expect(() =>
        mm.indexSession("nonexistent", "/tmp/nonexistent-transcript.jsonl")
      ).not.toThrow();

      const stats = mm.getStats();
      expect(stats.totalChunks).toBe(0);
    });

    it("handles empty transcript file", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
      const emptyPath = path.join(tmpDir, "empty.jsonl");
      fs.writeFileSync(emptyPath, "");

      expect(() => mm.indexSession("empty-sess", emptyPath)).not.toThrow();

      const stats = mm.getStats();
      expect(stats.totalChunks).toBe(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates user+assistant pair chunks from transcript", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
      const transcriptPath = path.join(tmpDir, "pairs.jsonl");

      const events = [
        { type: "session", timestamp: new Date(1000).toISOString(), version: 1, id: "s1" },
        { type: "message", timestamp: new Date(2000).toISOString(), message: { role: "user", content: "What is Rust?" } },
        { type: "message", timestamp: new Date(3000).toISOString(), message: { role: "assistant", content: "Rust is a systems programming language." } },
        { type: "message", timestamp: new Date(4000).toISOString(), message: { role: "user", content: "How about Go?" } },
        { type: "message", timestamp: new Date(5000).toISOString(), message: { role: "assistant", content: "Go is a language by Google for concurrent systems." } },
      ];

      fs.writeFileSync(
        transcriptPath,
        events.map((e) => JSON.stringify(e)).join("\n") + "\n"
      );

      mm.indexSession("s1", transcriptPath);

      // Should create 2 chunks (2 user+assistant pairs)
      const stats = mm.getStats();
      expect(stats.totalChunks).toBe(2);

      // Each chunk should contain both User: and Assistant: labels
      const results = mm.search("Rust");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("User:");
      expect(results[0].snippet).toContain("Assistant:");

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ---------- Test 13: shared DB scenario ----------
  describe("shared database", () => {
    it("coexists with other tables in the same database", () => {
      // Simulate sharing DB with message store
      db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, text TEXT)");
      db.prepare("INSERT INTO messages (id, text) VALUES (?, ?)").run("m1", "hello");

      // Memory operations should not interfere
      mm.indexChunk({
        id: "shared1",
        sessionKey: "test:user",
        text: "Memory chunk in shared database",
        source: "session",
        timestamp: 1000,
      });

      const results = mm.search("shared database");
      expect(results.length).toBeGreaterThan(0);

      // Other tables should still work
      const msgRow = db.prepare("SELECT * FROM messages WHERE id = ?").get("m1") as Record<string, unknown>;
      expect(msgRow.text).toBe("hello");
    });
  });

  // ---------- Test 14: search result structure ----------
  describe("search result structure", () => {
    it("returns all required fields in MemorySearchResult", () => {
      mm.indexChunk({
        id: "struct1",
        sessionKey: "telegram:42",
        text: "Discussing authentication with JWT tokens",
        source: "memory",
        timestamp: 1700000000000,
      });

      const results = mm.search("JWT authentication");
      expect(results.length).toBe(1);

      const result = results[0];
      expect(result).toHaveProperty("sessionKey", "telegram:42");
      expect(result).toHaveProperty("snippet");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("timestamp", 1700000000000);
      expect(result).toHaveProperty("source", "memory");
      expect(typeof result.score).toBe("number");
    });
  });
});
