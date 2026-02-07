# OpenClaw Memory System - Reverse Engineering Report

This document provides a comprehensive technical analysis of OpenClaw's memory system,
covering data models, SQLite schema, vector storage, embedding pipeline, indexing,
search flow, session integration, sync pipeline, and key code patterns.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Model](#2-data-model)
3. [Memory Schema (SQLite)](#3-memory-schema-sqlite)
4. [Vector Storage (sqlite-vec)](#4-vector-storage-sqlite-vec)
5. [Embedding Pipeline](#5-embedding-pipeline)
6. [Indexing Pipeline](#6-indexing-pipeline)
7. [Search Flow](#7-search-flow)
8. [Session-Memory Relationship](#8-session-memory-relationship)
9. [Sync Pipeline](#9-sync-pipeline)
10. [Key Code Patterns](#10-key-code-patterns)
11. [Simplification Notes for OpenClaudeCode](#11-simplification-notes-for-openclaudecode)

---

## 1. Architecture Overview

The memory system provides semantic search over markdown files and session transcripts.
It consists of two backends:

- **builtin** (`MemoryIndexManager`): SQLite + sqlite-vec + FTS5, with embedding providers
  (OpenAI, Gemini, Voyage, local via node-llama-cpp).
- **qmd** (`QmdMemoryManager`): External CLI tool (`qmd`) that manages its own index.

The `getMemorySearchManager()` factory picks the backend based on config, with
`FallbackMemoryManager` wrapping QMD to fall back to builtin on failure.

### File Map

```
memory/
  types.ts              - Public types (MemorySearchResult, MemorySearchManager interface)
  index.ts              - Public API exports
  memory-schema.ts      - SQLite table creation (ensureMemoryIndexSchema)
  sqlite.ts             - Node.js sqlite module loader
  sqlite-vec.ts         - sqlite-vec extension loader
  manager.ts            - MemoryIndexManager (main class, ~2400 LOC)
  manager-search.ts     - searchVector() and searchKeyword() standalone functions
  manager-cache-key.ts  - Cache key computation for manager deduplication
  hybrid.ts             - Hybrid search: buildFtsQuery, bm25RankToScore, mergeHybridResults
  internal.ts           - Utilities: chunkMarkdown, hashText, cosineSimilarity, listMemoryFiles
  embeddings.ts         - EmbeddingProvider abstraction + createEmbeddingProvider factory
  embeddings-openai.ts  - OpenAI embedding provider
  embeddings-gemini.ts  - Gemini embedding provider
  embeddings-voyage.ts  - Voyage embedding provider
  batch-openai.ts       - OpenAI batch embedding API
  batch-gemini.ts       - Gemini batch embedding API
  batch-voyage.ts       - Voyage batch embedding API
  search-manager.ts     - getMemorySearchManager() + FallbackMemoryManager
  session-files.ts      - Session transcript parsing helpers
  sync-memory-files.ts  - Standalone syncMemoryFiles() (extracted version)
  sync-session-files.ts - Standalone syncSessionFiles() (extracted version)
  provider-key.ts       - computeEmbeddingProviderKey()
  status-format.ts      - Status formatting helpers (tones)
  qmd-manager.ts        - QmdMemoryManager (external qmd CLI backend)
  backend-config.ts     - QMD backend config resolution
  node-llama.ts         - Lazy import of node-llama-cpp
  headers-fingerprint.ts - Header name fingerprinting for cache keys
```

---

## 2. Data Model

### Core Types (`types.ts`)

```typescript
type MemorySource = "memory" | "sessions";

type MemorySearchResult = {
  path: string;       // Relative path within workspace (e.g., "memory/notes.md")
  startLine: number;  // 1-based start line of the chunk
  endLine: number;    // 1-based end line of the chunk
  score: number;      // Combined similarity score (0-1 range)
  snippet: string;    // Text snippet (max 700 chars)
  source: MemorySource;
  citation?: string;
};

type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

interface MemorySearchManager {
  search(query: string, opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }): Promise<MemorySearchResult[]>;

  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;

  status(): MemoryProviderStatus;

  sync?(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;

  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
```

### Internal Types (`internal.ts`)

```typescript
type MemoryFileEntry = {
  path: string;      // Relative path from workspace root
  absPath: string;   // Absolute filesystem path
  mtimeMs: number;   // File modification time
  size: number;      // File size in bytes
  hash: string;      // SHA-256 of file content
};

type MemoryChunk = {
  startLine: number;  // 1-based
  endLine: number;    // 1-based
  text: string;       // Chunk text content
  hash: string;       // SHA-256 of chunk text
};
```

### Embedding Provider (`embeddings.ts`)

```typescript
type EmbeddingProvider = {
  id: string;                                    // "openai" | "gemini" | "voyage" | "local" | "mock"
  model: string;                                 // Model name string
  embedQuery: (text: string) => Promise<number[]>;     // Single text -> vector
  embedBatch: (texts: string[]) => Promise<number[][]>; // Batch texts -> vectors
};

type EmbeddingProviderResult = {
  provider: EmbeddingProvider;
  requestedProvider: "openai" | "local" | "gemini" | "voyage" | "auto";
  fallbackFrom?: "openai" | "local" | "gemini" | "voyage";
  fallbackReason?: string;
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
  voyage?: VoyageEmbeddingClient;
};
```

### Manager Internal Metadata

```typescript
type MemoryIndexMeta = {
  model: string;          // Embedding model name
  provider: string;       // Provider ID
  providerKey?: string;   // Hash of provider config (for cache invalidation)
  chunkTokens: number;    // Chunk size in tokens
  chunkOverlap: number;   // Overlap in tokens
  vectorDims?: number;    // Embedding dimensions (e.g., 1536)
};
```

### Configuration (`agents/memory-search.ts`)

```typescript
type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  extraPaths: string[];
  provider: "openai" | "local" | "gemini" | "voyage" | "auto";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch?: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  experimental: { sessionMemory: boolean };
  fallback: "openai" | "gemini" | "local" | "voyage" | "none";
  model: string;
  local: { modelPath?: string; modelCacheDir?: string };
  store: {
    driver: "sqlite";
    path: string;       // e.g., "~/.openclaw/memory/{agentId}.sqlite"
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;   // Default: 400
    overlap: number;   // Default: 80
  };
  sync: {
    onSessionStart: boolean;   // Default: true
    onSearch: boolean;         // Default: true
    watch: boolean;            // Default: true (chokidar file watcher)
    watchDebounceMs: number;   // Default: 1500
    intervalMinutes: number;   // Default: 0 (disabled)
    sessions: {
      deltaBytes: number;      // Default: 100_000
      deltaMessages: number;   // Default: 50
    };
  };
  query: {
    maxResults: number;   // Default: 6
    minScore: number;     // Default: 0.35
    hybrid: {
      enabled: boolean;          // Default: true
      vectorWeight: number;      // Default: 0.7
      textWeight: number;        // Default: 0.3
      candidateMultiplier: number; // Default: 4
    };
  };
  cache: {
    enabled: boolean;      // Default: true
    maxEntries?: number;   // LRU eviction when exceeded
  };
};
```

Default values (important for OpenClaudeCode):
- `DEFAULT_CHUNK_TOKENS = 400`
- `DEFAULT_CHUNK_OVERLAP = 80`
- `DEFAULT_MAX_RESULTS = 6`
- `DEFAULT_MIN_SCORE = 0.35`
- `DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7`
- `DEFAULT_HYBRID_TEXT_WEIGHT = 0.3`
- `DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4`

---

## 3. Memory Schema (SQLite)

### Table Definitions (`memory-schema.ts`)

```sql
-- Metadata key-value store (stores MemoryIndexMeta as JSON)
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracked files (both memory files and session transcripts)
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',  -- 'memory' | 'sessions'
  hash TEXT NOT NULL,                      -- SHA-256 of file content
  mtime INTEGER NOT NULL,                  -- Last modified time (ms)
  size INTEGER NOT NULL                    -- File size in bytes
);

-- Text chunks with embeddings
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,                     -- SHA-256 of "{source}:{path}:{startLine}:{endLine}:{hash}:{model}"
  path TEXT NOT NULL,                      -- Relative file path
  source TEXT NOT NULL DEFAULT 'memory',   -- 'memory' | 'sessions'
  start_line INTEGER NOT NULL,             -- 1-based start line
  end_line INTEGER NOT NULL,               -- 1-based end line
  hash TEXT NOT NULL,                      -- SHA-256 of chunk text
  model TEXT NOT NULL,                     -- Embedding model name
  text TEXT NOT NULL,                      -- Raw chunk text
  embedding TEXT NOT NULL,                 -- JSON-serialized float[] embedding
  updated_at INTEGER NOT NULL              -- Timestamp (ms)
);

-- Embedding cache (avoids re-embedding unchanged chunks on reindex)
CREATE TABLE IF NOT EXISTS embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,       -- Hash of provider config (baseUrl, model, headers)
  hash TEXT NOT NULL,               -- SHA-256 of chunk text
  embedding TEXT NOT NULL,          -- JSON-serialized float[]
  dims INTEGER,                     -- Embedding dimensions
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);
```

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON embedding_cache(updated_at);
```

### FTS5 Virtual Table (BM25 keyword search)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,                    -- Searchable text column
  id UNINDEXED,            -- Chunk ID (stored but not indexed)
  path UNINDEXED,          -- File path
  source UNINDEXED,        -- Source type
  model UNINDEXED,         -- Model name
  start_line UNINDEXED,    -- Start line
  end_line UNINDEXED       -- End line
);
```

### Key: `META_KEY = "memory_index_meta_v1"`

The `meta` table stores `MemoryIndexMeta` under this key. It's used to detect when a
full reindex is needed (model change, provider change, chunking params change, etc.).

---

## 4. Vector Storage (sqlite-vec)

### Extension Loading (`sqlite-vec.ts`)

```typescript
async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }>;
```

Uses the `sqlite-vec` npm package. Loads via `sqliteVec.load(db)` or a custom path.
The extension is loaded lazily on first need, with a 30-second timeout.

### Virtual Table (`manager.ts:ensureVectorTable`)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[{dimensions}]
);
```

The dimension is determined dynamically from the first embedding produced. If dimensions
change (e.g., model switch), the vector table is dropped and recreated.

### Vector Format

Embeddings are stored as `Float32Array` blobs:

```typescript
const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);
```

### Distance Function

Uses `vec_distance_cosine()` from sqlite-vec:

```sql
SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
       vec_distance_cosine(v.embedding, ?) AS dist
  FROM chunks_vec v
  JOIN chunks c ON c.id = v.id
 WHERE c.model = ?
 ORDER BY dist ASC
 LIMIT ?
```

Score is `1 - dist` (cosine similarity).

### Fallback (no sqlite-vec)

If sqlite-vec is unavailable, the system falls back to in-memory cosine similarity:

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  // Standard dot product / (norm_a * norm_b)
}
```

All chunk embeddings are loaded from the `chunks` table (JSON text column) and compared
in JavaScript. This is O(n) and obviously slower, but works without native extensions.

---

## 5. Embedding Pipeline

### Provider Abstraction

All providers implement the `EmbeddingProvider` interface:

```typescript
type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};
```

### Provider Selection (`createEmbeddingProvider`)

With `provider: "auto"`, the system tries providers in order:
1. **Local** (if `canAutoSelectLocal()` - requires local GGUF model file on disk)
2. **OpenAI** (requires API key)
3. **Gemini** (requires API key)
4. **Voyage** (requires API key)

Falls back to the `fallback` provider on primary failure.

### Provider Details

**OpenAI** (`embeddings-openai.ts`):
- Default model: `text-embedding-3-small`
- Endpoint: `{baseUrl}/embeddings`
- Input format: `{ model, input: string[] }`
- Output format: `{ data: [{ embedding: number[] }] }`

**Gemini** (`embeddings-gemini.ts`):
- Default model: `gemini-embedding-001`
- Query endpoint: `{baseUrl}/models/{model}:embedContent`
- Batch endpoint: `{baseUrl}/models/{model}:batchEmbedContents`
- Uses `taskType: "RETRIEVAL_QUERY"` for queries, `"RETRIEVAL_DOCUMENT"` for indexing
- API key via `x-goog-api-key` header

**Voyage** (`embeddings-voyage.ts`):
- Default model: `voyage-4-large`
- Endpoint: `{baseUrl}/embeddings`
- Uses `input_type: "query"` for queries, `"document"` for batch indexing
- API key via `Authorization: Bearer` header

**Local** (`embeddings.ts`):
- Uses `node-llama-cpp` with GGUF models
- Default model: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`
- Lazy-loaded to keep startup light
- Embeddings are sanitized and L2-normalized:
  ```typescript
  function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
    const sanitized = vec.map(v => Number.isFinite(v) ? v : 0);
    const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0));
    if (magnitude < 1e-10) return sanitized;
    return sanitized.map(v => v / magnitude);
  }
  ```

### Batching Strategy

Chunks are grouped into batches by estimated token count:

```
EMBEDDING_BATCH_MAX_TOKENS = 8000
EMBEDDING_APPROX_CHARS_PER_TOKEN = 1   // 1:1 chars-to-tokens approximation
```

Algorithm (`buildEmbeddingBatches`):
1. Iterate through chunks
2. Estimate tokens as `text.length / 1` (chars per token)
3. If adding chunk would exceed 8000 tokens, flush current batch
4. If single chunk > 8000 tokens, it becomes its own batch

### Embedding Cache

Before embedding, the system checks the `embedding_cache` table:

```
Key: (provider, model, provider_key, hash)
```

Where:
- `provider_key` = SHA-256 hash of `{ provider, baseUrl, model, headers }` -- excludes auth headers
- `hash` = SHA-256 of chunk text

On cache hit, the embedding is reused. On miss, the chunk is embedded and cached.
Cache is loaded in batches of 400 for efficiency.

LRU eviction occurs when `maxEntries` is exceeded (deletes oldest by `updated_at`).

### Retry Logic

Embedding calls use exponential backoff with jitter:

```
EMBEDDING_RETRY_MAX_ATTEMPTS = 3
EMBEDDING_RETRY_BASE_DELAY_MS = 500
EMBEDDING_RETRY_MAX_DELAY_MS = 8000
```

Retryable errors: `rate_limit`, `too many requests`, `429`, `resource has been exhausted`,
`5xx`, `cloudflare`.

### Timeouts

```
Query (remote):  60 seconds
Query (local):   5 minutes
Batch (remote):  2 minutes
Batch (local):   10 minutes
Vector load:     30 seconds
```

### Batch Embedding APIs

For high-volume indexing, the system supports asynchronous batch APIs for OpenAI, Gemini,
and Voyage. These upload a JSONL file, create a batch job, poll for completion, then
download results.

**Batch Failure Handling**:
- `BATCH_FAILURE_LIMIT = 2` -- after 2 batch failures, batch mode is disabled
- Falls back to synchronous `embedBatch()` calls
- Timeout errors get one retry before counting as a failure

---

## 6. Indexing Pipeline

### File Discovery (`internal.ts:listMemoryFiles`)

Memory files are discovered from:
1. `{workspaceDir}/MEMORY.md`
2. `{workspaceDir}/memory.md`
3. `{workspaceDir}/memory/` (recursive, `.md` files only)
4. Additional paths from `extraPaths` config

Rules:
- Symlinks are **always** excluded
- Only `.md` files are indexed
- Paths are deduplicated by realpath

### Chunking (`internal.ts:chunkMarkdown`)

```typescript
function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number }
): MemoryChunk[]
```

Algorithm:
1. `maxChars = max(32, tokens * 4)` -- assumes ~4 chars per token
2. `overlapChars = max(0, overlap * 4)`
3. Split content by newlines
4. For each line, if it exceeds `maxChars`, split into segments of `maxChars` length
5. Accumulate lines/segments into the current chunk
6. When `currentChars + lineSize > maxChars` and chunk is non-empty, flush:
   - Create a `MemoryChunk` with `startLine`, `endLine`, `text`, `hash`
   - Carry over trailing lines as overlap for the next chunk
7. Flush remaining content

With defaults (`tokens=400, overlap=80`):
- `maxChars = 1600` characters per chunk
- `overlapChars = 320` characters overlap

### File Indexing (`manager.ts:indexFile`)

For each file:
1. Read content (or use provided content for sessions)
2. `chunkMarkdown()` to split into chunks
3. Filter out empty chunks
4. Embed all chunks:
   - If batch mode enabled: `embedChunksWithBatch()` (async batch API)
   - Otherwise: `embedChunksInBatches()` (synchronous with cache)
5. Ensure vector table exists with correct dimensions
6. Delete old chunks for this file+source from `chunks`, `chunks_vec`, `chunks_fts`
7. Insert each chunk:
   - `chunks` table: chunk data + JSON embedding
   - `chunks_vec` table: chunk ID + Float32Array blob (if vector ready)
   - `chunks_fts` table: text + metadata (if FTS available)
8. Upsert `files` table with file hash

### Chunk ID Generation

```typescript
const id = hashText(
  `${source}:${path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`
);
```

This means the same text at the same location with the same model always produces the
same chunk ID. Changing the model triggers a full reindex.

---

## 7. Search Flow

### Entry Point (`manager.ts:search`)

```typescript
async search(query: string, opts?: {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
}): Promise<MemorySearchResult[]>
```

Flow:
1. **Warm session** (fire-and-forget sync if `onSessionStart` enabled)
2. **On-search sync** if dirty (fire-and-forget sync)
3. Clean query string
4. Compute candidate count: `min(200, max(1, maxResults * candidateMultiplier))`
5. **Keyword search** (if hybrid enabled): FTS5 BM25 search
6. **Vector search**: embed query, then sqlite-vec or fallback cosine
7. **Merge** (if hybrid): weighted combination

### Keyword Search (BM25) (`manager-search.ts:searchKeyword`)

```typescript
async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: string[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & { textScore: number }>>
```

FTS query construction (`hybrid.ts:buildFtsQuery`):
```typescript
function buildFtsQuery(raw: string): string | null {
  // Tokenize: extract [A-Za-z0-9_]+ tokens
  // Quote each token
  // Join with AND
  // Example: "hello world" -> '"hello" AND "world"'
}
```

SQL:
```sql
SELECT id, path, source, start_line, end_line, text,
       bm25(chunks_fts) AS rank
  FROM chunks_fts
 WHERE chunks_fts MATCH ? AND model = ? AND source IN (...)
 ORDER BY rank ASC
 LIMIT ?
```

BM25 rank to score conversion:
```typescript
function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}
// rank=0 -> score=1.0, rank=1 -> score=0.5, monotonically decreasing
```

### Vector Search (`manager-search.ts:searchVector`)

Two paths:
1. **sqlite-vec available**: Use `vec_distance_cosine()` in SQL, score = `1 - dist`
2. **Fallback**: Load all chunks from `chunks` table, compute cosine similarity in JS

### Hybrid Merge (`hybrid.ts:mergeHybridResults`)

```typescript
function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;   // Default: 0.7
  textWeight: number;     // Default: 0.3
}): Array<MergedResult>
```

Algorithm:
1. Create a map by chunk ID
2. Add all vector results with their `vectorScore`
3. For keyword results:
   - If chunk ID already exists: merge `textScore` + prefer keyword snippet
   - If new: add with `textScore`, `vectorScore=0`
4. Final score: `vectorWeight * vectorScore + textWeight * textScore`
5. Sort descending by score

### Source Filtering

All queries include a source filter:
```sql
AND source IN ('memory', 'sessions')  -- or just 'memory' depending on config
```

Built by `buildSourceFilter(alias?)`.

### Result Processing

Results are:
1. Filtered by `minScore` (default 0.35)
2. Limited to `maxResults` (default 6)
3. Snippets truncated to `SNIPPET_MAX_CHARS = 700`

---

## 8. Session-Memory Relationship

### Session File Format

Session transcripts are JSONL files (one JSON object per line):
```json
{"type":"message","message":{"role":"user","content":"Hello world"}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}
```

Located at: `~/.openclaw/agents/{agentId}/sessions/*.jsonl`

### Session Parsing (`session-files.ts:buildSessionEntry`)

1. Read the JSONL file
2. Filter lines where `type === "message"` and `role` is `"user"` or `"assistant"`
3. Extract text content:
   - String content: normalize whitespace
   - Array content: extract `{type: "text", text: "..."}` blocks
4. Format as: `"User: text"` or `"Assistant: text"` per line
5. Redact sensitive text (in the extracted standalone version; inline version in manager does not redact)
6. Hash the combined content
7. Return `SessionFileEntry` with path like `sessions/{filename}.jsonl`

### Delta Tracking

The manager tracks byte and message deltas for session files:

```typescript
private sessionDeltas = new Map<string, {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
}>();
```

Session sync triggers when either threshold is exceeded:
- `deltaBytes: 100_000` (100KB of new data)
- `deltaMessages: 50` (50 new lines)

Message counting is done by counting newline characters in the file delta range.

### Session Lifecycle Events

The manager subscribes to `onSessionTranscriptUpdate()` for real-time notification
of session file changes. This is debounced at `SESSION_DIRTY_DEBOUNCE_MS = 5000ms`.

---

## 9. Sync Pipeline

### Sync Triggers

Sync can be triggered by:
1. **Session start**: `warmSession()` fires sync with reason `"session-start"`
2. **On search**: If dirty, fire-and-forget sync with reason `"search"`
3. **File watcher**: chokidar watches `MEMORY.md`, `memory.md`, `memory/`, extra paths
4. **Session delta**: When byte/message thresholds exceeded
5. **Interval**: Configurable periodic sync (default: disabled)
6. **Manual**: `sync({ force: true })` from external callers

### Sync Mutex

Only one sync can run at a time:
```typescript
async sync(params?): Promise<void> {
  if (this.syncing) return this.syncing;
  this.syncing = this.runSync(params).finally(() => { this.syncing = null; });
  return this.syncing;
}
```

### Full Reindex Detection

Full reindex is triggered when:
- `force: true`
- No stored metadata
- Model changed
- Provider changed
- Provider key changed (different API endpoint/headers)
- Chunking params changed
- Vector enabled but no stored dimensions

### Safe Reindex (`runSafeReindex`)

To avoid corrupting the index during reindex:
1. Create a temp database at `{dbPath}.tmp-{uuid}`
2. Copy embedding cache from old DB to temp DB
3. Index all files into temp DB
4. Write metadata
5. Close both databases
6. Atomic swap: old -> backup, temp -> live, delete backup
7. Reopen the database

If the reindex fails, the temp DB is cleaned up and the original is restored.

### Incremental Sync

For memory files:
- Skip files whose hash hasn't changed since last index
- Remove stale files (files in DB but no longer on disk)

For session files:
- Only index dirty files (files in `sessionsDirtyFiles` set)
- Or index all if full reindex or no dirty files tracked

### Concurrency

```
EMBEDDING_INDEX_CONCURRENCY = 4  (when not using batch API)
Batch concurrency: configurable (default: 2)
```

Uses `runWithConcurrency()` -- a simple worker pool with early termination on error.

---

## 10. Key Code Patterns

### Singleton Manager Cache

```typescript
const INDEX_CACHE = new Map<string, MemoryIndexManager>();
```

Managers are cached by a key composed of `agentId:workspaceDir:settingsHash`.
`MemoryIndexManager.get()` returns the cached instance or creates a new one.

### Provider Key for Cache Invalidation

The `computeProviderKey()` hashes the provider's configuration (baseUrl, model, non-auth
headers) to detect when embeddings from different API endpoints shouldn't be mixed:

```typescript
private computeProviderKey(): string {
  // Hash of { provider, baseUrl, model, headerNames (minus auth) }
}
```

### Hashing

All hashing uses SHA-256:
```typescript
function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
```

### Embedding Normalization

Local embeddings are L2-normalized. Remote providers (OpenAI, Gemini, Voyage) return
pre-normalized vectors.

### Error Handling / Fallback Chain

```
Primary provider -> retry (3x with backoff) -> fallback provider -> error
Batch API -> retry (1x for timeout) -> fallback to sync embeddings -> error
Primary backend (QMD) -> fallback to builtin
```

### File Watching

Uses `chokidar` with:
- `ignoreInitial: true`
- `awaitWriteFinish.stabilityThreshold: watchDebounceMs` (default 1500ms)
- Watches: `MEMORY.md`, `memory.md`, `memory/`, extra paths
- Session files: via event subscription, not direct file watching

### Config Resolution

The config system uses a two-layer merge:
1. `agents.defaults.memorySearch` -- global defaults
2. `agents.list[n].memorySearch` -- per-agent overrides

Values are clamped and normalized (e.g., weights normalized to sum to 1.0).

---

## 11. Simplification Notes for OpenClaudeCode

### What to Keep (Essential)

1. **SQLite schema**: `meta`, `files`, `chunks`, `embedding_cache` tables
2. **FTS5 table** for keyword search -- simple to set up, huge value
3. **sqlite-vec** for vector search -- already works with Node.js sqlite
4. **Chunking**: `chunkMarkdown()` with `tokens=400, overlap=80`
5. **Hybrid search**: vector + BM25 merge with configurable weights
6. **Embedding cache**: avoids re-embedding on reindex
7. **Safe reindex**: temp DB + atomic swap pattern
8. **Single provider**: Start with OpenAI `text-embedding-3-small`

### What to Simplify

1. **Drop QMD backend entirely** -- only implement builtin
2. **Drop batch APIs** -- use synchronous embeddings (batch APIs are complex and
   only matter at scale)
3. **Drop local embeddings** -- node-llama-cpp is heavy; just use OpenAI
4. **Drop Gemini and Voyage providers** -- start with OpenAI only
5. **Drop provider auto-detection** -- require explicit provider config
6. **Drop session memory initially** -- index only `MEMORY.md` and `memory/` files
7. **Simplify file watching** -- can use `fs.watch` instead of chokidar
8. **Drop delta tracking** -- full reindex on each sync is fine for small datasets
9. **Drop FallbackMemoryManager** -- single backend, no fallback needed
10. **Drop provider fallback** -- single provider, fail cleanly
11. **Drop batch failure tracking** -- no batch API means no failure counting

### Minimal Implementation (Recommended for v1)

```
MemoryManager
  - constructor(workspaceDir, dbPath, embeddingProvider)
  - sync() -> index all memory files
  - search(query, maxResults?) -> hybrid search results
  - readFile(relPath) -> file content
  - close()

Schema: meta + files + chunks + embedding_cache + chunks_fts + chunks_vec
Provider: OpenAI text-embedding-3-small only
Chunking: chunkMarkdown(content, { tokens: 400, overlap: 80 })
Search: vector + BM25 hybrid (0.7/0.3 weights)
```

### Key Numbers to Preserve

| Constant | Value | Purpose |
|---|---|---|
| `SNIPPET_MAX_CHARS` | 700 | Max snippet length in results |
| `EMBEDDING_BATCH_MAX_TOKENS` | 8000 | Max tokens per embedding API call |
| `DEFAULT_CHUNK_TOKENS` | 400 | Chunk size |
| `DEFAULT_CHUNK_OVERLAP` | 80 | Overlap between chunks |
| `DEFAULT_MAX_RESULTS` | 6 | Default search results |
| `DEFAULT_MIN_SCORE` | 0.35 | Minimum similarity threshold |
| `DEFAULT_HYBRID_VECTOR_WEIGHT` | 0.7 | Vector score weight |
| `DEFAULT_HYBRID_TEXT_WEIGHT` | 0.3 | BM25 score weight |
| `DEFAULT_HYBRID_CANDIDATE_MULTIPLIER` | 4 | Fetch 4x candidates before merge |

### Copy-Paste-Ready Utilities

These functions from `internal.ts` and `hybrid.ts` can be reused nearly as-is:

- `hashText(value)` -- SHA-256 hex
- `chunkMarkdown(content, chunking)` -- markdown chunking
- `cosineSimilarity(a, b)` -- fallback vector distance
- `parseEmbedding(raw)` -- JSON string to number[]
- `buildFtsQuery(raw)` -- FTS5 MATCH query builder
- `bm25RankToScore(rank)` -- BM25 rank normalization
- `mergeHybridResults(params)` -- hybrid merge algorithm
- `runWithConcurrency(tasks, limit)` -- parallel task runner
- `listMemoryFiles(workspaceDir, extraPaths)` -- file discovery
- `buildFileEntry(absPath, workspaceDir)` -- file metadata builder
