# OpenClaw Agent/Auto-Reply Workflow: Reverse Engineering Report

## Table of Contents

1. [Message Inbound Flow](#1-message-inbound-flow)
2. [Debounce/Queue](#2-debouncingqueue)
3. [Reply Pipeline](#3-reply-pipeline)
4. [Agent Runner](#4-agent-runner)
5. [Context Assembly](#5-context-assembly)
6. [Tool Execution](#6-tool-execution)
7. [Response Pipeline](#7-response-pipeline)
8. [Streaming/Chunking](#8-streamingchunking)
9. [Error Handling](#9-error-handling)
10. [Key Code Patterns](#10-key-code-patterns)
11. [Simplification Notes for OpenClaudeCode](#11-simplification-notes-for-openclaudecode)

---

## 1. Message Inbound Flow

### Entry Points

Messages enter OpenClaw's auto-reply system through **channel adapters** (Telegram, WhatsApp, Signal, Slack, Discord, etc.). Each adapter normalizes its provider-specific message into a unified `MsgContext` structure.

**File:** `src/auto-reply/dispatch.ts`

The main entry points are three functions with increasing levels of abstraction:

```
dispatchInboundMessage()           -- lowest level, takes a pre-built ReplyDispatcher
dispatchInboundMessageWithDispatcher()  -- creates a simple dispatcher
dispatchInboundMessageWithBufferedDispatcher() -- creates dispatcher with typing indicators
```

All three ultimately call `dispatchReplyFromConfig()` from `src/auto-reply/reply/dispatch-from-config.ts`.

### MsgContext Structure

**File:** `src/auto-reply/templating.ts`

The `MsgContext` is a large flat object containing ~100+ fields organized by category:

- **Message content:** `Body`, `RawBody`, `CommandBody`, `BodyForAgent`, `BodyForCommands`
- **Routing:** `From`, `To`, `SessionKey`, `AccountId`, `Provider`, `Surface`
- **Identity:** `SenderId`, `SenderName`, `SenderUsername`, `SenderE164`
- **Message IDs:** `MessageSid`, `MessageSidFull`, `MessageSids`
- **Thread context:** `ThreadStarterBody`, `ThreadLabel`, `MessageThreadId`
- **Media:** `MediaPath`, `MediaUrl`, `MediaType`, `MediaPaths`, `MediaUrls`
- **Group context:** `ChatType`, `GroupSubject`, `GroupChannel`, `GroupSpace`
- **Control flags:** `WasMentioned`, `CommandAuthorized`, `IsOwner`
- **Originating channel (cross-provider routing):** `OriginatingChannel`, `OriginatingTo`

**Key insight:** There are multiple "body" fields because the message text passes through different processing stages:
- `Body` / `RawBody`: raw text from the channel
- `CommandBody` / `BodyForCommands`: cleaned text for command detection (no history/context)
- `BodyForAgent`: final text sent to the LLM (may include envelope context)
- `BodyStripped`: body with directives/commands removed

### Inbound Context Finalization

**File:** `src/auto-reply/reply/inbound-context.ts`

Before processing, `finalizeInboundContext()` freezes the MsgContext into a `FinalizedMsgContext`. This ensures:
1. Fields are normalized (trimmed, defaults applied)
2. The context is immutable for the remainder of the pipeline

### Message Envelope Formatting

**File:** `src/auto-reply/envelope.ts`

Inbound messages are wrapped in an **envelope format** for the agent's context window:

```
[Channel SenderLabel +elapsed Timestamp] MessageBody
```

Example: `[Telegram John +5m 2024-03-15 14:30 EST] Hello, can you help me?`

Key features:
- Configurable timezone (`local`, `utc`, `user`, or explicit IANA)
- Elapsed time since previous message (for temporal context)
- Sender labels for group chats (omitted in DMs)
- Channel identification header

### dispatch-from-config Flow

**File:** `src/auto-reply/reply/dispatch-from-config.ts`

This is the **main orchestrator** between channel adapters and the reply pipeline:

1. **Duplicate detection:** `shouldSkipDuplicateInbound()` prevents processing the same message twice
2. **Hook execution:** Fires `message_received` hooks for external integrations
3. **Cross-provider routing detection:** If `OriginatingChannel != currentSurface`, replies route back to the originating provider
4. **Fast abort check:** `tryFastAbortFromMessage()` handles `/stop` commands without running the full pipeline
5. **Reply generation:** Calls `getReplyFromConfig()` with callback hooks for streaming
6. **Reply dispatch:** Routes final payloads through the dispatcher (with TTS generation if configured)

The dispatcher supports three kinds of delivery:
- `sendToolResult()` -- intermediate tool output
- `sendBlockReply()` -- streaming block replies
- `sendFinalReply()` -- the final response

---

## 2. Debouncing/Queue

### Inbound Debounce

**File:** `src/auto-reply/inbound-debounce.ts`

When users send multiple messages rapidly (common on mobile), OpenClaw debounces them:

```typescript
createInboundDebouncer<T>({
  debounceMs: number,          // delay before processing
  buildKey: (item) => string,  // group by conversation key
  shouldDebounce: (item) => boolean,  // skip debounce for commands
  onFlush: (items) => void,    // process batched messages
})
```

**Mechanism:**
- Messages are grouped by a conversation key (built from `buildKey`)
- A timer resets on each new message within the debounce window
- When the timer fires, all accumulated messages are flushed as a batch
- Commands bypass debounce (`shouldDebounce` returns false)
- Per-channel override: `messages.inbound.byChannel.telegram.debounceMs`

### Reply Queue System

**File:** `src/auto-reply/reply/queue.ts` and `src/auto-reply/reply/queue/types.ts`

The queue manages concurrent messages to the same session. When a message arrives while an agent run is in progress, the queue decides what to do.

**Queue Modes (`QueueMode`):**

| Mode | Behavior |
|------|----------|
| `steer` | Inject new message into the active streaming run (live steering) |
| `followup` | Queue the message; process after current run completes |
| `collect` | Like followup, but batch-collect multiple queued messages |
| `steer-backlog` | Try steer first; if not streaming, fall back to followup |
| `interrupt` | Abort current run, clear queue, process new message immediately |
| `queue` | Standard FIFO queue |

**Queue Settings (`QueueSettings`):**
```typescript
{
  mode: QueueMode,
  debounceMs?: number,   // delay before processing queued items
  cap?: number,          // max queue depth
  dropPolicy?: "old" | "new" | "summarize"  // what to do when cap is reached
}
```

**FollowupRun structure:**
Each queued item is a `FollowupRun` containing the full context needed to replay:
- `prompt`: the user's message text
- `messageId`: for deduplication
- `originatingChannel`/`originatingTo`: for routing the reply back
- `run`: complete agent configuration (provider, model, thinkLevel, tools, etc.)

**Followup drain:**
After each agent run completes, `scheduleFollowupDrain()` checks for queued items and processes the next one. This creates a sequential processing chain.

---

## 3. Reply Pipeline

### getReplyFromConfig -- The Main Entry Point

**File:** `src/auto-reply/reply/get-reply.ts`

This is the **heart of the reply system**. It orchestrates the full pipeline from inbound message to LLM invocation.

**Pipeline stages:**

```
1. Load config + resolve agent identity
2. Resolve workspace directory + ensure bootstrap files
3. Create typing controller
4. Finalize inbound context
5. Apply media understanding (image/audio transcription)
6. Apply link understanding (URL content extraction)
7. Resolve command authorization
8. Initialize session state (load/create session)
9. Apply reset model overrides
10. Resolve reply directives (inline /commands)
11. Handle inline actions (slash commands like /status, /help)
12. Stage sandbox media
13. Run the prepared reply (actual LLM call)
```

### Step 1-3: Setup

- **Agent identity:** Resolved from `sessionKey` via `resolveSessionAgentId()`. Multi-agent support means different sessions can use different agent configs.
- **Workspace:** `ensureAgentWorkspace()` creates the working directory and optionally bootstraps files (MEMORY.md, etc.)
- **Typing controller:** `createTypingController()` manages the "typing..." indicator with a configurable interval (default 6s) and TTL (2min).

### Step 4-6: Context Enhancement

- **Media understanding:** Images attached to messages are analyzed (OCR, vision description) and injected into the message body
- **Link understanding:** URLs in messages are fetched, summarized, and appended as context

### Step 7-8: Session Management

- **Command authorization:** `resolveCommandAuthorization()` checks if the sender is allowed to use commands (owner check, allowlist)
- **Session state:** `initSessionState()` loads or creates the session, handling resets, scoping (per-sender, per-group, shared), and group activation

### Step 9-10: Directive Processing

**File:** `src/auto-reply/reply/get-reply-directives.ts`

Inline directives are parsed from the message text:

```
/think high       -> sets thinking level
/model opus       -> switches model
/verbose on       -> enables verbose mode
/reasoning on     -> shows reasoning
/elevated on      -> enables elevated bash permissions
/exec host=local  -> overrides execution settings
/queue followup   -> changes queue mode for this message
```

`parseInlineDirectives()` extracts these, and the cleaned body (without directives) is stored for agent prompt use.

**Important logic:**
- Directives in group chats are only honored when the bot is mentioned
- Unauthorized senders cannot use most directives
- Directive-only messages (no other text) are treated specially

### Step 11: Inline Actions

**File:** `src/auto-reply/reply/get-reply-inline-actions.ts`

Commands like `/status`, `/help`, `/new`, `/commands`, `/compact`, `/whoami` are handled here without invoking the LLM. They return immediate responses.

### Step 12-13: Final Preparation and Execution

`runPreparedReply()` assembles the final prompt and delegates to `runReplyAgent()`.

---

## 4. Agent Runner

### runPreparedReply

**File:** `src/auto-reply/reply/get-reply-run.ts`

This function bridges the directive/session layer and the actual agent execution:

1. **Determine typing mode** based on chat type, mention status, and heartbeat
2. **Build group intro** if needed (group chat system instructions about activation mode)
3. **Handle bare resets:** `/new` or `/reset` with no other text gets a special greeting prompt
4. **Apply session hints:** Prefix body with abort hints, message IDs, system events
5. **Inject thread starter:** For thread-based conversations, include the original post
6. **Ensure skill snapshot:** Load skill definitions for the agent
7. **Resolve thinking level:** Check directives, session config, then model defaults
8. **Build the FollowupRun:** Package ALL agent configuration into a single structure
9. **Call `runReplyAgent()`** with the assembled parameters

**The FollowupRun `run` field** is the complete specification for an agent turn:
```typescript
{
  agentId, agentDir, sessionId, sessionKey,
  messageProvider, agentAccountId,
  groupId, groupChannel, groupSpace,
  senderId, senderName, senderUsername, senderE164,
  sessionFile, workspaceDir, config,
  skillsSnapshot, provider, model,
  authProfileId, authProfileIdSource,
  thinkLevel, verboseLevel, reasoningLevel, elevatedLevel,
  execOverrides, bashElevated,
  timeoutMs, blockReplyBreak,
  ownerNumbers, extraSystemPrompt, enforceFinalTag
}
```

### runReplyAgent

**File:** `src/auto-reply/reply/agent-runner.ts`

This is the **agent execution orchestrator**. It manages:

1. **Queue steering:** If `shouldSteer && isStreaming`, inject the message into the active run via `queueEmbeddedPiMessage()`
2. **Followup queueing:** If a run is active and mode is followup/collect, enqueue and return `undefined` (no immediate response)
3. **Memory flush:** `runMemoryFlushIfNeeded()` persists accumulated memories before the agent run
4. **Block reply pipeline:** Creates a streaming pipeline for sending partial responses during generation
5. **Delegate to `runAgentTurnWithFallback()`** for actual LLM invocation
6. **Post-processing:**
   - Persist session usage (tokens, model, provider)
   - Build reply payloads from agent output
   - Emit diagnostic events
   - Append usage line if configured
   - Prepend verbose session hints
7. **Followup scheduling:** `finalizeWithFollowup()` triggers drain of any queued messages

### runAgentTurnWithFallback

**File:** `src/auto-reply/reply/agent-runner-execution.ts`

This wraps the actual LLM call with:

1. **Run ID generation and registration** for lifecycle tracking
2. **Model fallback loop:** `runWithModelFallback()` tries the primary model, then configured fallbacks on failure
3. **Two execution paths:**
   - **CLI provider:** Spawns `claude --print` or similar CLI tool via `runCliAgent()`
   - **Embedded provider:** Uses `runEmbeddedPiAgent()` which directly calls the LLM API

4. **Streaming callbacks wired up:**
   - `onPartialReply`: streaming text deltas for typing indicators
   - `onBlockReply`: block-level streaming for sending intermediate messages
   - `onReasoningStream`: reasoning/thinking token stream
   - `onAgentEvent`: tool start/end events, compaction events
   - `onToolResult`: tool execution results (for verbose mode)

5. **Error recovery:**
   - Context overflow -> reset session and retry
   - Compaction failure -> reset session
   - Role ordering conflict -> reset session
   - Session corruption (Gemini) -> delete transcript, reset
   - Generic errors -> user-facing error message

---

## 5. Context Assembly

### System Prompt Construction

**File:** `src/agents/system-prompt.ts`

The system prompt is assembled from many sections:

```
Identity line (agent name/persona)
## Skills (mandatory)
## Memory Recall
## User Identity
## Current Date & Time
## Reply Tags
## Messaging
## Voice (TTS)
## Documentation
## Tooling (tool descriptions)
## Workspace
## Runtime info
## Extra system prompt (custom instructions)
## Context files (bootstrap/workspace files)
```

**Key sections:**
- **Skills:** Instructions for skill-based routing (read SKILL.md files)
- **Memory Recall:** Instructions to search MEMORY.md + memory/*.md before answering
- **Messaging:** How to use the message tool for cross-channel sends
- **Runtime info:** Model, provider, host, OS, arch, channel, capabilities

### Embedded System Prompt

**File:** `src/agents/pi-embedded-runner/system-prompt.ts`

`buildEmbeddedSystemPrompt()` delegates to `buildAgentSystemPrompt()` with additional context:
- Tool summaries (generated from tool schemas)
- Model alias lines
- User timezone and time
- Sandbox info
- Workspace notes
- Reasoning tag hints

### Context Files

Bootstrap files (like MEMORY.md, workspace-specific context files) are discovered at session start and injected into the system prompt. These provide persistent context across conversation turns.

### Session Transcript

The conversation history is maintained in JSONL session files (`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`). Each line is a turn:

```jsonl
{"role": "user", "content": "...", "timestamp": 1234567890}
{"role": "assistant", "content": "...", "usage": {...}, "model": "..."}
```

The embedded agent (pi-ai SDK) manages loading, compacting, and appending to this transcript.

### Envelope Format for History

Each user message in the transcript is wrapped with the envelope format:
```
[Channel SenderLabel +elapsed Timestamp] MessageBody
```

This gives the agent temporal and sender context for each conversation turn.

---

## 6. Tool Execution

### Tool Architecture

OpenClaw uses the `@mariozechner/pi-ai` / `@mariozechner/pi-agent-core` SDK for tool management. Tools are defined as `AgentTool` objects with:

```typescript
{
  name: string,
  description: string,
  inputSchema: JSONSchema,
  handler: (input, context) => Promise<ToolResult>
}
```

### Tool Categories

Based on the codebase imports, OpenClaw provides these tool families:

1. **Bash/exec tools** (`src/agents/bash-tools.ts`): Shell execution with security controls (elevated, sandboxed)
2. **Channel/messaging tools** (`src/agents/channel-tools.ts`): Send messages, react, edit, poll
3. **Memory tools** (`src/agents/memory-search.ts`): Search and get from MEMORY.md and memory/ directory
4. **Session tools**: Manage sessions (send to other sessions, compact, reset)
5. **Skill-provided tools**: Loaded from workspace skill definitions

### Tool Result Flow

During agent execution, tool calls flow through this pipeline:

1. Agent generates a tool call in its response
2. The pi-ai SDK extracts and validates the tool call
3. Tool handler executes and returns a result
4. Result is appended to the conversation and sent back to the agent
5. **Streaming callbacks fire:**
   - `onToolResult` sends tool summaries to the user (if verbose mode)
   - `onAgentEvent` fires for tool start/end lifecycle events
   - `onBlockReply` may flush buffered text before tool execution

### Tool Result Format

Tool results are formatted based on the channel:
- **Markdown-capable channels** (Telegram, Slack, webchat): `"markdown"` format
- **Plain text channels** (Signal, SMS): `"plain"` format

This is resolved per-message in `runAgentTurnWithFallback()`:
```typescript
const channel = resolveMessageChannel(surface, provider);
return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
```

---

## 7. Response Pipeline

### Agent Output Structure

The embedded agent returns `EmbeddedPiRunResult`:
```typescript
{
  payloads: ReplyPayload[],      // array of reply segments
  meta: {
    durationMs: number,
    agentMeta: {
      sessionId: string,
      provider: string,
      model: string,
      usage: { input, output, cacheRead, cacheWrite, total }
    },
    systemPromptReport?: object,
    error?: { message: string, kind?: string }
  },
  messagingToolSentTexts?: Set<string>,   // texts already sent via message tool
  messagingToolSentTargets?: Set<string>  // targets already sent to
}
```

### Reply Payload Structure

```typescript
type ReplyPayload = {
  text?: string,
  mediaUrl?: string,
  mediaUrls?: string[],
  replyToId?: string,         // quote-reply to a specific message
  replyToTag?: boolean,       // whether reply tag was present
  replyToCurrent?: boolean,   // reply to the triggering message
  audioAsVoice?: boolean,     // send audio as voice message
  isError?: boolean,
  channelData?: Record<string, unknown>  // channel-specific extras
}
```

### Normalization

**File:** `src/auto-reply/reply/normalize-reply.ts`

`normalizeReplyPayload()` processes each payload:

1. **Empty check:** Skip payloads with no text, media, or channel data
2. **Silent token detection:** If text matches `NO_REPLY` (configurable), suppress the reply
3. **Heartbeat token stripping:** Remove `HEARTBEAT_OK` tokens from regular replies
4. **Text sanitization:** `sanitizeUserFacingText()` removes internal markers
5. **LINE directive parsing:** Extract LINE-specific UI elements (quick replies, buttons)
6. **Response prefix:** Prepend configured prefix (with template variable interpolation)

### Reply Routing

**File:** `src/auto-reply/reply/route-reply.ts`

`routeReply()` sends replies to the originating channel:

1. Normalize the channel ID
2. Apply response prefix
3. Normalize the payload
4. Load the outbound delivery module (lazy import)
5. Call `deliverOutboundPayloads()` which handles:
   - Text chunking for the channel's limit
   - Media attachment
   - Reply threading
   - Session transcript mirroring

### Reply Threading

OpenClaw supports several reply-to modes:
- `[[reply_to_current]]` -- reply/quote the triggering message
- `[[reply_to:<id>]]` -- reply to a specific message by ID
- These tags are parsed from the agent's output and stripped before delivery

### Reply Dispatcher

**File:** `src/auto-reply/reply/reply-dispatcher.ts`

The `ReplyDispatcher` queues outbound payloads and delivers them through a channel adapter's `deliver` function:

```typescript
type ReplyDispatcher = {
  sendToolResult(payload)  // tool output (verbose mode)
  sendBlockReply(payload)  // streaming block
  sendFinalReply(payload)  // final response
  waitForIdle()            // wait for all deliveries
  getQueuedCounts()        // { tool, block, final }
}
```

Features:
- **Human-like delay:** Optional random delay between block replies for natural rhythm
- **Payload normalization:** Each payload passes through `normalizeReplyPayload()`
- **Error handling:** Delivery failures are caught and reported without crashing
- **Skip tracking:** Silent/empty payloads are tracked for channel fallback logic

---

## 8. Streaming/Chunking

### Block Reply Streaming

**File:** `src/auto-reply/reply/block-reply-pipeline.ts`

Block streaming sends partial responses as they're generated, rather than waiting for the full reply:

```
User message -> [typing...] -> Block 1 sent -> Block 2 sent -> ... -> Final
```

**Pipeline architecture:**

```typescript
createBlockReplyPipeline({
  onBlockReply: (payload) => Promise<void>,  // delivery function
  timeoutMs: 15000,                           // per-block timeout
  coalescing?: BlockStreamingCoalescing,      // batching config
  buffer?: BlockReplyBuffer                   // audio buffering
})
```

**Key mechanics:**
- **Deduplication:** Tracks sent/pending payload keys to prevent duplicates
- **Timeout:** If a block delivery takes > 15s, the pipeline aborts to prevent ordering issues
- **Serial delivery:** Blocks are sent sequentially via a promise chain (`sendChain`)
- **Abort propagation:** Once aborted (timeout), no more blocks are sent

### Block Reply Coalescing

**File:** `src/auto-reply/reply/block-reply-coalescer.ts`

Small blocks are combined into larger ones for better readability:

```typescript
{
  minChars: 800,    // minimum buffer before sending
  maxChars: 1200,   // maximum buffer before forced send
  idleMs: 1000,     // send after 1s of no new content
  joiner: "\n\n",   // paragraph separator
  flushOnEnqueue: false  // for newline mode: flush each paragraph immediately
}
```

**Behavior:**
1. Text blocks accumulate in a buffer
2. When buffer exceeds `maxChars` or idle timer fires, the buffer is flushed
3. Media payloads always flush immediately (they can't be coalesced)
4. Different `replyToId` values force a flush (different conversation targets)

### Text Chunking

**File:** `src/auto-reply/chunk.ts`

Long outbound messages are split into channel-appropriate sizes:

**Two modes:**
- **`length` mode (default):** Split at character limit, preferring newlines > whitespace > hard break
- **`newline` mode:** Split at paragraph boundaries (blank lines), only length-split oversized paragraphs

**Default chunk limit:** 4000 characters (per-channel override available)

**Markdown-aware chunking (`chunkMarkdownText`):**
- Respects fenced code blocks (``` markers)
- When splitting inside a code block, closes the fence and re-opens it in the next chunk
- Avoids splitting inside parentheses (for URLs)

**Chunk resolution chain:**
```
per-account override > per-channel override > channel dock default > 4000
```

### Block Streaming Configuration

**File:** `src/auto-reply/reply/block-streaming.ts`

Block streaming chunking is resolved separately from outbound chunking:

```typescript
{
  minChars: 800,     // DEFAULT_BLOCK_STREAM_MIN
  maxChars: 1200,    // DEFAULT_BLOCK_STREAM_MAX
  breakPreference: "paragraph" | "newline" | "sentence",
  flushOnParagraph: boolean  // from chunkMode="newline"
}
```

The block streaming coalescing adds:
```typescript
{
  idleMs: 1000,      // DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS
  joiner: "\n\n" | "\n" | " "  // based on breakPreference
}
```

---

## 9. Error Handling

### Model Fallback

**File:** `src/agents/model-fallback.ts`

`runWithModelFallback()` implements automatic model switching on failure:

1. Try the primary model (e.g., `anthropic/claude-opus-4-6`)
2. On `FailoverError`, try configured fallback models
3. Fallback models are configured in `agents.defaults.model.fallbacks`
4. Auth profile rotation: tries different API keys before model fallback

**FailoverError reasons:**
- `rate_limit`, `overloaded`, `auth`, `billing`, `timeout`
- `context_overflow`, `content_filter`, `unknown`

### Session Reset on Error

**File:** `src/auto-reply/reply/agent-runner-execution.ts`

Several error conditions trigger automatic session reset:

| Error Type | Recovery Action |
|------------|----------------|
| Context overflow | Reset session, user gets warning message |
| Compaction failure | Reset session, suggest config change |
| Role ordering conflict | Reset session, delete transcript |
| Session corruption (Gemini) | Delete transcript, remove session entry |

The reset creates a new `sessionId`, a new transcript file, and marks `systemSent=false` so the next turn re-initializes.

### Typing Controller Error Safety

**File:** `src/auto-reply/reply/typing.ts`

The typing controller has a "sealed" state to prevent late callbacks from restarting typing:

```typescript
let sealed = false;  // once cleanup() is called, no more typing
```

This is critical because tool callbacks can fire asynchronously after the run completes. Without sealing, a late tool event could restart the typing indicator permanently.

### Abort Handling

- **User abort** (`/stop`): Fast-aborted via `tryFastAbortFromMessage()` without running the pipeline
- **In-flight abort:** `abortEmbeddedPiRun()` cancels the active embedded run
- **Abort hint:** When the previous run was aborted, the next message gets a prefix:
  > "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."

---

## 10. Key Code Patterns

### 1. Configuration Resolution Chain

OpenClaw uses a consistent pattern for resolving configuration values:

```
inline directive > session entry override > agent config default > global default
```

This applies to: model, provider, thinkLevel, verboseLevel, reasoningLevel, elevatedLevel, queue mode, etc.

### 2. Session Entry as Mutable State

`SessionEntry` is a mutable object that tracks per-session state:
- Model/provider overrides
- Thinking level
- Usage statistics
- Last updated timestamp
- Group activation mode

It's persisted to a JSON store (`sessions.json`) via `updateSessionStore()` which uses file locking for concurrent access.

### 3. FollowupRun as Complete Snapshot

The `FollowupRun` pattern packages ALL state needed to execute an agent turn into a single serializable structure. This enables:
- Queue/replay without re-resolving configuration
- Cross-provider routing (originating channel preserved)
- Followup drain after the primary run completes

### 4. Lazy Module Loading

Performance-sensitive paths use dynamic imports:
```typescript
const { deliverOutboundPayloads } = await import("../../infra/outbound/deliver.js");
```
This keeps the initial load fast by deferring expensive dependencies.

### 5. Promise Chain for Serial Delivery

Block replies use a promise chain pattern for ordered delivery:
```typescript
let sendChain: Promise<void> = Promise.resolve();
sendChain = sendChain.then(() => deliverPayload(payload));
```

### 6. Deduplication via Payload Keys

```typescript
function createBlockReplyPayloadKey(payload: ReplyPayload): string {
  return JSON.stringify({ text, mediaList, replyToId });
}
```

Sets of sent/pending keys prevent duplicate delivery even with async race conditions.

### 7. Normalized Token Patterns

Special tokens control reply behavior:
- `SILENT_REPLY_TOKEN = "NO_REPLY"` -- suppress the reply entirely
- `HEARTBEAT_TOKEN = "HEARTBEAT_OK"` -- heartbeat response marker (stripped from regular replies)

### 8. Callback-Based Streaming Architecture

The agent runner wires up a rich set of callbacks for real-time streaming:

```typescript
runEmbeddedPiAgent({
  onPartialReply: (payload) => {},      // text delta
  onBlockReply: (payload) => {},        // block-level chunk
  onReasoningStream: (payload) => {},   // thinking tokens
  onAgentEvent: (evt) => {},            // lifecycle events
  onToolResult: (payload) => {},        // tool output
  onAssistantMessageStart: () => {},    // new message boundary
  onBlockReplyFlush: () => {},          // force flush blocks
})
```

### 9. Two Agent Execution Backends

**CLI Backend** (`src/agents/cli-runner.ts`):
- Spawns an external process (e.g., `claude --print`)
- Builds CLI args from configuration
- Parses stdout as text, JSON, or JSONL
- No streaming -- waits for complete output
- Tools disabled: "Tools are disabled in this session. Do not call tools."

**Embedded Backend** (`src/agents/pi-embedded-runner/run.ts`):
- Direct API calls via the pi-ai SDK
- Full streaming support
- Tool execution within the agent loop
- Session transcript management (JSONL files)
- Auth profile rotation + failover
- Context window guard (warns/blocks models with too-small context)

### 10. Cross-Provider Reply Routing

When a message originates from a different provider than the session's primary channel:
```
shouldRouteToOriginating = originatingChannel != currentSurface
```

The reply is sent via `routeReply()` to the originating provider instead of through the session's normal dispatcher. This enables shared sessions across Telegram, Slack, etc.

---

## 11. Simplification Notes for OpenClaudeCode

OpenClaudeCode uses `claude --print` externally (CLI backend), which dramatically simplifies the architecture compared to OpenClaw's embedded agent approach.

### What to Keep

1. **MsgContext pattern:** A flat context object normalized from channel adapters is a good pattern. Simplify to ~20 fields (Body, From, To, SessionKey, ChatType, Provider, WasMentioned, MessageSid, etc.)

2. **Envelope formatting:** Wrapping messages with `[Channel User +elapsed] Body` is valuable for temporal context in the conversation history.

3. **Inbound debouncing:** Essential for mobile messaging. The `createInboundDebouncer` pattern with key-based grouping is clean and reusable.

4. **Queue system (simplified):** Use "followup" mode only -- if a run is active, queue the message and process after. Skip steer/interrupt/collect modes initially.

5. **Session management:** The session entry concept (tracking state per conversation) maps directly. Use a simpler JSON store.

6. **Text chunking:** The `chunkText()` function with paragraph-aware splitting is essential for platforms with message limits.

7. **Reply normalization:** Strip silent tokens, sanitize text, apply response prefix.

8. **Error recovery with session reset:** When context overflows, auto-reset and notify the user.

### What to Simplify

1. **No embedded agent:** Since OpenClaudeCode shells out to `claude --print`, we skip:
   - pi-ai SDK integration
   - Auth profile rotation
   - Context window guards
   - Tool registration and execution loop
   - Streaming callbacks (onPartialReply, onBlockReply, etc.)
   - Block reply pipeline/coalescing
   - Session transcript JSONL management (Claude manages its own state)

2. **No model fallback:** `claude --print` uses a single model. No need for `runWithModelFallback()`.

3. **No inline directives (initially):** Skip `/think`, `/model`, `/verbose`, `/reasoning`, `/elevated`. Add `/new` (reset) and `/status` only.

4. **No cross-provider routing:** Each channel adapter sends replies directly. No need for originating channel tracking.

5. **No typing indicators:** The gateway doesn't have channel-specific typing APIs initially.

6. **No block streaming:** With `claude --print` there's no streaming -- wait for complete output, then chunk and send.

7. **No media understanding:** Skip image/audio transcription initially.

8. **No TTS:** Skip voice message generation.

9. **No skill system:** Skip workspace skills/SKILL.md routing.

### Recommended Architecture for OpenClaudeCode

```
Channel Message
    |
    v
Inbound Debouncer (group by sessionKey, 500ms)
    |
    v
Session Manager (load/create session)
    |
    v
Command Detection (/new, /status, /help)
    |-- command found --> handle immediately, return
    |
    v
Queue Check (is a run active for this session?)
    |-- active --> enqueue as followup
    |
    v
Context Assembly:
  1. Load session history from file
  2. Build system prompt (persona + workspace context + memory search results)
  3. Format inbound message with envelope
  4. Append to history
    |
    v
spawn claude --print (with system prompt, message history, MCP tools)
    |
    v
Parse Output
    |
    v
Normalize + Chunk
    |
    v
Send via Channel Adapter
    |
    v
Update Session State (usage, timestamps)
    |
    v
Drain Followup Queue (if any)
```

### Key Data Structures to Replicate

```typescript
// Simplified session entry
type SessionEntry = {
  sessionId: string;
  sessionKey: string;
  chatType: "direct" | "group";
  provider: string;
  updatedAt: number;
  createdAt: number;
  totalTokens?: number;
}

// Simplified reply payload
type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
}

// Simplified queue item
type QueuedMessage = {
  prompt: string;
  sessionKey: string;
  channel: string;
  to: string;
  enqueuedAt: number;
}
```

### Files to Reference When Implementing

| Feature | OpenClaw File | Key Function |
|---------|--------------|--------------|
| Debouncing | `src/auto-reply/inbound-debounce.ts` | `createInboundDebouncer()` |
| Envelope format | `src/auto-reply/envelope.ts` | `formatInboundEnvelope()` |
| Text chunking | `src/auto-reply/chunk.ts` | `chunkText()`, `chunkMarkdownText()` |
| Session store | `src/config/sessions.ts` | `updateSessionStore()` |
| Reply normalization | `src/auto-reply/reply/normalize-reply.ts` | `normalizeReplyPayload()` |
| Silent tokens | `src/auto-reply/tokens.ts` | `isSilentReplyText()` |
| Command detection | `src/auto-reply/command-detection.ts` | `isControlCommandMessage()` |
| CLI runner | `src/agents/cli-runner.ts` | `runCliAgent()` |
| System prompt | `src/agents/system-prompt.ts` | `buildAgentSystemPrompt()` |
| Model defaults | `src/agents/defaults.ts` | Constants |
