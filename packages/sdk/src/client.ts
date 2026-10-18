import { randomBytes } from "node:crypto";
import type { ServerEvent } from "@agentphone/protocol";

export type SayOptions = {
  last?: boolean;
  preemptible?: boolean;
  interruptible?: boolean;
};

export type ActionResult = {
  decision: string;
  reason?: string;
  approvalId?: string;
};

type Handler = (event: ServerEvent) => void;

export type AgentPhoneClientOptions = {
  url: string;
  agentId: string;
  token: string;
};

export class AgentPhoneClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private pendingActions = new Map<
    string,
    { resolve: (result: ActionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private opened: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;

  constructor(private readonly options: AgentPhoneClientOptions) {}

  on(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  connect(): Promise<void> {
    if (this.opened) return this.opened;
    this.closed = false;
    this.opened = new Promise<void>((resolve) => {
      this.openResolve = resolve;
      this.openSocket();
    });
    return this.opened;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  say(callId: string, token: string, options: SayOptions = {}): void {
    this.send({
      type: "say.delta",
      callId,
      payload: {
        token,
        last: options.last ?? false,
        preemptible: options.preemptible,
        interruptible: options.interruptible,
      },
    });
  }

  propose(
    callId: string,
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<ActionResult> {
    const id = messageId();
    const promise = new Promise<ActionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(id);
        reject(new Error(`action ${action} timed out`));
      }, 70_000);
      this.pendingActions.set(id, { resolve, reject, timer });
    });
    this.send({
      id,
      type: "action.propose",
      callId,
      payload: { action, arguments: args },
    });
    return promise;
  }

  patchThread(threadId: string, payload: Record<string, unknown>): void {
    this.send({ type: "thread.patch", threadId, payload });
  }

  hangup(callId: string, reason = "agent_hangup"): void {
    this.send({ type: "call.hangup", callId, payload: { reason } });
  }

  scheduleCallback(threadId: string, at: string, note = ""): void {
    this.send({ type: "callback.schedule", threadId, payload: { at, note } });
  }

  private openSocket(): void {
    const ws = new WebSocket(this.gatewayUrl());
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.send({
        type: "session.hello",
        payload: { agentId: this.options.agentId, token: this.options.token },
      });
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(raw) as ServerEvent;
      } catch (error) {
        console.error("[agentphone-sdk] bad server frame", error);
        return;
      }
      if (parsed.type === "session.ready") this.openResolve?.();
      if (parsed.type === "action.resolved") {
        const requestId = String(parsed.payload.requestId ?? "");
        const waiter = this.pendingActions.get(requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pendingActions.delete(requestId);
          waiter.resolve({
            decision: String(parsed.payload.decision ?? ""),
            reason: parsed.payload.reason ? String(parsed.payload.reason) : undefined,
            approvalId: parsed.payload.approvalId ? String(parsed.payload.approvalId) : undefined,
          });
        }
      }
      for (const handler of this.handlers.get(parsed.type) ?? []) handler(parsed);
      for (const handler of this.handlers.get("*") ?? []) handler(parsed);
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      if (this.closed) return;
      console.error("[agentphone-sdk] gateway closed, reconnecting");
      this.reconnectTimer = setTimeout(() => this.openSocket(), 1500);
    });
    ws.addEventListener("error", () => {
      console.error("[agentphone-sdk] gateway socket error");
    });
  }

  private gatewayUrl(): string {
    const base = this.options.url.replace(/\/$/, "");
    const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${wsBase}/v1/gateway`;
  }

  private send(message: Record<string, unknown>): void {
    const frame = {
      v: 1,
      id: message.id ?? messageId(),
      ts: new Date().toISOString(),
      payload: {},
      ...message,
    };
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("AgentPhone gateway is not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }
}

function messageId(): string {
  return `msg_${randomBytes(8).toString("hex")}`;
}
