import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { isUsE164, normalizeE164 } from "@agentphone/protocol";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { wsOrigin } from "./config.js";
import { registerConnect } from "./connect.js";
import { HttpError } from "./errors.js";
import { log } from "./log.js";
import { registerMcp } from "./mcp.js";
import type { Runtime } from "./runtime.js";
import { hashToken, type Store } from "./store.js";
import { conversationRelayTwiml, sayTwiml } from "./twiml.js";
import {
  buyUsNumber,
  relayUrl,
  releaseSid,
  searchUsNumbers,
  signatureIsValid,
  twilioConfigured,
} from "./twilio.js";

const TERMINAL = new Set(["completed", "busy", "no_answer", "failed", "canceled"]);

const voiceShape = z
  .object({
    language: z.string().optional(),
    ttsProvider: z.string().optional(),
    voice: z.string().optional(),
    transcriptionProvider: z.string().optional(),
    speechModel: z.string().optional(),
  })
  .optional();

const policyShape = z.object({
  name: z.string().min(1),
  objective: z.string().default(""),
  allowedActions: z.array(z.string()).default([]),
  forbiddenActions: z.array(z.string()).default([]),
  approvalRules: z
    .array(
      z.object({
        action: z.string(),
        when: z.union([z.literal("always"), z.object({ amountUsdGt: z.number() })]),
      }),
    )
    .default([]),
  isDefault: z.boolean().default(false),
});

export type Services = {
  config: AppConfig;
  store: Store;
  runtime: Runtime;
};

