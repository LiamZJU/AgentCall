import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeE164 } from "@agentphone/protocol";
import { HttpError } from "./errors.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";

const TOOLS = [
  {
    name: "phone_call",
    description: "Place an outbound call from this agent's phone number.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        objective: { type: "string" },
        policyId: { type: "string" },
      },
      required: ["to"],
    },
  },
  {
    name: "phone_hangup",
    description: "Hang up the active call, or a call id you pass.",
    inputSchema: {
      type: "object",
      properties: { callId: { type: "string" }, reason: { type: "string" } },
    },
  },
  {
    name: "phone_thread_get",
    description: "Read one contact's call and SMS history, in time order.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, contact: { type: "string" } },
    },
  },
  {
    name: "phone_callback_schedule",
    description: "Schedule a callback on a thread.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        at: { type: "string" },
        note: { type: "string" },
      },
      required: ["threadId", "at"],
    },
  },
  {
    name: "sms_send",
    description:
      "Send an SMS from this agent's phone number.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        body: { type: "string" },
        userApproved: { type: "boolean" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "phone_action",
    description:
      "Propose a phone action on the active call. Forbidden actions are rejected. Approval rules wait for an operator.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["action"],
    },
  },
];

export function registerMcp(app: FastifyInstance, store: Store, runtime: Runtime): void {
  app.post("/mcp", async (request, reply) => {
    const body = request.body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    const session = sessionId(request);
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(reply, request, body?.id ?? null, -32600, "invalid request", session);
    }
    if (body.id === undefined) {
      reply.code(202).header("mcp-session-id", session);
      return reply.send();
    }
    try {
      if (body.method === "initialize") {
        return send(reply, request, body.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agentphone", version: "0.1.0" },
        }, session);
      }
      if (body.method === "ping") return send(reply, request, body.id, {}, session);
      const agent = agentFrom(request, store);
      if (body.method === "tools/list") return send(reply, request, body.id, { tools: TOOLS }, session);
      if (body.method === "tools/call") {
        const params = body.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        const result = await callTool(store, runtime, agent.id, name, args);
        return send(reply, request, body.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        }, session);
      }
      return rpcError(reply, request, body.id, -32601, `unknown method ${body.method}`, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "tool failed";
      const code = error instanceof HttpError && error.status === 401 ? -32001 : -32000;
      return rpcError(reply, request, body.id, code, message, session);
    }
  });
}

async function callTool(
  store: Store,
  runtime: Runtime,
  agentId: string,
  name: string,
  args: Record<string, unknown>,
) {
  if (name === "phone_call") {
    const to = normalizeE164(String(args.to ?? ""));
    return runtime.startOutbound({
      agentId,
      to,
      objective: typeof args.objective === "string" ? args.objective : undefined,
      policyId: typeof args.policyId === "string" ? args.policyId : undefined,
    });
  }
  if (name === "phone_hangup") {
    const callId = typeof args.callId === "string" ? args.callId : undefined;
    if (callId) {
      const call = store.getCall(callId);
      if (call.agentId !== agentId) throw new HttpError(404, "call not found");
      runtime.hangup(call.id, typeof args.reason === "string" ? args.reason : "agent_hangup");
      return { ok: true, callId: call.id };
    }
    const active = store.listCalls({ agentId }).find((call) => !["completed", "busy", "no_answer", "failed", "canceled"].includes(call.status));
    if (!active) throw new HttpError(409, "no active call");
    runtime.hangup(active.id, typeof args.reason === "string" ? args.reason : "agent_hangup");
    return { ok: true, callId: active.id };
  }
  if (name === "phone_thread_get") {
    const thread =
      typeof args.threadId === "string"
        ? store.getThread(args.threadId)
        : store.upsertThread(agentId, store.upsertContact(agentId, normalizeE164(String(args.contact ?? ""))).id);
    if (thread.agentId !== agentId) throw new HttpError(404, "thread not found");
    return {
      threadId: thread.id,
      contactE164: thread.contactE164,
      callbackStatus: thread.callbackStatus,
      callbackAt: thread.callbackAt,
      callbackNote: thread.callbackNote,
      turns: store.listTurns(thread.id, 50),
    };
  }
  if (name === "phone_callback_schedule") {
    const thread = store.getThread(String(args.threadId ?? ""));
    if (thread.agentId !== agentId) throw new HttpError(404, "thread not found");
    const at = typeof args.at === "string" ? args.at : "";
    if (!at) throw new HttpError(400, "at is required");
    return store.updateThread(thread.id, {
      callbackStatus: "scheduled",
      callbackAt: at,
      callbackNote: typeof args.note === "string" ? args.note : thread.callbackNote,
    });
  }
  if (name === "sms_send") {
    const to = typeof args.to === "string" ? args.to : "";
    const body = typeof args.body === "string" ? args.body : "";
    return runtime.sendSms(agentId, to, body);
  }
  if (name === "phone_action") {
    const action = typeof args.action === "string" ? args.action : "";
    const actionArgs =
      args.arguments && typeof args.arguments === "object" ? (args.arguments as Record<string, unknown>) : {};
    return runtime.propose(agentId, action, actionArgs);
  }
  throw new HttpError(400, `unknown tool ${name}`);
}

function agentFrom(request: FastifyRequest, store: Store) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const agent = token ? store.authenticateToken(token) : null;
  if (!agent) throw new HttpError(401, "agent token required");
  return agent;
}

function sessionId(request: FastifyRequest): string {
  const header = request.headers["mcp-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value || "stateless";
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  id: unknown,
  result: unknown,
  session: string,
) {
  const body = { jsonrpc: "2.0", id, result };
  reply.header("mcp-session-id", session);
  const accept = String(request.headers.accept ?? "");
  if (accept.includes("text/event-stream")) {
    reply.header("content-type", "text/event-stream");
    return reply.send(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  }
  return reply.send(body);
}

function rpcError(
  reply: FastifyReply,
  request: FastifyRequest,
  id: unknown,
  code: number,
  message: string,
  session: string,
) {
  return sendError(reply, request, id, code, message, session);
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  id: unknown,
  code: number,
  message: string,
  session: string,
) {
  const body = { jsonrpc: "2.0", id, error: { code, message } };
  reply.header("mcp-session-id", session);
  const accept = String(request.headers.accept ?? "");
  if (accept.includes("text/event-stream")) {
    reply.header("content-type", "text/event-stream");
    return reply.send(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  }
  return reply.send(body);
}
