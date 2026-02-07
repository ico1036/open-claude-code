---
name: telegram-setup
description: Guide for setting up a Telegram bot connection
---

# Telegram Bot Setup Guide

## Prerequisites
- A Telegram account
- Access to @BotFather on Telegram

## Steps

### 1. Create a Bot with @BotFather
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the prompts to set a name and username
4. Copy the **bot token** (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### 2. Configure Bot Settings (Recommended)
In @BotFather:
- `/setprivacy` → Disable (to receive all group messages)
- `/setjoingroups` → Enable (to allow adding to groups)
- `/setcommands` → Set bot commands if needed

### 3. Connect via Claude Code
Use the `channel_connect` tool:
```
channel_connect channel=telegram config={"botToken": "YOUR_BOT_TOKEN"}
```

### 4. Verify Connection
```
channel_status channel=telegram
```

## Troubleshooting
- **401 Unauthorized**: Bot token is invalid or revoked. Create a new token via @BotFather.
- **409 Conflict**: Another instance is polling. Stop other bot instances first.
- **No messages received**: Check that privacy mode is disabled for group messages.

## Security Notes
- Never share your bot token publicly
- Use allowlists to restrict who can interact with the bot
- Bot tokens can be revoked via @BotFather with `/revoke`
