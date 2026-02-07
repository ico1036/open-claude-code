---
name: whatsapp-setup
description: Guide for setting up a WhatsApp connection
---

# WhatsApp Setup Guide

## Prerequisites
- A phone with WhatsApp installed and active
- The phone must stay connected to the internet

## Steps

### 1. Start the Connection
Use the `channel_connect` tool:
```
channel_connect channel=whatsapp
```

### 2. Scan QR Code
- The gateway will generate a QR code
- Open WhatsApp on your phone
- Go to **Settings** → **Linked Devices** → **Link a Device**
- Scan the QR code displayed

### 3. Verify Connection
```
channel_status channel=whatsapp
```

The connection persists across gateway restarts. Re-pairing is only needed if you log out or the session expires.

## How It Works
- Uses the WhatsApp Web multi-device protocol via Baileys
- Authentication state is stored at `~/.openclaudecode/whatsapp-auth/`
- Messages are received in real-time via WebSocket
- Supports text, images, documents, and audio

## Troubleshooting
- **QR code expired**: Restart the connection to generate a new QR
- **Logged out**: Your phone may have disconnected the linked device. Re-scan the QR.
- **No messages**: Ensure the phone has internet connectivity
- **Connection drops**: The gateway auto-reconnects. Check `channel_status` for details.

## Security Notes
- Auth credentials are stored locally on your machine
- Use allowlists to control who can send messages
- You can disconnect at any time via `channel_disconnect channel=whatsapp`
- Removing the linked device from your phone also disconnects
