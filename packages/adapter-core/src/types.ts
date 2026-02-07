// Channel identifier
export type ChannelId = "whatsapp" | "telegram" | "discord" | (string & {});

// Channel metadata
export type ChannelMeta = {
  id: ChannelId;
  label: string;
  description: string;
  icon?: string;
};

// Channel capabilities
export type ChannelCapabilities = {
  text: boolean;
  media: boolean;
  reactions: boolean;
  threads: boolean;
  edit: boolean;
  delete: boolean;
  polls: boolean;
  voice: boolean;
};

// Inbound message from external platform
export type ChannelMessage = {
  id: string;
  channel: ChannelId;
  accountId: string;
  from: {
    id: string;
    name?: string;
    username?: string;
  };
  to?: {
    id: string;
    name?: string;
  };
  chatType: "dm" | "group" | "channel";
  text?: string;
  media?: MessageMedia[];
  replyToId?: string;
  threadId?: string;
  timestamp: number;
  raw?: unknown;
};

export type MessageMedia = {
  type: "image" | "video" | "audio" | "document" | "sticker";
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  caption?: string;
};

// Outbound message to send
export type OutboundMessage = {
  to: string;
  text?: string;
  media?: MessageMedia[];
  replyToId?: string;
  threadId?: string;
};

// Result of sending a message
export type SendResult = {
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: number;
};

// Channel configuration
export type ChannelConfig = {
  enabled: boolean;
  accountId: string;
  [key: string]: unknown;
};

// Channel account status snapshot
export type ChannelAccountSnapshot = {
  accountId: string;
  channel: ChannelId;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  connected?: boolean;
  running?: boolean;
  lastConnectedAt?: number | null;
  lastDisconnectedAt?: number | null;
  lastMessageAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
};
