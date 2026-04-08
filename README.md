<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="node" />
  <img src="https://img.shields.io/badge/Agent%20SDK-0.2.0-purple" alt="agent-sdk" />
  <img src="https://img.shields.io/badge/telegram-tested-blue?logo=telegram" alt="telegram" />
</p>

<p align="center">
  <b>English</b> | <a href="./README_KR.md">한국어</a>
</p>

# OpenClaudeCode

Turn **Claude Code** into an autonomous, multi-channel messaging AI assistant with self-evolving persona, long-term memory, and **non-blocking background task execution**.

Connect Telegram, WhatsApp, or Discord — Claude responds automatically, forms its own personality through conversation, delegates heavy work to background sub-agents, and remembers everything across sessions.

> **Status**: Telegram fully tested in production. WhatsApp and Discord adapters implemented but untested.

Built on the official **Claude Agent SDK** — uses your Claude Max subscription through `query()`. No API key hacking, no ToS violations, no ban risk.

---

## Highlights

- **Multi-channel**: Telegram, WhatsApp, Discord from a single gateway
- **Self-evolving persona**: Bot negotiates its own name, discovers your preferences, evolves personality naturally
- **Long-term memory**: FTS5 full-text search + persona files + daily logs — survives restarts
- **Background task spawning** (v0.2.0): Delegate long-running work to sub-agents while keeping the main conversation responsive
- **Session intelligence** (v0.3.0): Idle timeout, memory flush before compaction, interrupt commands
- **Multi-tier memory** (v0.3.0): Global + per-channel memory scopes with automatic context preservation
- **Subagents**: translator (Haiku), researcher (Haiku), coder (Sonnet), plus custom agents via `AGENTS.md`
- **Skills system**: Drop `SKILL.md` files into `~/.openclaudecode/skills/` to extend behavior
- **Zero config**: `pnpm install && pnpm build` — tell Claude your bot token in English, done

---

## What's New in v0.2.0

### Non-Blocking Task Spawning (`spawn_task`)

