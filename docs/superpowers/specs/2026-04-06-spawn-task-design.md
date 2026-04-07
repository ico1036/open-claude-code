# Non-Blocking Sub-Agent Spawning (spawn_task)

## Summary

Add OpenClaw-style non-blocking task spawning to AgentRunner. The main agent can delegate long-running work to background sub-agent sessions while remaining responsive to the user.

## Core Mechanics

### 1. `spawn_task` Tool (in-process MCP)

```typescript
spawn_task({
  task: string,          // Full instruction for the sub-agent (required)
  agent: string,         // Agent profile: "coder", "researcher", or custom (default: "coder")
  model: string,         // Model override (default: inherit from agent profile)
  announce: boolean,     // Auto-send result to chat on completion (default: true)
  timeoutSeconds: number // Abort safety valve (default: 300)
})
// Returns immediately: { status: "accepted", taskId: string }
```

Non-blocking. The main agent's query() turn continues (or ends) without waiting.

### 2. Task Lifecycle

```
spawn_task() called
  → taskId generated (nanoid)
  → task queued in AgentRunner.spawnedTasks map
  → returns { status: "accepted", taskId } immediately

Background:
  → new query() starts in isolated session
  → session key: "{parentKey}:task:{taskId}"
  → sub-agent gets: task prompt + subset of MCP tools (no spawn_task, no write_persona)
  → sub-agent runs to completion

On completion:
  → if announce=true: send_message with result summary to user's chat
  → task status updated to "completed" | "failed"
  → result stored for main agent to query via task_status
```

### 3. `task_status` Tool (in-process MCP)

```typescript
task_status({ taskId?: string })
// If taskId: returns that task's status + result
// If omitted: returns all tasks for current conversation
```

Returns:
```typescript
{
  taskId: string,
  status: "running" | "completed" | "failed",
  agent: string,
  task: string,        // original instruction (truncated)
  startedAt: number,
  completedAt?: number,
  result?: string,     // final result text (truncated to 2000 chars)
  error?: string,
  cost?: number
}
```

### 4. Sub-Agent Session Isolation

Each spawned task gets:
- Own session key (not shared with main agent)
- Own token budget and model context
- Restricted tool set: NO `spawn_task` (no recursive spawning), NO `write_persona`
- Full access to: `send_message`, `list_messages`, `memory_search`, `read_persona`
- System prompt: task instruction only (no persona files, keeps it lightweight)

### 5. Concurrency Controls

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrent` | 3 → 5 | Bump global concurrent limit (main + tasks share pool) |
| `maxChildrenPerSession` | 3 | Max spawned tasks per conversation |
| `taskTimeoutSeconds` | 300 | Auto-abort safety valve per task |

Spawned tasks share the `activeSessions` pool. If pool is full, task queues until a slot opens.

### 6. Announce Mechanism

When a sub-agent task completes with `announce: true`:

```
[Task completed: {agent}]
{result summary, max 2000 chars}

(taskId: {id}, {duration}s, ${cost})
```

Sent via `send_message` to the same channel/recipient as the parent conversation.

If the task fails:

```
[Task failed: {agent}]
{error message}
```

### 7. Data Structures

```typescript
// In AgentRunner
type SpawnedTask = {
  taskId: string;
  parentKey: string;       // conversation key that spawned this
  agent: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed";
  announce: boolean;
  channel: string;         // for announce routing
  replyTo: string;         // for announce routing
  accountId: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  cost?: number;
  abortController?: AbortController;
  timeoutTimer?: ReturnType<typeof setTimeout>;
};

private spawnedTasks = new Map<string, SpawnedTask>();
```

## Files to Modify

1. **`agent-mcp.ts`** — Add `spawn_task` and `task_status` tools
2. **`agent-runner.ts`** — Add `spawnTask()`, `getTaskStatus()`, task tracking, background execution logic, announce mechanism
3. **`config.ts`** — Add `maxChildrenPerSession` and `taskTimeoutSeconds` config options

## What This Does NOT Include

- Nested spawning (sub-agents can't spawn sub-agents) — keep it simple for v1
- `sessions_send` (cross-session messaging) — future enhancement
- `sessions_history` (reading another session's transcript) — future enhancement
- Task cancellation via user command (`/cancel`) — future enhancement

## System Prompt Addition

Add to DEFAULT_SYSTEM_PROMPT:

```
IMPORTANT - Task delegation:
- For tasks that will take many steps (file analysis, refactoring, research), use spawn_task to delegate.
- After spawning, tell the user what you delegated and that they can keep chatting.
- For simple questions or quick responses, reply directly — don't over-delegate.
- Use task_status to check on running tasks if the user asks.
```
