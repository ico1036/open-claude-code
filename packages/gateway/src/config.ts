import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".openclaudecode");
const CONFIG_FILE = join(DATA_DIR, "config.yaml");

// Channel config schema
const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(true),
  accountId: z.string().default("default"),
  botToken: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  autoReply: z.boolean().default(false),
});

// Agent runner config schema (replaces auto-responder)
const AgentRunnerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Claude model to use (default: claude-sonnet-4-5-20250929) */
  model: z.string().default("claude-sonnet-4-5-20250929"),
  /** Max concurrent agent sessions */
  maxConcurrent: z.number().default(3),
  /** Debounce ms - wait before responding (batch rapid messages) */
  debounceMs: z.number().default(1500),
  /** Max conversation turns per invocation (0 = unlimited) */
  maxTurns: z.number().default(0),
  /** Max budget in USD per message invocation */
  maxBudgetPerMessage: z.number().default(999),
  /** System prompt override (optional) */
  systemPrompt: z.string().optional(),
  /** Path to persona file (optional, e.g. ~/.openclaudecode/persona.md) */
  personaFile: z.string().optional(),
});

// Legacy auto-responder config (kept for backward compat parsing)
const AutoResponderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  claudePath: z.string().optional(),
  maxConcurrent: z.number().default(3),
  debounceMs: z.number().default(1500),
  systemPrompt: z.string().optional(),
  maxHistoryMessages: z.number().default(10),
});

// Gateway config schema
const GatewayConfigSchema = z.object({
  port: z.number().default(19280),
  host: z.string().default("127.0.0.1"),
  autoStart: z.boolean().default(true),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  agentRunner: AgentRunnerConfigSchema.default(() => AgentRunnerConfigSchema.parse({})),
  /** @deprecated use agentRunner instead */
  autoResponder: AutoResponderConfigSchema.default(() => AutoResponderConfigSchema.parse({})).optional(),
});

// Root config schema
export const ConfigSchema = z.object({
  gateway: GatewayConfigSchema.default(() => GatewayConfigSchema.parse({})),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function getDataDir(): string {
  return DATA_DIR;
}

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getSocketPath(): string {
  return join(DATA_DIR, "gateway.sock");
}

export function getPidFile(): string {
  return join(DATA_DIR, "gateway.pid");
}

export function getDbPath(): string {
  return join(DATA_DIR, "messages.db");
}

export function getProjectDir(): string {
  // The project root is 3 levels up from packages/gateway/src/
  // But at runtime (dist/), it's 2 levels up from packages/gateway/dist/
  // Use the DATA_DIR approach: store project dir in config or env
  return process.env.OCC_PROJECT_DIR ?? join(DATA_DIR, "project");
}

export function loadConfig(): AppConfig {
  ensureDataDir();

  if (!existsSync(CONFIG_FILE)) {
    const defaults = ConfigSchema.parse({});
    saveConfig(defaults);
    return defaults;
  }

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    // Simple YAML-like key=value parsing for now; upgrade to yaml lib later
    const data = parseSimpleYaml(raw);
    return ConfigSchema.parse(data);
  } catch {
    return ConfigSchema.parse({});
  }
}

export function saveConfig(config: AppConfig): void {
  ensureDataDir();
  const content = serializeSimpleYaml(config);
  writeFileSync(CONFIG_FILE, content, "utf-8");
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const merged = {
    ...current,
    ...patch,
    gateway: { ...current.gateway, ...(patch.gateway ?? {}) },
    channels: { ...current.channels, ...(patch.channels ?? {}) },
  };
  const validated = ConfigSchema.parse(merged);
  saveConfig(validated);
  return validated;
}

export function getChannelConfig(channel: string): ChannelConfig | null {
  const config = loadConfig();
  const raw = config.channels[channel];
  if (!raw) return null;
  return ChannelConfigSchema.parse(raw);
}

export function setChannelConfig(channel: string, channelConfig: Partial<ChannelConfig>): AppConfig {
  const config = loadConfig();
  const existing = config.channels[channel] ?? {};
  config.channels[channel] = ChannelConfigSchema.parse({ ...existing, ...channelConfig });
  saveConfig(config);
  return config;
}

// Minimal YAML-like serializer (JSON with comments for readability)
// In production, use the `yaml` package. For bootstrap, JSON is fine.
function parseSimpleYaml(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function serializeSimpleYaml(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}