Inspired by [OpenClaw](https://github.com/nicholasgriffintn/openclaw)'s `sessions_spawn` pattern. The main agent can now delegate long-running work to background sub-agents **without blocking the conversation**.

```
User: "Review the codebase and summarize the architecture. Meanwhile let's chat."
Bot:  "Kicked off a code review in the background. What do you want to talk about?"

User: "What's for lunch?"
Bot:  "How about ramen? 🍜"       ← responds instantly while coder works

[30 seconds later, auto-announce]
Bot:  "[Task completed: coder]
       The project has 6 packages: gateway, adapter-core, adapter-telegram..."
```

**How it works:**
- `spawn_task` returns immediately with `{ status: "accepted", taskId }`
- Sub-agent runs in an isolated session (own context, own token budget)
- On completion, result is auto-announced to the chat
- Main agent stays responsive — handles new messages while tasks run
- `task_status` tool to check progress at any time

**Concurrency controls:**
| Setting | Default | Description |
|---------|---------|-------------|
| `maxChildrenPerSession` | 3 | Max background tasks per conversation |
| `taskTimeoutSeconds` | 300 | Auto-abort safety valve |
| `maxConcurrent` | 3 | Global concurrent session limit (shared) |

**Sub-agent isolation:**
- No `spawn_task` (no recursive spawning)
- No `write_persona` (can't modify bot personality)
- Full access to messaging, memory search, and file tools

---

## Quick Start

### Prerequisites

- **Node.js** 22+
- **pnpm** (`npm install -g pnpm`)
- **Claude Code** CLI installed and logged in
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### Install

```bash
git clone https://github.com/ico1036/open-claude-code.git
cd open-claude-code
pnpm install
pnpm build
```

### Connect Telegram

```bash
# Start the gateway daemon
node packages/gateway/dist/gateway-daemon.js
```

In a separate terminal:

```bash
cd open-claude-code
claude
```

Tell Claude:

```
Connect my Telegram bot with token 7123456789:AAHxxxxxxx
Enable auto-reply for Telegram
```

Send a message to your bot. That's it.

### Auto-start on Reboot (macOS)

```bash
pnpm daemon:install
```

### WhatsApp / Discord

```
# WhatsApp — scan QR code from daemon logs
Connect WhatsApp

# Discord — bot token from Developer Portal
Connect Discord with bot token YOUR_TOKEN
```

---

## Architecture

```
[Telegram / WhatsApp / Discord]
         | messages
         v
[Channel Adapters] ─── grammy / Baileys / discord.js
         |
         v
[Gateway Daemon] ─── Node.js background process
    |
    |── Message Store (SQLite)
    |── Memory Manager (FTS5)
    |── Channel Manager
    |── Message Router
    |── HTTP Server (:19280)
    |── IPC Server (Unix socket → Claude Code MCP)
    |
    └── AgentRunner
         |
         |── Agent SDK query()
         |── In-process MCP (9 tools)
         |── Session Resume (per-conversation)
         |── Persona Loader (SOUL + IDENTITY + USER + AGENTS)
         |── Memory (MEMORY.md + daily logs + FTS5)
         |── Subagents (translator / researcher / coder)
         |── Task Spawner ← NEW in v0.2.0
         |    |── spawn_task (non-blocking)
         |    |── task_status (query)
         |    |── Auto-announce on completion
         |    └── Concurrency + timeout controls
         |── Hooks (PreToolUse / PostToolUse)
         └── Skills (SKILL.md loader)
```

### Message Flow

1. User sends a message on Telegram
2. Adapter receives → Channel Manager → stored in SQLite
3. AgentRunner checks `autoReply` + `allowFrom`
4. Batches rapid messages (1.5s debounce)
5. Loads persona (4 files) + MEMORY.md + skills into system prompt
6. Calls `query()` with session resume
7. Claude decides: reply directly, or `spawn_task` for heavy work
8. Replies via `send_message` → Router → Adapter → user
9. Background tasks announce results when done
10. Everything logged to `memory/YYYY-MM-DD.md` + FTS5 index

---

## Persona System

```
~/.openclaudecode/
├── SOUL.md       # Personality, tone, behavioral rules (self-modifying)
├── IDENTITY.md   # Bot's name and role
├── USER.md       # User's name, preferences (auto-created on first chat)
├── AGENTS.md     # Custom subagent definitions
├── MEMORY.md     # Long-term facts (capped at 200 lines)
├── memory/       # Daily conversation logs
└── skills/       # SKILL.md extensions
```

On first conversation the bot runs an onboarding flow: asks your name, negotiates its own name, discovers your style preferences, and saves everything via `write_persona`. The persona evolves naturally over time.

---

## MCP Tools

### Interactive (Claude Code → Gateway, 13 tools)

| Tool | Description |
|------|-------------|
| `gateway_status` | Daemon status, uptime, channels |
| `gateway_start` | Start daemon |
| `channel_connect` | Connect a channel |
| `channel_disconnect` | Disconnect a channel |
| `channel_status` | Channel connection state |
| `send_message` | Send message to recipient |
| `list_messages` | List messages (filtered) |
| `list_conversations` | List active conversations |
| `configure_channel` | Update channel config |
| `auto_responder_status` | Agent runner status |
| `auto_responder_toggle` | Enable/disable agent |
| `memory_search` | Full-text search past conversations |
| `memory_stats` | Memory index statistics |

### In-process (Agent → Gateway, 9 tools)

| Tool | Description |
|------|-------------|
| `send_message` | Reply to user |
| `list_messages` | Read conversation history |
| `list_conversations` | List active chats |
| `memory_search` | Search past conversations |
| `memory_stats` | Memory statistics |
| `read_persona` | Read persona/memory files |
| `write_persona` | Update persona/memory files |
| **`spawn_task`** | Delegate work to background sub-agent |
| **`task_status`** | Check spawned task progress |

---

## Subagents

| Name | Model | Purpose |
|------|-------|---------|
| translator | Haiku | Language translation |
| researcher | Haiku | Web search and info gathering |
| coder | Sonnet | Code generation and analysis |

### Custom Agents

Define in `~/.openclaudecode/AGENTS.md`:

````markdown
```agent name=my-agent model=haiku
description: What this agent does
tools: Read, Grep, Bash
---
System prompt for the agent
```
````

---

## Configuration

`~/.openclaudecode/config.yaml`:

```yaml
gateway:
  port: 19280
  agentRunner:
    model: "claude-sonnet-4-5-20250929"
    maxConcurrent: 3
    debounceMs: 1500
    maxTurns: 10
    maxBudgetPerMessage: 999
    maxChildrenPerSession: 3    # max background tasks per conversation
    taskTimeoutSeconds: 300     # auto-abort timeout for spawned tasks
    sessionIdleMinutes: 120     # auto-expire stale sessions (0 = never)

channels:
  telegram:
    botToken: "YOUR_TOKEN"
    autoReply: true
    allowFrom: []  # empty = allow all
```

> `maxBudgetPerMessage` is the per-message cost limit (USD) enforced by the Agent SDK. Claude Max subscribers can safely keep the default since billing is subscription-based.

---

## Troubleshooting

Ask Claude Code directly — it can diagnose most issues:

```
Check gateway status
Show Telegram connection status
List recent messages
```

| Symptom | Fix |
|---------|-----|
| Bot not responding | Check `auto_responder_status` — autoReply might be off |
| "Gateway not running" | `Start the gateway` or run the daemon manually |
| Telegram disconnected | `Reconnect Telegram` |
| Telegram `getMe` error | VPN may block `api.telegram.org` — disable or split tunnel |
| Restrict to certain users | `Add user123 to Telegram allowFrom` |
| Reset conversation | Send `/new` or `/reset` in chat |
| Stop current task | Send `/stop`, `/cancel`, `됐어`, or `그만` |
| Change persona | Ask naturally, or edit `~/.openclaudecode/SOUL.md` |
| Background task stuck | Auto-aborts after `taskTimeoutSeconds` (default 300s) |
| Stale context after long idle | Auto-expires after `sessionIdleMinutes` (default 120) |

### Dashboard

`http://127.0.0.1:19280` — real-time status.

---

## vs OpenClaw

| | OpenClaw | OpenClaudeCode |
|---|---------|----------------|
| **Scope** | 13+ channels, full AI OS | 6 packages, lightweight |
| **Agent engine** | Custom-built | **Claude Agent SDK** (`query()`) |
| **Task spawning** | `sessions_spawn` + orchestrator | `spawn_task` + auto-announce |
| **Memory** | Vector + BM25 hybrid | FTS5 + persona files + daily logs |
| **Persona** | SOUL.md, manual | Self-evolving via `write_persona` |
| **Subagents** | Custom registry + spawn mgmt | Agent SDK `agents` + custom AGENTS.md |
| **Channels** | 13+ | 3 (Telegram, WhatsApp, Discord) |
| **Setup** | Nix/Docker, complex config | `pnpm install && pnpm build` |
| **Auth** | API keys / self-managed | Claude Max subscription (no key needed) |
| **Security** | Docker sandbox, DM pairing | allowFrom whitelist, hook policies |

**TL;DR**: OpenClaw builds everything from scratch. OpenClaudeCode gets the **same core features with far less code** on top of the official Agent SDK.

---

## Changelog

### v0.3.0 (2026-04-08)
- **Session idle timeout**: Auto-expire stale sessions (default 2h), configurable via `sessionIdleMinutes`
- **Token tracking**: Per-session input/output token and cost accumulation, persisted to disk
- **Memory flush**: Automatic context preservation to MEMORY.md when tokens approach 160k (80% of context window)
- **Message chunking**: Markdown-aware splitting at 4000 chars with code fence preservation
- **Compact envelope**: `[telegram Ryan +5m]` format with elapsed time for temporal awareness
- **3-tier memory**: Global (`user`) + per-channel (`channel`) memory scopes via `read_persona`/`write_persona` scope parameter
- **Interrupt mode**: `/stop`, `/cancel`, `됐어`, `그만` to abort active sessions immediately

### v0.2.0 (2026-04-07)
- **`spawn_task`**: Non-blocking background sub-agent execution
- **`task_status`**: Query spawned task progress
- **Auto-announce**: Task results pushed to chat on completion
- **Concurrency controls**: `maxChildrenPerSession`, `taskTimeoutSeconds`
- Sub-agent isolation (no recursive spawn, no persona write)

### v0.1.0 (2026-03-28)
- Initial release
- Gateway daemon with Telegram/WhatsApp/Discord adapters
- Agent SDK integration with session resume
- Multi-file persona system (SOUL, IDENTITY, USER, AGENTS)
- FTS5 memory search + daily logs
- Built-in subagents (translator, researcher, coder)
- Skills system (SKILL.md)
- Hook-based message policies

---

## License

MIT License

Copyright (c) 2026 Jiwoong Kim ([@ico1036](https://github.com/ico1036))

Open source. Free to use, modify, and distribute.
