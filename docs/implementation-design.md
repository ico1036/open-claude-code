# OpenClaudeCode - Memory/Context/Agent System Design

## Reverse Engineering Summary

### OpenClaw Architecture (Source of Truth)

OpenClaw uses a sophisticated multi-layered memory and session system:

#### 1. Session Management
- **Session Key**: `agent:{agentId}:{channel}:{accountId}:{chatType}:{userId}` format
- **Session Store**: JSON file (`sessions.json`) mapping session keys to `SessionEntry`
- **Session Entry** tracks: `sessionId`, `updatedAt`, `systemSent`, `compactionCount`, `memoryFlushAt`, `totalTokens`, `inputTokens`, `outputTokens`, `contextTokens`, `sessionFile`, `thinkingLevel`, `modelOverride`, etc.
- **Session File**: JSONL transcript at `~/.openclaw/agents/{agentId}/sessions/{timestamp}_{sessionId}.jsonl`
- **Session Lifecycle**: Create → Resume (if fresh) → Compact (when tokens exceed threshold) → Reset (on `/new` command)
- **Freshness Check**: Sessions expire after configurable timeout (default based on channel)

#### 2. Memory System (MemoryIndexManager)
- **SQLite DB** at configurable path with tables:
  - `meta` - index metadata (model, provider, chunk settings)
  - `files` - tracked file paths with hash/mtime/size
  - `chunks` - text chunks with embeddings (id, path, source, start_line, end_line, hash, model, text, embedding)
  - `embedding_cache` - cached embeddings by provider/model/hash
  - `chunks_fts` - FTS5 virtual table for BM25 keyword search
  - `chunks_vec` - sqlite-vec virtual table for vector search
- **Two Sources**: `"memory"` (markdown files in workspace) + `"sessions"` (JSONL transcripts)
- **Embedding Providers**: OpenAI, Gemini, Voyage, Local (node-llama) with fallback chain
- **Hybrid Search**: BM25 (text weight) + Vector (vector weight) merged by configurable weights
- **Chunking**: Markdown-aware chunking with configurable token size and overlap
- **Sync Triggers**: File watcher, session transcript updates, periodic interval, on-search

#### 3. Memory Flush (Pre-Compaction)
- When `totalTokens` approaches context window limit, triggers a "memory flush" turn
- Agent is prompted to save important memories to disk (`memory/YYYY-MM-DD.md`)
- After flush, compaction occurs (old messages summarized/removed)
- Tracked via `compactionCount` and `memoryFlushCompactionCount` on session entry

#### 4. History Management
- In-memory `Map<string, HistoryEntry[]>` per conversation key
- LRU eviction when exceeding MAX_HISTORY_KEYS (1000)
- History formatted as `[Chat messages since your last reply - for context]`
- Configurable limit per DM/group (default 50 for groups)

#### 5. Agent Workflow (Auto-Reply Pipeline)
- Inbound message → debounce → session init → history build → context assembly → agent run
- Agent runs embedded Pi agent (LLM API call) with full session transcript
- Supports streaming, block replies, tool execution, typing indicators
- Queue system for concurrent message handling per conversation

---

## OpenClaudeCode Adaptation Design

### Key Constraints
1. We use `claude --print` (external CLI) not embedded LLM API
2. We're an MCP plugin, not a standalone application
3. We want 80% of the value with 20% of the complexity
4. Must use `better-sqlite3` (already in our stack) not `node:sqlite`
5. No sqlite-vec dependency (too complex to bundle) - FTS5 only for now

### Architecture

```
Message In → AutoResponder
    ├── SessionManager.getOrCreateSession(channel, userId)
    │   └── Returns: sessionId, transcriptPath, isNew
    ├── SessionManager.loadTranscript(sessionId)
    │   └── Returns: recent messages from JSONL
    ├── MemoryManager.search(query, sessionKey)
    │   └── Returns: relevant past conversation snippets (FTS5 BM25)
    ├── Build context: system prompt + memory results + transcript + new message
    ├── Invoke `claude --print` with full context via stdin
    ├── SessionManager.appendToTranscript(sessionId, userMsg, assistantMsg)
    ├── MemoryManager.indexSession(sessionId) [async, debounced]
    └── Check compaction trigger → summarize if needed
```

