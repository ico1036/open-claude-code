---
name: discord-setup
description: Guide for setting up a Discord bot connection
---

# Discord Bot Setup Guide

## Prerequisites
- A Discord account
- Access to the Discord Developer Portal

## Steps

### 1. Create a Discord Application
1. Go to https://discord.com/developers/applications
2. Click **New Application**, give it a name
3. Go to the **Bot** section
4. Click **Add Bot** (or it may already exist)
5. Under **Token**, click **Reset Token** and copy the token

### 2. Configure Bot Intents
In the Bot settings page, enable these **Privileged Gateway Intents**:
- **Message Content Intent** (required for reading message text)
- **Server Members Intent** (optional, for member info)

### 3. Invite Bot to Your Server
1. Go to **OAuth2** → **URL Generator**
2. Select scopes: `bot`
3. Select permissions: `Send Messages`, `Read Message History`, `View Channels`
4. Copy the generated URL and open it in a browser
5. Select your server and authorize

### 4. Connect via Claude Code
```
channel_connect channel=discord config={"botToken": "YOUR_BOT_TOKEN"}
```

### 5. Verify Connection
```
channel_status channel=discord
```

## Sending Messages
Discord messages require a **channel ID** as the recipient:
- Right-click a channel → **Copy Channel ID** (enable Developer Mode in Discord settings)
- Use this ID as the `to` parameter in `send_message`

## Troubleshooting
- **Missing intents**: Enable Message Content Intent in the Developer Portal
- **Missing permissions**: Re-invite the bot with correct permissions
- **Cannot see messages**: Bot needs `Read Message History` and `View Channel` permissions
- **Token invalid**: Reset the token in the Developer Portal

## Security Notes
- Never share your bot token
- Use minimal permissions (principle of least privilege)
- Bot tokens can be reset in the Developer Portal
