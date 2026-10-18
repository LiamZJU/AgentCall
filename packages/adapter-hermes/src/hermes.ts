import WebSocket from "ws";

type Frame = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
  type?: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type HermesHandlers = {
  onDelta: (text: string) => void;
  onTool: () => void;
  onComplete: (text: string) => void;
};

export class HermesClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private capabilitiesSent = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const ws = new WebSocket(this.url, { headers });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("Hermes gateway timed out")), 8000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("message", (data: WebSocket.RawData) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          try {
            this.onFrame(JSON.parse(line) as Frame);
          } catch (error) {
            console.error("[agentphone-hermes] bad frame", error);
          }
        }
      });
      ws.on("close", () => {
        for (const waiter of this.pending.values()) waiter.reject(new Error("Hermes socket closed"));
        this.pending.clear();
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  async ensureSession(existingId: string | null): Promise<string> {
    if (existingId) return existingId;
    const created = await this.request("session.create", {});
    return sessionIdOf(created);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request("session.interrupt", { session_id: sessionId }).catch((error: unknown) => {
      console.error("[agentphone-hermes] interrupt failed", error instanceof Error ? error.message : error);
    });
  }

  async turn(sessionId: string, prompt: string, handlers: HermesHandlers): Promise<string> {
    let full = "";
    let completed = "";
    const unsubscribe = this.listen((frame) => {
      const name = eventName(frame);
      if (!name) return;
      if (name === "tool.start" || name.endsWith("tool.start")) handlers.onTool();
      if (name === "message.delta" || name.endsWith("message.delta")) {
        const piece = textOf(frame);
        if (!piece) return;
        const next = piece.startsWith(full) ? piece : full + piece;
        const suffix = next.slice(full.length);
        full = next;
        if (suffix) handlers.onDelta(suffix);
      }
      if (name === "message.complete" || name.endsWith("message.complete")) {
        completed = textOf(frame) || full;
        handlers.onComplete(completed);
      }
    });
    try {
      const result = await this.request("prompt.submit", { session_id: sessionId, prompt });
      if (!completed) {
        completed = textOf(result as Frame) || full;
        handlers.onComplete(completed);
      }
      return completed || full;
    } finally {
      unsubscribe();
    }
  }

  private listen(handler: (frame: Frame) => void): () => void {
    const wrapped = (frame: Frame) => handler(frame);
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  private listeners = new Set<(frame: Frame) => void>();

  private onFrame(frame: Frame): void {
    if (frame.id !== undefined && frame.method && !this.pending.has(String(frame.id))) {
      this.send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: `AgentPhone does not answer Hermes ${frame.method}` },
      });
      return;
    }
    if (frame.id !== undefined && (frame.result !== undefined || frame.error) && this.pending.has(String(frame.id))) {
      const waiter = this.pending.get(String(frame.id));
      this.pending.delete(String(frame.id));
      if (frame.error) waiter?.reject(new Error(frame.error.message ?? "Hermes request failed"));
      else waiter?.resolve(frame.result);
    }
    const name = eventName(frame);
    if (name === "gateway.ready") this.sendCapabilities();
    for (const listener of this.listeners) listener(frame);
  }

  private sendCapabilities(): void {
    if (this.capabilitiesSent) return;
    this.capabilitiesSent = true;
    void this.request("client.capabilities", { server_requests: true }).catch((error: unknown) => {
      console.error(
        "[agentphone-hermes] client.capabilities failed",
        error instanceof Error ? error.message : error,
      );
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Hermes ${method} timed out`));
      }, 90_000);
      this.pending.set(String(id), {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send(frame);
    });
  }

  private send(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Hermes gateway is not connected");
    }
    this.ws.send(`${JSON.stringify(frame)}\n`);
  }
}

function eventName(frame: Frame): string | null {
  if (typeof frame.method === "string" && frame.method !== "event") return frame.method;
  const params = frame.params ?? {};
  if (typeof params.type === "string") return params.type;
  if (typeof frame.type === "string") return frame.type;
  return null;
}

function textOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const params = (record.params && typeof record.params === "object" ? record.params : record) as Record<string, unknown>;
  for (const key of ["delta", "text", "token", "content", "message"]) {
    const field = params[key];
    if (typeof field === "string") return field;
    if (field && typeof field === "object" && "text" in field && typeof field.text === "string") return field.text;
  }
  return "";
}

function sessionIdOf(result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("Hermes session.create returned no session");
  const record = result as Record<string, unknown>;
  const id = record.session_id ?? record.sessionId ?? record.id;
  if (typeof id !== "string" || !id) throw new Error("Hermes session.create returned no session id");
  return id;
}