---

## Component Specifications

### 1. SessionManager (`packages/gateway/src/session-manager.ts`)

```typescript
interface SessionEntry {
  sessionId: string;
  sessionKey: string;       // "{channel}:{userId}"
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  compactionCount: number;
  transcriptPath: string;   // ~/.openclaudecode/sessions/{sessionId}.jsonl
  metadata?: Record<string, unknown>;
}

interface TranscriptEvent {
  type: "session" | "message" | "compaction";
  timestamp: string;
  // For type: "message"
  message?: {
    role: "user" | "assistant";
    content: string;
    channel?: string;
    from?: string;
  };
  // For type: "session"
  version?: number;
  id?: string;
  // For type: "compaction"
  summary?: string;
  removedCount?: number;
}

class SessionManager {
  constructor(dataDir: string, options?: { maxSessionAge?: number });

  // Get or create session for a channel+user pair
  getOrCreate(channel: string, userId: string): SessionEntry;

  // Load recent transcript messages
  loadTranscript(sessionId: string, limit?: number): TranscriptEvent[];

  // Append messages to transcript
  appendMessage(sessionId: string, role: "user" | "assistant", content: string, meta?: Record<string, unknown>): void;

  // Reset session (user sends /new)
  resetSession(channel: string, userId: string): SessionEntry;

  // Get session entry
  getSession(channel: string, userId: string): SessionEntry | null;

  // List all active sessions
  listSessions(): SessionEntry[];

  // Compact a session (summarize old messages)
  compactSession(sessionId: string, summary: string): void;

  // Close and cleanup
  close(): void;
}
```

**Storage**:
- Session index in SQLite (`sessions` table)
- Transcripts in JSONL files under `~/.openclaudecode/sessions/`
- Session key: `{channel}:{userId}` (e.g., `telegram:5054873275`)

**Session Freshness**:
- Default max age: 4 hours (configurable)
- If session is stale, auto-create new session
- Preserve compactionCount across resets

### 2. MemoryManager (`packages/gateway/src/memory-manager.ts`)

```typescript
interface MemorySearchResult {
  sessionKey: string;
  snippet: string;
  score: number;
  timestamp: number;
  source: "session" | "memory";
}

interface MemoryChunk {
  id: string;
  sessionKey: string;
  text: string;
  source: "session" | "memory";
  timestamp: number;
}

class MemoryManager {
  constructor(db: BetterSqlite3.Database, options?: {
    maxChunkSize?: number;
    ftsEnabled?: boolean;
  });

  // Ensure FTS5 tables exist
  ensureSchema(): void;

  // Index a session transcript into memory
  indexSession(sessionId: string, transcriptPath: string): void;

  // Search memory using FTS5 (BM25)
  search(query: string, options?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }): MemorySearchResult[];

  // Index a text chunk directly
  indexChunk(chunk: MemoryChunk): void;

  // Get memory stats
  getStats(): { totalChunks: number; totalSessions: number };

  // Close
  close(): void;
}
```

**Schema** (better-sqlite3):
```sql
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text,
  id UNINDEXED,
  session_key UNINDEXED,
  source UNINDEXED
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_session ON memory_chunks(session_key);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_timestamp ON memory_chunks(timestamp);
```

**Chunking Strategy**:
- Split transcript by conversation turns (user+assistant pairs)
- Max chunk size: ~500 tokens (~2000 chars)
- Each chunk includes speaker labels and timestamps

**Search**:
- FTS5 with BM25 ranking
- Query tokenization: AND-joined quoted tokens
- Score normalization: `1 / (1 + rank)`
- Filter by session key if specified

### 3. Enhanced AutoResponder

Changes to existing `auto-responder.ts`:

```typescript
// New context building pipeline
private async buildContext(msg: ChannelMessage): Promise<string> {
  const sessionKey = `${msg.channel}:${msg.from.id}`;
  const session = this.sessionManager.getOrCreate(msg.channel, msg.from.id);

  // 1. Load session transcript (recent messages)
  const transcript = this.sessionManager.loadTranscript(
    session.sessionId,
    this.config.maxHistoryMessages
  );

  // 2. Search memory for relevant context
  const memoryResults = this.memoryManager.search(
    msg.text ?? "",
    { maxResults: 5, sessionKey }
  );

  // 3. Build full context
  const parts: string[] = [];

  // Memory context (if any relevant results)
  if (memoryResults.length > 0) {
    parts.push("## Relevant memories from past conversations:");
    for (const result of memoryResults) {
      parts.push(`[Score: ${result.score.toFixed(2)}] ${result.snippet}`);
    }
    parts.push("");
  }

  // Session transcript
  if (transcript.length > 0) {
    parts.push("## Current conversation transcript:");
    for (const event of transcript) {
      if (event.type === "message" && event.message) {
        const role = event.message.role === "user" ? "User" : "Assistant";
        parts.push(`${role}: ${event.message.content}`);
      }
    }
    parts.push("");
  }

  // New message
  parts.push("## New message:");
  parts.push(`User: ${msg.text ?? "(media)"}`);

  return parts.join("\n");
}
```

**Post-response**: After claude responds, append both user message and assistant response to transcript.

**Memory Indexing**: After every N messages (configurable, default 5), trigger async memory indexing of the session transcript.

**Session Commands**: `/new` or `/reset` in chat triggers session reset.

### 4. MCP Tool: `memory_search`

Add new MCP tool for Claude to search past conversations:

```typescript
{
  name: "memory_search",
  description: "Search past conversation memories using full-text search. Returns relevant snippets from previous conversations.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results (default 10)" },
      channel: { type: "string", description: "Filter by channel (telegram, whatsapp, discord)" },
    },
    required: ["query"],
  },
}
```

---

## TDD Test Strategy

### SessionManager Tests
1. `getOrCreate()` - creates new session for unknown user
2. `getOrCreate()` - returns existing session for known user
3. `getOrCreate()` - creates new session when old one is stale
4. `appendMessage()` - writes to JSONL transcript
5. `loadTranscript()` - reads back messages in order
6. `loadTranscript()` - respects limit parameter
7. `resetSession()` - creates new session, preserves history
8. `compactSession()` - writes compaction event, removes old messages
9. Session key format: `{channel}:{userId}`
10. Concurrent access safety (WAL mode)

### MemoryManager Tests
1. `ensureSchema()` - creates FTS5 tables
2. `indexSession()` - chunks and indexes transcript
3. `search()` - returns relevant results with BM25 scoring
4. `search()` - handles empty query
5. `search()` - filters by session key
6. `search()` - respects maxResults
7. `indexChunk()` - stores and indexes single chunk
8. Chunking: splits long transcripts correctly
9. FTS query building: AND-joined quoted tokens
10. Score normalization: `1 / (1 + rank)`

### AutoResponder Integration Tests
1. Context includes session transcript
2. Context includes memory search results
3. Messages are saved to transcript after response
4. Session reset on `/new` command
5. Memory indexing triggers after N messages
6. Stale sessions auto-reset

---

## Implementation Order

1. **SessionManager** (tests first, then implementation)
2. **MemoryManager** (tests first, then implementation)
3. **AutoResponder enhancement** (integrate session + memory)
4. **MCP tool** (`memory_search`)
5. **Build + integration test**

---

## Configuration

Add to `~/.openclaudecode/config.yaml`:

```yaml
gateway:
  autoResponder:
    enabled: true
    maxConcurrent: 3
    debounceMs: 1500
    maxHistoryMessages: 20          # increased from 10
    sessionMaxAgeMs: 14400000       # 4 hours
    memoryIndexIntervalMessages: 5  # index every 5 messages
    memorySearchMaxResults: 5
    memoryFtsEnabled: true
```
