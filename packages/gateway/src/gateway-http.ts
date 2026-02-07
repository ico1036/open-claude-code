import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ChannelManager } from "./channel-manager.js";
import type { MessageRouter } from "./message-router.js";
import type { MessageStore } from "./message-store.js";

export function createHttpApp(deps: {
  channelManager: ChannelManager;
  messageRouter: MessageRouter;
  store: MessageStore;
}) {
  const { channelManager, messageRouter, store } = deps;
  const app = new Hono();

  // Middleware
  app.use("*", cors({ origin: "*" }));

  // Health check
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });

  // Gateway status
  app.get("/api/status", (c) => {
    const channels = channelManager.getStatus();
    return c.json({
      status: "running",
      uptime: process.uptime(),
      channels,
      registeredAdapters: channelManager.getRegisteredChannels(),
    });
  });

  // --- Channel endpoints ---

  // List all channels
  app.get("/api/channels", (c) => {
    const statuses = channelManager.getStatus();
    return c.json({ channels: statuses });
  });

  // Get specific channel status
  app.get("/api/channels/:channelId", (c) => {
    const channelId = c.req.param("channelId");
    const statuses = channelManager.getStatus(channelId);
    return c.json({ channel: channelId, accounts: statuses });
  });

  // Connect a channel
  app.post("/api/channels/:channelId/connect", async (c) => {
    const channelId = c.req.param("channelId");
    const body = await c.req.json().catch(() => ({}));
    const { accountId, config } = body as { accountId?: string; config?: Record<string, unknown> };

    try {
      const status = await channelManager.startChannel(channelId, accountId, config);
      return c.json({ status: "connected", channel: status });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // Disconnect a channel
  app.post("/api/channels/:channelId/disconnect", async (c) => {
    const channelId = c.req.param("channelId");
    const body = await c.req.json().catch(() => ({}));
    const { accountId } = body as { accountId?: string };

    try {
      await channelManager.stopChannel(channelId, accountId);
      return c.json({ status: "disconnected" });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // --- Message endpoints ---

  // List messages
  app.get("/api/messages", (c) => {
    const channel = c.req.query("channel");
    const from = c.req.query("from");
    const since = c.req.query("since");
    const limit = c.req.query("limit");

    const messages = messageRouter.listMessages({
      channel: channel ?? undefined,
      from: from ?? undefined,
      since: since ? parseInt(since, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return c.json({ messages });
  });

  // Send a message
  app.post("/api/messages/send", async (c) => {
    const body = await c.req.json();
    const { channel, to, text, replyToId, accountId } = body as {
      channel: string;
      to: string;
      text: string;
      replyToId?: string;
      accountId?: string;
    };

    if (!channel || !to || !text) {
      return c.json({ error: "channel, to, and text are required" }, 400);
    }

    const result = await messageRouter.send(
      channel,
      { to, text, replyToId },
      accountId,
    );

    return c.json(result, result.success ? 200 : 500);
  });

  // List conversations
  app.get("/api/conversations", (c) => {
    const channel = c.req.query("channel");
    const limit = c.req.query("limit");

    const conversations = messageRouter.listConversations({
      channel: channel ?? undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return c.json({ conversations });
  });

  // --- Dashboard ---
  app.get("/", (c) => {
    return c.html(DASHBOARD_HTML);
  });

  return app;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaudeCode Gateway</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f23; color: #e0e0e0; }
    .container { max-width: 960px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1a1a2e; border-radius: 12px; padding: 20px; border: 1px solid #2a2a4a; }
    .card h3 { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .card .value { font-size: 28px; font-weight: 600; color: #fff; }
    .card .value.green { color: #2ecc71; }
    .card .value.red { color: #e74c3c; }
    .card .value.blue { color: #3498db; }
    .section { background: #1a1a2e; border-radius: 12px; padding: 20px; border: 1px solid #2a2a4a; margin-bottom: 16px; }
    .section h2 { font-size: 16px; margin-bottom: 16px; color: #fff; }
    .channel-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #2a2a4a; }
    .channel-row:last-child { border-bottom: none; }
    .channel-name { font-weight: 600; font-size: 15px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge.on { background: #2ecc7133; color: #2ecc71; }
    .badge.off { background: #e74c3c33; color: #e74c3c; }
    .badge.reg { background: #3498db33; color: #3498db; }
    .msg-row { padding: 10px 0; border-bottom: 1px solid #2a2a4a; font-size: 14px; }
    .msg-row:last-child { border-bottom: none; }
    .msg-meta { color: #888; font-size: 12px; margin-bottom: 4px; }
    .msg-text { color: #e0e0e0; }
    .empty { color: #666; font-style: italic; padding: 12px 0; }
    .actions { display: flex; gap: 8px; }
    button { background: #3498db; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    button:hover { background: #2980b9; }
    button.danger { background: #e74c3c; }
    button.danger:hover { background: #c0392b; }
    .refresh-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .auto-refresh { color: #888; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="refresh-bar">
      <div>
        <h1>OpenClaudeCode Gateway</h1>
        <p class="subtitle">Multi-channel messaging gateway for Claude Code</p>
      </div>
      <div class="auto-refresh" id="timer">Refreshing...</div>
    </div>
    <div class="grid" id="stats"></div>
    <div class="section" id="channels-section">
      <h2>Channels</h2>
      <div id="channels"></div>
    </div>
    <div class="section">
      <h2>Recent Messages</h2>
      <div id="messages"></div>
    </div>
  </div>
  <script>
    let countdown = 5;
    function fmt(ts) { return ts ? new Date(ts).toLocaleString() : '-'; }
    function dur(s) {
      if (s < 60) return Math.floor(s) + 's';
      if (s < 3600) return Math.floor(s/60) + 'm ' + Math.floor(s%60) + 's';
      return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
    }
    async function refresh() {
      try {
        const [status, msgs] = await Promise.all([
          fetch('/api/status').then(r=>r.json()),
          fetch('/api/messages?limit=20').then(r=>r.json()),
        ]);
        const s = status;
        document.getElementById('stats').innerHTML =
          '<div class="card"><h3>Status</h3><div class="value green">Running</div></div>' +
          '<div class="card"><h3>Uptime</h3><div class="value">' + dur(s.uptime) + '</div></div>' +
          '<div class="card"><h3>Adapters</h3><div class="value blue">' + (s.registeredAdapters||[]).length + '</div></div>' +
          '<div class="card"><h3>Active Channels</h3><div class="value">' +
            (s.channels||[]).filter(c=>c.connected).length + '/' + (s.channels||[]).length + '</div></div>';
        const adapters = s.registeredAdapters || [];
        const running = new Map((s.channels||[]).map(c => [c.channel + ':' + c.accountId, c]));
        let chHtml = '';
        for (const a of adapters) {
          const key = a + ':default';
          const ch = running.get(key);
          const connected = ch && ch.connected;
          const isRunning = ch && ch.running;
          chHtml += '<div class="channel-row">' +
            '<div><span class="channel-name">' + a.charAt(0).toUpperCase() + a.slice(1) + '</span> ' +
            (connected ? '<span class="badge on">Connected</span>' :
             isRunning ? '<span class="badge off">Disconnected</span>' :
             '<span class="badge reg">Registered</span>') +
            (ch && ch.lastError ? '<br><span style="color:#e74c3c;font-size:12px">' + ch.lastError + '</span>' : '') +
            '</div></div>';
        }
        document.getElementById('channels').innerHTML = chHtml || '<div class="empty">No adapters loaded</div>';
        let mHtml = '';
        for (const m of (msgs.messages||[])) {
          mHtml += '<div class="msg-row"><div class="msg-meta">' +
            m.channel + ' | ' + (m.from?.name || m.from?.id || '?') + ' | ' + fmt(m.timestamp) +
            '</div><div class="msg-text">' + (m.text || '(media)').replace(/</g,'&lt;') + '</div></div>';
        }
        document.getElementById('messages').innerHTML = mHtml || '<div class="empty">No messages yet</div>';
      } catch(e) {
        document.getElementById('stats').innerHTML =
          '<div class="card"><h3>Status</h3><div class="value red">Offline</div></div>';
      }
      countdown = 5;
    }
    refresh();
    setInterval(() => {
      countdown--;
      if (countdown <= 0) { refresh(); }
      document.getElementById('timer').textContent = 'Auto-refresh in ' + countdown + 's';
    }, 1000);
  </script>
</body>
</html>`;

