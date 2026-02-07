# OpenClaudeCode

**v0.1.0**

An open-source project that turns Claude Code into a multi-channel messaging AI assistant with self-evolving persona and long-term memory.

Connect Telegram, WhatsApp, or Discord and Claude will automatically respond to messages, form its own personality through conversation, and remember everything across sessions.

Built on the official **Claude Agent SDK** — uses your Claude Max subscription legitimately through `query()`. No API key hacking, no ToS violations, no ban risk.

## Why This Exists

Inspired by [OpenClaw](https://github.com/nicholasgriffintn/openclaw), which builds its own agent engine from scratch. OpenClaudeCode takes a different approach: instead of reimplementing session management, tool routing, and sandboxing, it sits on top of the **official Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). This means every feature — session resume, subagents, hooks, cost tracking — comes from Anthropic's own SDK, used exactly as intended. No workarounds, no reverse engineering, no risk of getting your account banned.

---

## Quick Start

### 1. Prerequisites

- **Node.js** 22+
- **pnpm** (`npm install -g pnpm`)
- **Claude Code** CLI installed and logged in (`claude --version` to verify)
- **Telegram Bot Token** (see step 3)

### 2. Install

```bash
git clone https://github.com/ico1036/open-claude-code.git
cd open-claude-code
pnpm install
pnpm -r build
```

### 3. Create a Telegram Bot

1. Open Telegram, search `@BotFather`
2. Send `/newbot` → pick a name → copy the bot token

### 4. Run

```bash
# Start the daemon
node packages/gateway/dist/gateway-daemon.js
```

In a separate terminal, open Claude Code:

```bash
cd open-claude-code
claude
```

Tell Claude:

```
Connect my Telegram bot with token 7123456789:AAHxxxxxxx
```

```
Enable auto-reply for Telegram
```

Done. Send a message to your Telegram bot and Claude will respond automatically.

### 5. Auto-start on Reboot (Optional)

```bash
pnpm daemon:install
```

Registers as a macOS launchd service. Starts on login, restarts on crash.

### WhatsApp / Discord

```
# WhatsApp — QR code appears in daemon logs, scan to connect
Connect WhatsApp

# Discord — get a bot token from Developer Portal first
Connect Discord with bot token YOUR_TOKEN
```

---

## Troubleshooting

When something goes wrong, just ask Claude Code. The agent will diagnose it.

```
Check gateway status
```

```
Show Telegram connection status
```

```
List recent messages
```

### Common Issues

| Symptom | Fix |
|---------|-----|
| Bot not responding | `Check auto-responder status` — autoReply might be off |
| "Gateway daemon is not running" | `Start the gateway` or `node packages/gateway/dist/gateway-daemon.js` |
| Telegram disconnected | `Reconnect Telegram` |
| Only respond to certain users | `Add user123 to Telegram allowFrom` |
| Reset conversation | Send `/new` or `/reset` in Telegram |
| Change persona | Ask naturally in Telegram, or edit `~/.openclaudecode/SOUL.md` directly |

### Dashboard

Open `http://127.0.0.1:19280` in your browser for real-time status.

---

## vs OpenClaw

| | OpenClaw | OpenClaudeCode |
|---|---------|----------------|
| **Scope** | 13+ channels, full-stack AI OS | 6 packages, lightweight, focused |
| **Agent engine** | Custom-built (sessions, routing, sandbox) | **Claude Agent SDK** native (`query()`) |
| **Memory** | Vector embeddings + BM25 hybrid search | FTS5 + persona files + daily logs (local, no external deps) |
| **Persona** | SOUL.md, manually edited | Bot **evolves its own persona through conversation** (`write_persona`) |
| **Subagents** | Custom registry + spawn management | Agent SDK `agents` option (translator, researcher, coder) |
| **Channels** | 13+ (Teams, Matrix, Zalo, iMessage...) | 3 (Telegram, WhatsApp, Discord) — essentials only |
| **Config** | JSON schema + Doctor tool | YAML, or just tell Claude Code in plain English |
| **Security** | DM pairing, Docker sandbox, tool policies | allowFrom whitelist, hook-based message policies |
| **Auth** | API keys or self-managed OAuth | Claude Max subscription, auto-authenticated (no key needed) |
| **Setup** | Nix/Docker/manual, complex config | `pnpm install && pnpm -r build` — that's it |
| **Extensibility** | Plugin SDK, ClawHub registry | Skills (`SKILL.md`), custom agents in AGENTS.md |

**In short**: OpenClaw builds everything from scratch. OpenClaudeCode builds on the Agent SDK to get the **same core features with far less code** — and zero ban risk.

---

## How It Works

### Architecture

```
[Telegram/WhatsApp/Discord Users]
         | messages
         v
[Channel Adapters] --- grammy / Baileys / discord.js
         |
         v
[Gateway Daemon] --- Node.js background process
    |
    |-- Message Store (SQLite) --- persists all messages
    |-- Memory Manager (FTS5) --- full-text search over past conversations
    |-- Channel Manager --- adapter lifecycle
    |-- Message Router --- outbound message delivery
    |-- HTTP Server --- dashboard + REST API
    |-- IPC Server --- Claude Code MCP connection (Unix socket)
    |
    +-- AgentRunner --- core agent engine
         |
         |-- Agent SDK query() --- Claude API calls
         |-- In-process MCP (7 tools) --- zero IPC overhead
         |-- Session Resume --- per-conversation continuity
         |-- Persona Loader --- SOUL + IDENTITY + USER + AGENTS
         |-- Memory --- MEMORY.md + daily logs
         |-- Subagents --- translator / researcher / coder
         |-- Hooks --- PreToolUse (policy) / PostToolUse (logging)
         +-- Skills --- SKILL.md loader
```

### Message Flow

1. User sends a message on Telegram
2. Channel Adapter receives it, passes to Channel Manager
3. Message stored in SQLite
4. AgentRunner picks it up: checks autoReply + allowFrom
5. Batches messages from the same user for 1.5s (debounce)
6. Assembles system prompt from 4 persona files + MEMORY.md + skills
7. Calls Agent SDK `query()` with session resume
8. Claude uses `send_message` tool to reply → Message Router → Adapter → user
9. Conversation logged to `memory/YYYY-MM-DD.md`

### Persona System

```
~/.openclaudecode/
├── SOUL.md       # Personality, tone, behavioral rules (bot can self-modify)
├── IDENTITY.md   # Name, role
├── USER.md       # User's name, preferences (auto-created during conversation)
├── AGENTS.md     # Custom subagent definitions
└── MEMORY.md     # Long-term facts (injected into system prompt, capped at 200 lines)
```

On first conversation, the bot asks the user's name, negotiates its own name, discovers personality preferences through natural back-and-forth, and persists everything via `write_persona`. The persona evolves naturally as conversations accumulate.

### Memory Layers

| Layer | Storage | Purpose |
|-------|---------|---------|
| Session context | Agent SDK internal | Current conversation continuity |
| Persona files | `~/.openclaudecode/*.md` | Identity, personality, user info (loaded at session start) |
| Daily logs | `memory/YYYY-MM-DD.md` | Chronological conversation record |
| Long-term memory | `MEMORY.md` | Important facts (bot writes these itself) |
| Full-text search | SQLite FTS5 | Keyword search across all past conversations |

### MCP Tools

**Interactive (used from Claude Code, 13 tools)**:
gateway_status, gateway_start, channel_connect, channel_disconnect, channel_status, send_message, list_messages, list_conversations, configure_channel, auto_responder_status, auto_responder_toggle, memory_search, memory_stats

**In-process (used by the agent, 7 tools)**:
send_message, list_messages, list_conversations, memory_search, memory_stats, read_persona, write_persona

### Subagents

| Name | Model | Purpose |
|------|-------|---------|
| translator | Haiku | Language translation |
| researcher | Haiku | Web search and info gathering |
| coder | Sonnet | Code generation and analysis |

Define custom agents in AGENTS.md:

````markdown
```agent name=my-agent model=haiku
description: What this agent does
tools: Read, Grep, Bash
---
System prompt for the agent
```
````

### Configuration

`~/.openclaudecode/config.yaml`:

```yaml
gateway:
  port: 19280

agentRunner:
  model: "claude-sonnet-4-5-20250929"
  maxConcurrent: 3
  debounceMs: 1500
  maxTurns: 10
  maxBudgetPerMessage: 0.50

channels:
  telegram:
    botToken: "YOUR_TOKEN"
    autoReply: true
    allowFrom: []      # empty = allow all users
```

---

## License

MIT License

Copyright (c) 2026 Jiwoong Kim ([@ico1036](https://github.com/ico1036))

Open source. Free to use, modify, and distribute.