export async function buildApp(services: Services) {
  const { config, store, runtime } = services;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(formbody);
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message });
    }
    log("request failed", {
      method: request.method,
      url: request.url,
      error: error instanceof Error ? error.message : "unknown",
    });
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({
    ok: true,
    twilio: twilioConfigured(config),
    devSimulate: config.devSimulate,
    publicBaseUrl: config.publicBaseUrl,
  }));

  const guard = { preHandler: operatorGuard(config) };
  registerConnect(app, { config, store, guard: guard.preHandler });

  app.post("/v1/agents", guard, async (request) => {
    const body = read(
      z.object({
        name: z.string(),
        adapter: z.enum(["hermes", "generic", "openclaw"]),
        adapterConfig: z.record(z.string(), z.unknown()).optional(),
        voice: voiceShape,
      }),
      request.body,
    );
    return store.createAgent(body);
  });

  app.get("/v1/agents", guard, async () => ({ agents: store.listAgents() }));

  app.get("/v1/agents/:id", guard, async (request) => ({
    agent: store.getAgent((request.params as { id: string }).id),
    number: store.numberForAgent((request.params as { id: string }).id),
  }));

  app.patch("/v1/agents/:id", guard, async (request) => {
    const body = read(
      z.object({
        name: z.string().optional(),
        adapter: z.enum(["hermes", "generic", "openclaw"]).optional(),
        adapterConfig: z.record(z.string(), z.unknown()).optional(),
        voice: voiceShape,
      }),
      request.body,
    );
    return { agent: store.updateAgent((request.params as { id: string }).id, body) };
  });

  app.post("/v1/agents/:id/token", guard, async (request) =>
    store.rotateToken((request.params as { id: string }).id),
  );

  app.get("/v1/numbers", guard, async () => ({ numbers: store.listNumbers() }));

  app.get("/v1/numbers/available", guard, async (request) => {
    if (!twilioConfigured(config)) throw new HttpError(503, "Twilio is not configured");
    const areaCode = (request.query as { areaCode?: string }).areaCode ?? "";
    if (areaCode && !/^\d{3}$/.test(areaCode)) throw new HttpError(400, "areaCode must be 3 digits");
    return { numbers: await searchUsNumbers(config, areaCode || undefined) };
  });

  app.post("/v1/numbers", guard, async (request) => {
    if (!twilioConfigured(config)) throw new HttpError(503, "Twilio is not configured");
    const body = read(z.object({ agentId: z.string(), phoneNumber: z.string() }), request.body);
    const e164 = normalizeE164(body.phoneNumber);
    if (!isUsE164(e164)) throw new HttpError(400, "MVP buys US numbers only");
    const sid = await buyUsNumber(config, e164);
    try {
      const number = store.createNumber({ agentId: body.agentId, e164, twilioSid: sid, localOnly: false });
      return { number };
    } catch (error) {
      await releaseSid(config, sid).catch((releaseError: unknown) => {
        log("failed to release number after bind error", {
          sid,
          error: releaseError instanceof Error ? releaseError.message : "unknown",
        });
      });
      throw error;
    }
  });

  app.post("/v1/numbers/local", guard, async (request) => {
    if (!config.devSimulate) throw new HttpError(404, "not found");
    const body = read(z.object({ agentId: z.string(), e164: z.string() }), request.body);
    const number = store.createNumber({
      agentId: body.agentId,
      e164: normalizeE164(body.e164),
      localOnly: true,
    });
    return { number };
  });

  app.delete("/v1/numbers/:id", guard, async (request) => {
    const number = store.getNumber((request.params as { id: string }).id);
    if (number.twilioSid && !number.localOnly && twilioConfigured(config)) {
      await releaseSid(config, number.twilioSid);
    }
    store.releaseNumber(number.id);
    return { ok: true };
  });

  app.get("/v1/calls", guard, async (request) => {
    const query = request.query as { agentId?: string; threadId?: string };
    return { calls: store.listCalls(query) };
  });

  app.get("/v1/calls/:id", guard, async (request) => {
    const id = (request.params as { id: string }).id;
    return {
      call: store.getCall(id),
      segments: store.listSegments(id),
      partial: runtime.partial(id),
    };
  });

  app.post("/v1/calls", guard, async (request) => {
    const body = read(
      z.object({
        agentId: z.string(),
        to: z.string(),
        objective: z.string().optional(),
        policyId: z.string().optional(),
      }),
      request.body,
    );
    return runtime.startOutbound({
      agentId: body.agentId,
      to: normalizeE164(body.to),
      objective: body.objective,
      policyId: body.policyId,
    });
  });

  app.post("/v1/calls/:id/hangup", guard, async (request) => {
    const id = (request.params as { id: string }).id;
    runtime.hangup(id, "operator_hangup");
    return { call: store.getCall(id) };
  });

  app.get("/v1/threads", guard, async (request) => {
    const agentId = (request.query as { agentId?: string }).agentId;
    return { threads: store.listThreads(agentId) };
  });

  app.get("/v1/threads/:id", guard, async (request) => {
    const id = (request.params as { id: string }).id;
    const thread = store.getThread(id);
    return {
      thread,
      calls: store.listCalls({ threadId: id }),
      segments: store.recentSegments(id, 50),
      messages: store.listMessages(id),
    };
  });

  app.patch("/v1/threads/:id", guard, async (request) => {
    const body = read(
      z.object({
        summary: z.string().optional(),
        currentGoal: z.string().optional(),
        pendingState: z.record(z.string(), z.unknown()).nullable().optional(),
        callbackStatus: z.enum(["none", "requested", "scheduled", "completed", "failed"]).optional(),
        callbackAt: z.string().nullable().optional(),
        callbackNote: z.string().nullable().optional(),
      }),
      request.body,
    );
    return { thread: store.updateThread((request.params as { id: string }).id, body) };
  });

  app.get("/v1/policies", guard, async (request) => {
    const agentId = (request.query as { agentId?: string }).agentId;
    return { policies: store.listPolicies(agentId) };
  });

  app.post("/v1/policies", guard, async (request) => {
    const body = read(policyShape.extend({ agentId: z.string() }), request.body);
    return { policy: store.createPolicy(body) };
  });

  app.patch("/v1/policies/:id", guard, async (request) => {
    const body = read(policyShape.partial(), request.body);
    return {
      policy: store.updatePolicy((request.params as { id: string }).id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.objective !== undefined ? { objective: body.objective } : {}),
        ...(body.allowedActions !== undefined ? { allowedActions: body.allowedActions } : {}),
        ...(body.forbiddenActions !== undefined ? { forbiddenActions: body.forbiddenActions } : {}),
        ...(body.approvalRules !== undefined ? { approvalRules: body.approvalRules } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      }),
    };
  });

  app.delete("/v1/policies/:id", guard, async (request) => {
    store.deletePolicy((request.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/v1/approvals", guard, async (request) => {
    const status = (request.query as { status?: string }).status;
    return { approvals: store.listApprovals(status) };
  });

  app.post("/v1/approvals/:id/decision", guard, async (request) => {
    const body = read(
      z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().optional() }),
      request.body,
    );
    const result = runtime.decideApproval(
      (request.params as { id: string }).id,
      body.decision,
      body.note ?? "",
    );
    return { result, approval: store.getApproval((request.params as { id: string }).id) };
  });

  if (config.devSimulate) {
    app.post("/v1/dev/inbound", guard, async (request) => {
      const body = read(z.object({ to: z.string(), from: z.string() }), request.body);
      return runtime.beginInbound({
        to: normalizeE164(body.to),
        from: normalizeE164(body.from),
        simulated: true,
      });
    });
    app.post("/v1/dev/prompt", guard, async (request) => {
      const body = read(z.object({ callId: z.string(), text: z.string(), lang: z.string().optional() }), request.body);
      runtime.callerSaid(body.callId, body.text, body.lang);
      return { ok: true };
    });
    app.post("/v1/dev/tick-callbacks", guard, async () => {
      await runtime.tickCallbacks();
      return { ok: true };
    });
  }

  registerMcp(app, store, runtime);

  app.post("/twilio/sms", async (request, reply) => {
    if (!signed(config, request)) return reply.code(403).send("invalid signature");
    const body = stringRecord(request.body);
    try {
      runtime.receiveSms({
        from: normalizeE164(body.From ?? ""),
        to: normalizeE164(body.To ?? ""),
        body: body.Body ?? "",
        messageSid: body.MessageSid,
      });
    } catch (error) {
      log("sms webhook failed", { error: error instanceof Error ? error.message : "unknown" });
    }
    reply.type("text/xml");
    return "<Response></Response>";
  });

  app.post("/twilio/voice", async (request, reply) => {
    if (!signed(config, request)) return reply.code(403).send("invalid signature");
    const body = stringRecord(request.body);
    const callId = (request.query as { callId?: string }).callId;
    reply.type("text/xml");
    if (callId) {
      const call = store.getCall(callId);
      if (TERMINAL.has(call.status)) return sayTwiml("This call is no longer active.");
      const agent = store.getAgent(call.agentId);
      return conversationRelayTwiml({
        relayUrl: relayUrl(config),
        actionUrl: `${config.publicBaseUrl}/twilio/relay-action`,
        callId: call.id,
        voice: agent.voice,
        welcome: `Hello, this is ${agent.name}.`,
      });
    }
    const result = runtime.beginInbound({
      from: normalizeE164(body.From ?? ""),
      to: normalizeE164(body.To ?? ""),
      callSid: body.CallSid,
    });
    if (result.mode === "relay" && result.call) {
      const agent = store.getAgent(result.call.agentId);
      return conversationRelayTwiml({
        relayUrl: relayUrl(config),
        actionUrl: `${config.publicBaseUrl}/twilio/relay-action`,
        callId: result.call.id,
        voice: agent.voice,
        welcome: `Hello, this is ${agent.name}.`,
      });
    }
    return sayTwiml(result.text ?? "Goodbye.");
  });

  app.post("/twilio/status", async (request, reply) => {
    if (!signed(config, request)) return reply.code(403).send("invalid signature");
    const body = stringRecord(request.body);
    const callId = (request.query as { callId?: string }).callId;
    runtime.handleStatus({
      callId,
      callSid: body.CallSid,
      callStatus: body.CallStatus,
    });
    return reply.send("ok");
  });

  app.post("/twilio/relay-action", async (request, reply) => {
    if (!signed(config, request)) return reply.code(403).send("invalid signature");
    reply.type("text/xml");
    return "<Response/>";
  });

  app.get("/v1/gateway", { websocket: true }, (socket) => {
    runtime.attachGateway(socket);
  });

  app.get("/twilio/relay", { websocket: true }, (socket, request) => {
    const header = request.headers["x-twilio-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    const url = `${wsOrigin(config.publicBaseUrl)}${request.url}`;
    if (!signatureIsValid(config, signature, url, {})) {
      log("rejected relay handshake");
      socket.close(1008, "invalid signature");
      return;
    }
    runtime.attachRelay(socket);
  });

  return app;
}

function operatorGuard(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const left = Buffer.from(hashToken(token));
    const right = Buffer.from(hashToken(config.operatorKey));
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return reply.code(401).send({ error: "operator key required" });
    }
  };
}

function signed(config: AppConfig, request: FastifyRequest): boolean {
  const header = request.headers["x-twilio-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  return signatureIsValid(config, signature, `${config.publicBaseUrl}${request.url}`, stringRecord(request.body));
}

function stringRecord(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

function read<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}
