import { createServer, connect, type Socket, type Server } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { getSocketPath } from "./config.js";

// JSON-RPC 2.0 types
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type IpcHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// --- IPC Server (used by Gateway Daemon) ---

export class IpcServer {
  private server: Server | null = null;
  private handler: IpcHandler;
  private clients = new Set<Socket>();

  constructor(handler: IpcHandler) {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const socketPath = getSocketPath();

    // Clean up stale socket
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        let buffer = "";

        socket.on("data", (data) => {
          buffer += data.toString();
          // Process complete JSON messages (newline-delimited)
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            this.handleMessage(socket, line.trim());
          }
        });

        socket.on("close", () => {
          this.clients.delete(socket);
        });

        socket.on("error", () => {
          this.clients.delete(socket);
        });
      });

      this.server.on("error", reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  private async handleMessage(socket: Socket, raw: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      socket.write(JSON.stringify(errorResponse) + "\n");
      return;
    }

    try {
      const result = await this.handler(request.method, request.params ?? {});
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        result,
      };
      socket.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
      socket.write(JSON.stringify(response) + "\n");
    }
  }

  broadcast(notification: JsonRpcNotification): void {
    const raw = JSON.stringify(notification) + "\n";
    for (const client of this.clients) {
      try {
        client.write(raw);
      } catch {
        // client disconnected
      }
    }
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// --- IPC Client (used by MCP Server to talk to Daemon) ---

export class IpcClient {
  private socket: Socket | null = null;
  private requestId = 0;
  private pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = "";
  private onNotification?: (method: string, params: Record<string, unknown>) => void;

  constructor(opts?: { onNotification?: (method: string, params: Record<string, unknown>) => void }) {
    this.onNotification = opts?.onNotification;
  }

  async connect(): Promise<void> {
    const socketPath = getSocketPath();
    return new Promise((resolve, reject) => {
      this.socket = connect(socketPath, () => resolve());
      this.socket.on("error", reject);

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleMessage(line.trim());
        }
      });

      this.socket.on("close", () => {
        // Reject all pending requests
        for (const [, { reject }] of this.pending) {
          reject(new Error("Connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Check if it's a notification (no id)
      if (!("id" in msg) || msg.id === undefined) {
        this.onNotification?.(msg.method, msg.params ?? {});
        return;
      }

      // It's a response
      const pending = this.pending.get(msg.id);
      if (!pending) return;

      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    } catch {
      // ignore malformed messages
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket) {
      throw new Error("Not connected to gateway daemon");
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify(request) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}

// --- Helper: check if daemon is running ---

export async function isDaemonRunning(): Promise<boolean> {
  const client = new IpcClient();
  try {
    await client.connect();
    await client.call("ping");
    client.disconnect();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}
