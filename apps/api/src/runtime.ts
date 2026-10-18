import { evaluateAction, normalizeE164, serverEvent, type Policy, type ServerEvent } from "@agentphone/protocol";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { log } from "./log.js";
import type { CallView, Store, ThreadView } from "./store.js";
import { completeTwilioCall, dial, sendTwilioSms, twilioConfigured } from "./twilio.js";

const TERMINAL = new Set(["completed", "busy", "no_answer", "failed", "canceled"]);
const OPEN = 1;

type Socket = {
  send: (data: string) => void;
  close: (code?: number, data?: string) => void;
  on: (event: "message" | "close" | "error", listener: (data?: unknown) => void) => void;
  readyState: number;
};

type SayItem = {
  token: string;
  last: boolean;
  preemptible?: boolean;
  interruptible?: boolean;
};

type Waiter = {
  approvalId: string;
  requestId: string;
  timer: NodeJS.Timeout;
  resolve: (result: ActionResult) => void;
};

type LiveCall = {
  callId: string;
  threadId: string;
  agentId: string;
  policy: Policy;
  direction: string;
  from: string;
  to: string;
  objective: string;
  partial: string;
  sayQueue: SayItem[];
  waiters: Waiter[];
  relay?: Socket;
  setupTimer?: NodeJS.Timeout;
  awaitingApprovalId?: string;
  ready: boolean;
  ended: boolean;
  simulated: boolean;
};

export type Runtime = ReturnType<typeof createRuntime>;

export type ActionResult = {
  decision: string;
  reason?: string;
  approvalId?: string;
};

export type InboundResult = {
  mode: "say" | "relay" | "simulated";
  text?: string;
  call: CallView | null;
  thread: ThreadView | null;
  connected: boolean;
};

type ClientFrame = {
  id: string;
  type: string;
  callId?: string;
  threadId?: string;
  payload: Record<string, unknown>;
};

export function createRuntime(store: Store, config: AppConfig) {
  const sockets = new Map<string, Set<Socket>>();
  const liveByCall = new Map<string, LiveCall>();
  const liveByAgent = new Map<string, LiveCall>();

  function isOnline(agentId: string): boolean {
    return (sockets.get(agentId)?.size ?? 0) > 0;
  }

  function push(agentId: string, event: ServerEvent): void {
    const frames = JSON.stringify(event);
    for (const socket of sockets.get(agentId) ?? []) {
      if (socket.readyState === OPEN) socket.send(frames);
    }
  }

  function brief(thread: ThreadView) {
    return {
      id: thread.id,
      summary: thread.summary,
      currentGoal: thread.currentGoal,
      pendingState: thread.pendingState,
      callbackStatus: thread.callbackStatus,
      callbackAt: thread.callbackAt,
      callbackNote: thread.callbackNote,
      externalSessionId: thread.externalSessionId,
      contactE164: thread.contactE164,
      recent: store.recentSegments(thread.id),
    };
  }

  function emitStarted(live: LiveCall, resumed: boolean): void {
    const thread = store.getThread(live.threadId);
    push(
      live.agentId,
      serverEvent(
        "call.started",
        {
          direction: live.direction,
          from: live.from,
          to: live.to,
          objective: live.objective,
          policy: live.policy,
          resumed,
          simulated: live.simulated,
          thread: brief(thread),
        },
        { callId: live.callId, threadId: live.threadId },
      ),
    );
  }

  function track(call: CallView, policy: Policy): LiveCall {
    const live: LiveCall = {
      callId: call.id,
      threadId: call.threadId,
      agentId: call.agentId,
      policy,
      direction: call.direction,
      from: call.fromE164,
      to: call.toE164,
      objective: call.objective,
      partial: "",
      sayQueue: [],
      waiters: [],
      ready: false,
      ended: false,
      simulated: call.simulated,
    };
    liveByCall.set(call.id, live);
    liveByAgent.set(call.agentId, live);
    return live;
  }

  function speakSystem(live: LiveCall, text: string): void {
    if (live.ended) return;
    store.addSegment({
      callId: live.callId,
      threadId: live.threadId,
      speaker: "system",
      text,
    });
    sendRelay(live, { type: "text", token: text, last: true, preemptible: true, interruptible: true });
  }

  function sendRelay(live: LiveCall, frame: Record<string, unknown>): void {
    if (!live.relay || live.relay.readyState !== OPEN) return;
    live.relay.send(JSON.stringify(frame));
  }

  function forwardSay(live: LiveCall, item: SayItem): void {
    const token = item.token === "" && item.last ? " " : item.token;
    live.partial += item.token;
    const frame: Record<string, unknown> = { type: "text", token, last: item.last };
    if (item.preemptible !== undefined) frame.preemptible = item.preemptible;
    if (item.interruptible !== undefined) frame.interruptible = item.interruptible;
    sendRelay(live, frame);
    if (!item.last) return;
    const text = live.partial.trim();
    live.partial = "";
    if (!text) return;
    store.addSegment({
      callId: live.callId,
      threadId: live.threadId,
      speaker: "agent",
      text,
    });
  }

  function applyAction(live: LiveCall, action: string, args: Record<string, unknown>): void {
    if (action === "hangup") {
      setTimeout(() => endCall(live.callId, "agent_hangup", "completed"), 0);
      return;
    }
    if (action === "schedule_callback") {
      const at = typeof args.at === "string" ? args.at : null;
      if (!at) return;
      store.updateThread(live.threadId, {
        callbackStatus: "scheduled",
        callbackAt: at,
        callbackNote: typeof args.note === "string" ? args.note : live.objective,
      });
      return;
    }
    if (action === "thread_update") {
      store.updateThread(live.threadId, {
        summary: typeof args.summary === "string" ? args.summary : undefined,
        currentGoal: typeof args.currentGoal === "string" ? args.currentGoal : undefined,
        pendingState:
          args.pendingState && typeof args.pendingState === "object"
            ? (args.pendingState as Record<string, unknown>)
            : undefined,
      });
    }
  }

  function miss(
    agentId: string,
    thread: ThreadView,
    from: string,
    to: string,
    status: "no_answer" | "busy",
    reason: string,
    text: string,
    simulated: boolean,
  ): InboundResult {
    const policy = store.resolvePolicy(agentId);
    const endedAt = new Date().toISOString();
    const call = store.createCall({
      threadId: thread.id,
      agentId,
      direction: "inbound",
      fromE164: from,
      toE164: to,
      status,
      objective: thread.currentGoal || policy.objective,
      policy,
      simulated,
      endedAt,
      endReason: reason,
      durationSec: 0,
    });
    if (thread.callbackStatus === "none" || thread.callbackStatus === "completed" || thread.callbackStatus === "failed") {
      store.updateThread(thread.id, { callbackStatus: "requested", callbackNote: text });
    }
    log(`missed call ${call.id}`, { status, reason, threadId: thread.id });
    return { mode: "say", text, call, thread: store.getThread(thread.id), connected: false };
  }

  function endCall(callId: string, reason: string, status: CallView["status"]): void {
    const live = liveByCall.get(callId);
    if (live?.ended) return;
    let call: CallView;
    try {
      call = store.getCall(callId);
    } catch {
      return;
    }
    if (TERMINAL.has(call.status) && !live) return;
    if (live) live.ended = true;
    if (live?.setupTimer) clearTimeout(live.setupTimer);
    if (live?.partial.trim()) {
      store.addSegment({
        callId,
        threadId: call.threadId,
        speaker: "agent",
        text: live.partial.trim(),
        interrupted: true,
      });
      live.partial = "";
    }
    const endedAt = new Date().toISOString();
    const durationSec = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(call.startedAt)) / 1000));
    if (!TERMINAL.has(call.status)) {
      store.updateCall(callId, { status, endedAt, durationSec, endReason: reason });
    }
    store.touchThread(call.threadId, endedAt);
    if (live?.relay && live.relay.readyState === OPEN) {
      live.relay.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason }) }));
      live.relay.close();
    }
    if (live) {
      for (const waiter of live.waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({ decision: "expired", reason: "call ended", approvalId: waiter.approvalId });
      }
      live.waiters = [];
      liveByCall.delete(callId);
      if (liveByAgent.get(live.agentId)?.callId === callId) liveByAgent.delete(live.agentId);
      push(
        live.agentId,
        serverEvent(
          "call.ended",
          { reason, status, durationSec },
          { callId, threadId: call.threadId },
        ),
      );
    }
    if (
      live &&
      call.twilioCallSid &&
      !call.simulated &&
      reason !== "twilio_status" &&
      reason !== "relay_closed"
    ) {
      void completeTwilioCall(config, call.twilioCallSid).catch((error: unknown) => {
        log(`twilio hangup failed for ${callId}`, { error: error instanceof Error ? error.message : "unknown" });
      });
    }
    log(`call ${callId} ended`, { reason, status });
  }

  function finishApproval(id: string, status: "approved" | "rejected" | "expired", note: string): ActionResult {
    const approval = store.getApproval(id);
    if (approval.status !== "pending") {
      return { decision: approval.status, approvalId: id, reason: approval.note ?? undefined };
    }
    store.resolveApproval(id, status, note);
    const live = liveByCall.get(approval.callId);
    const result: ActionResult = {
      decision: status,
      approvalId: id,
      reason: note,
    };
    if (!live || live.ended) return result;
    const waiter = live.waiters.find((item) => item.approvalId === id);
    if (waiter) clearTimeout(waiter.timer);
    live.waiters = live.waiters.filter((item) => item.approvalId !== id);
    if (live.awaitingApprovalId === id) live.awaitingApprovalId = undefined;
    if (status === "approved") {
      applyAction(live, approval.action, approval.payload);
      const queued = live.sayQueue;
      live.sayQueue = [];
      for (const item of queued) forwardSay(live, item);
    } else {
      live.sayQueue = [];
      speakSystem(live, "I can't confirm that on this call.");
    }
    if (waiter) {
      push(
        live.agentId,
        serverEvent(
          "action.resolved",
          { requestId: waiter.requestId, ...result },
          { callId: live.callId, threadId: live.threadId },
        ),
      );
      waiter.resolve(result);
    }
    log(`approval ${id} ${status}`, { callId: approval.callId, action: approval.action });
    return result;
  }

  function propose(
    agentId: string,
    action: string,
    args: Record<string, unknown>,
    requestId: string,
  ): Promise<ActionResult> {
    const live = liveByAgent.get(agentId);
    if (!live || live.ended) {
      return Promise.resolve({ decision: "deny", reason: "no active call" });
    }
    if (action === "schedule_callback" && typeof args.at !== "string") {
      const result = { decision: "deny", reason: "schedule_callback requires at" };
      push(agentId, serverEvent("action.resolved", { requestId, ...result }, { callId: live.callId, threadId: live.threadId }));
      return Promise.resolve(result);
    }
    const judged = evaluateAction(live.policy, action, args);
    if (judged.decision === "deny") {
      const result = { decision: "deny", reason: judged.reason };
      push(agentId, serverEvent("action.resolved", { requestId, ...result }, { callId: live.callId, threadId: live.threadId }));
      return Promise.resolve(result);
    }
    if (judged.decision === "allow") {
      applyAction(live, action, args);
      const result = { decision: "allow" };
      push(agentId, serverEvent("action.resolved", { requestId, ...result }, { callId: live.callId, threadId: live.threadId }));
      return Promise.resolve(result);
    }
    const approval = store.createApproval({
      callId: live.callId,
      threadId: live.threadId,
      action,
      payload: args,
    });
    live.awaitingApprovalId = approval.id;
    speakSystem(live, "I need a moment to confirm that.");
    push(
      agentId,
      serverEvent(
        "action.pending",
        { requestId, approvalId: approval.id, action, reason: judged.reason },
        { callId: live.callId, threadId: live.threadId },
      ),
    );
    log(`approval ${approval.id} pending`, { action, callId: live.callId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finishApproval(approval.id, "expired", "No confirmation arrived in time");
      }, config.approvalTimeoutMs);
      live.waiters.push({ approvalId: approval.id, requestId, timer, resolve });
    });
  }

  function onFinalUtterance(callId: string, text: string, lang: string): void {
    const live = liveByCall.get(callId);
    if (!live || live.ended) return;
    const spoken = text.trim();
    if (!spoken) return;
    store.addSegment({
      callId,
      threadId: live.threadId,
      speaker: "contact",
      text: spoken,
      lang,
    });
    const segmentCount = store.listSegments(callId).length;
    push(
      live.agentId,
      serverEvent(
        "utterance.final",
        { seq: segmentCount, text: spoken, lang },
        { callId, threadId: live.threadId },
      ),
    );
    log(`utterance ${callId}`, { text: spoken });
  }

  function receiveSms(input: { from: string; to: string; body: string; messageSid?: string }) {
    const number = store.numberByE164(input.to);
    if (!number) return null;
    const text = input.body.trim();
    if (!text) return null;
    const contact = store.upsertContact(number.agentId, input.from);
    const thread = store.upsertThread(number.agentId, contact.id);
    const message = store.addMessage({
      threadId: thread.id,
      agentId: number.agentId,
      direction: "inbound",
      fromE164: input.from,
      toE164: input.to,
      body: text,
      twilioSid: input.messageSid,
      status: "received",
    });
    push(
      number.agentId,
      serverEvent(
        "sms.received",
        { from: input.from, to: input.to, body: text, messageId: message.id },
        { threadId: thread.id },
      ),
    );
    log(`sms received ${message.id}`, { from: input.from, threadId: thread.id });
    return { message, thread };
  }

  async function sendSms(agentId: string, toRaw: string, body: string, userApproved: boolean) {
    const to = normalizeE164(toRaw);
    const text = body.trim();
    if (!text) throw new HttpError(400, "message body is required");
    const number = store.numberForAgent(agentId);
    if (!number) throw new HttpError(409, "agent has no phone number");
    const policy = store.resolvePolicy(agentId);
    const judged = evaluateAction(policy, "send_sms", { body: text, to });
    if (judged.decision === "deny") throw new HttpError(403, judged.reason);
    if (judged.decision === "approval" && !userApproved) {
      return {
        needsUser: true,
        ask: `要给 ${to} 发这条短信，需要你确认：${text}`,
      };
    }
    const contact = store.upsertContact(agentId, to);
    const thread = store.upsertThread(agentId, contact.id);
    let sid: string | null = null;
    let status = "sent";
    if (twilioConfigured(config)) {
      sid = await sendTwilioSms(config, number.e164, to, text);
    } else {
      status = "simulated";
    }
    const message = store.addMessage({
      threadId: thread.id,
      agentId,
      direction: "outbound",
      fromE164: number.e164,
      toE164: to,
      body: text,
      twilioSid: sid,
      status,
    });
    log(`sms sent ${message.id}`, { to, status });
    return { needsUser: false, message, threadId: thread.id, simulated: status === "simulated" };
  }

  return {
    isOnline,
    receiveSms,
    sendSms,

    partial(callId: string): string {
      return liveByCall.get(callId)?.partial ?? "";
    },

    attachGateway(socket: Socket): void {
      let agentId: string | null = null;
      let chain = Promise.resolve();
      const timer = setTimeout(() => {
        if (!agentId) socket.close(1008, "hello timeout");
      }, 5000);
      socket.on("message", (data) => {
        let frame: ClientFrame;
        try {
          frame = normalizeClient(JSON.parse(rawText(data)));
        } catch (error) {
          socket.send(JSON.stringify(serverEvent("error", { message: error instanceof Error ? error.message : "bad frame" })));
          return;
        }
        if (!agentId) {
          if (frame.type !== "session.hello") {
            socket.close(1008, "hello required");
            return;
          }
          const payload = frame.payload;
          const id = typeof payload.agentId === "string" ? payload.agentId : "";
          const token = typeof payload.token === "string" ? payload.token : "";
          const agent = store.authenticate(id, token);
          if (!agent) {
            socket.close(1008, "unauthorized");
            return;
          }
          agentId = agent.id;
          clearTimeout(timer);
          const set = sockets.get(agentId) ?? new Set<Socket>();
          set.add(socket);
          sockets.set(agentId, set);
          store.setStatus(agentId, "online");
          socket.send(JSON.stringify(serverEvent("session.ready", { agentId })));
          const live = liveByAgent.get(agentId);
          if (live && !live.ended) {
            if (live.ready) emitStarted(live, true);
            else {
              push(
                agentId,
                serverEvent(
                  "call.dialing",
                  { direction: live.direction, from: live.from, to: live.to, objective: live.objective },
                  { callId: live.callId, threadId: live.threadId },
                ),
              );
            }
          }
          log(`agent ${agentId} online`);
          return;
        }
        const currentAgent = agentId;
        chain = chain.then(() => handleAgent(currentAgent, frame)).catch((error: unknown) => {
          socket.send(
            JSON.stringify(
              serverEvent("error", { message: error instanceof Error ? error.message : "agent message failed" }),
            ),
          );
        });
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!agentId) return;
        try {
          const set = sockets.get(agentId);
          set?.delete(socket);
          if (set && set.size > 0) return;
          sockets.delete(agentId);
          store.setStatus(agentId, "offline");
          const live = liveByAgent.get(agentId);
          if (live && !live.ended) {
            speakSystem(live, "I'll call you back.");
            const thread = store.getThread(live.threadId);
            if (thread.callbackStatus !== "scheduled") {
              store.updateThread(live.threadId, {
                callbackStatus: "requested",
                callbackNote: "Agent disconnected during the call",
              });
            }
            endCall(live.callId, "agent_disconnected", "failed");
          }
          log(`agent ${agentId} offline`);
        } catch (error) {
          log("gateway close failed", { error: error instanceof Error ? error.message : "unknown" });
        }
      });
    },

    attachRelay(socket: Socket): void {
      let callId: string | null = null;
      socket.on("message", (data) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(rawText(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.type === "setup") {
          const params = (message.customParameters ?? {}) as Record<string, unknown>;
          const hinted = typeof params.callId === "string" ? params.callId : "";
          const sid = typeof message.callSid === "string" ? message.callSid : "";
          const call = hinted ? safeCall(hinted) : sid ? store.getCallBySid(sid) : null;
          if (!call) {
            socket.close(1008, "unknown call");
            return;
          }
          const live = liveByCall.get(call.id);
          if (!live || live.ended) {
            socket.close(1008, "call is not live");
            return;
          }
          callId = call.id;
          live.relay = socket;
          live.ready = true;
          if (live.setupTimer) clearTimeout(live.setupTimer);
          if (sid) store.updateCall(call.id, { twilioCallSid: sid, status: "in_progress" });
          else store.updateCall(call.id, { status: "in_progress" });
          emitStarted(live, false);
          log(`relay bound ${call.id}`);
          return;
        }
        if (!callId) return;
        if (message.type === "prompt" && (message.last === true || message.last === "true")) {
          onFinalUtterance(callId, String(message.voicePrompt ?? ""), String(message.lang ?? "en-US"));
        } else if (message.type === "interrupt") {
          const live = liveByCall.get(callId);
          if (!live) return;
          if (live.partial.trim()) {
            store.addSegment({
              callId,
              threadId: live.threadId,
              speaker: "agent",
              text: live.partial.trim(),
              interrupted: true,
            });
            live.partial = "";
          }
          push(
            live.agentId,
            serverEvent(
              "barge_in",
              {
                playedText: String(message.utteranceUntilInterrupt ?? ""),
                durationMs: Number(message.durationUntilInterruptMs ?? 0),
              },
              { callId, threadId: live.threadId },
            ),
          );
        } else if (message.type === "dtmf") {
          const live = liveByCall.get(callId);
          if (!live) return;
          push(
            live.agentId,
            serverEvent("dtmf", { digit: String(message.digit ?? "") }, { callId, threadId: live.threadId }),
          );
        } else if (message.type === "error") {
          log(`relay error ${callId}`, { description: message.description });
        }
      });
      socket.on("close", () => {
        if (!callId) return;
        const live = liveByCall.get(callId);
        if (live?.relay === socket) endCall(callId, "relay_closed", "completed");
      });
    },

    beginInbound(input: {
      from: string;
      to: string;
      callSid?: string;
      simulated?: boolean;
    }): InboundResult {
      const number = store.numberByE164(input.to);
      if (!number) {
        return {
          mode: "say",
          text: "This number is not in service.",
          call: null,
          thread: null,
          connected: false,
        };
      }
      const contact = store.upsertContact(number.agentId, input.from);
      const thread = store.upsertThread(number.agentId, contact.id);
      const simulated = input.simulated ?? false;
      if (!isOnline(number.agentId)) {
        return miss(
          number.agentId,
          thread,
          input.from,
          input.to,
          "no_answer",
          "agent_offline",
          "We're not available right now. We'll call you back.",
          simulated,
        );
      }
      if (liveByAgent.has(number.agentId)) {
        return miss(
          number.agentId,
          thread,
          input.from,
          input.to,
          "busy",
          "agent_busy",
          "I'm on another call. I'll call you back.",
          simulated,
        );
      }
      const policy = store.resolvePolicy(number.agentId);
      const call = store.createCall({
        threadId: thread.id,
        agentId: number.agentId,
        direction: "inbound",
        twilioCallSid: input.callSid,
        fromE164: input.from,
        toE164: input.to,
        status: simulated ? "in_progress" : "ringing",
        objective: thread.currentGoal || policy.objective,
        policy,
        simulated,
      });
      const live = track(call, policy);
      if (simulated) {
        live.ready = true;
        emitStarted(live, false);
        log(`simulated inbound ${call.id}`, { threadId: thread.id });
        return { mode: "simulated", call, thread, connected: true };
      }
      live.setupTimer = setTimeout(() => endCall(call.id, "relay_timeout", "failed"), 20_000);
      log(`inbound ringing ${call.id}`, { threadId: thread.id, from: input.from });
      return { mode: "relay", call, thread, connected: true };
    },

    async startOutbound(input: {
      agentId: string;
      to: string;
      objective?: string;
      policyId?: string;
    }) {
      const agent = store.getAgent(input.agentId);
      if (!isOnline(agent.id)) throw new HttpError(409, "agent offline");
      if (liveByAgent.has(agent.id)) throw new HttpError(409, "agent is already on a call");
      const number = store.numberForAgent(agent.id);
      if (!number) throw new HttpError(409, "agent has no phone number");
      const contact = store.upsertContact(agent.id, input.to);
      const thread = store.upsertThread(agent.id, contact.id);
      if (input.objective) store.updateThread(thread.id, { currentGoal: input.objective });
      const freshThread = store.getThread(thread.id);
      const policy = store.resolvePolicy(agent.id, input.policyId);
      const simulated = !twilioConfigured(config);
      const call = store.createCall({
        threadId: freshThread.id,
        agentId: agent.id,
        direction: "outbound",
        fromE164: number.e164,
        toE164: input.to,
        status: simulated ? "in_progress" : "queued",
        objective: input.objective || freshThread.currentGoal || policy.objective,
        policy,
        simulated,
      });
      const live = track(call, policy);
      if (simulated) {
        live.ready = true;
        push(
          agent.id,
          serverEvent(
            "call.dialing",
            { direction: "outbound", from: number.e164, to: input.to, objective: call.objective, simulated: true },
            { callId: call.id, threadId: freshThread.id },
          ),
        );
        emitStarted(live, false);
        log(`simulated outbound ${call.id}`);
        return { call: store.getCall(call.id), thread: freshThread, simulated: true };
      }
      try {
        const sid = await dial(config, { callId: call.id, from: number.e164, to: input.to });
        store.updateCall(call.id, { twilioCallSid: sid, status: "ringing" });
        live.setupTimer = setTimeout(() => endCall(call.id, "relay_timeout", "failed"), 45_000);
        push(
          agent.id,
          serverEvent(
            "call.dialing",
            { direction: "outbound", from: number.e164, to: input.to, objective: call.objective, simulated: false },
            { callId: call.id, threadId: freshThread.id },
          ),
        );
        log(`outbound dialing ${call.id}`, { sid });
        return { call: store.getCall(call.id), thread: freshThread, simulated: false };
      } catch (error) {
        endCall(call.id, "dial_failed", "failed");
        throw new HttpError(502, error instanceof Error ? error.message : "dial failed");
      }
    },

    callerSaid(callId: string, text: string, lang = "en-US") {
      onFinalUtterance(callId, text, lang);
    },

    propose(agentId: string, action: string, args: Record<string, unknown>) {
      return propose(agentId, action, args, `mcp_${Date.now().toString(16)}`);
    },

    decideApproval(id: string, decision: "approved" | "rejected", note: string) {
      return finishApproval(id, decision, note);
    },

    hangup(callId: string, reason = "operator_hangup") {
      endCall(callId, reason, "completed");
    },

    handleStatus(input: { callId?: string; callSid?: string; callStatus?: string }) {
      const call =
        (input.callId ? safeCall(input.callId) : null) ??
        (input.callSid ? store.getCallBySid(input.callSid) : null);
      if (!call || !input.callStatus) return;
      const mapped = mapTwilioStatus(input.callStatus);
      if (!mapped) return;
      if (input.callSid && call.twilioCallSid !== input.callSid) {
        store.updateCall(call.id, { twilioCallSid: input.callSid });
      }
      if (mapped.terminal) {
        endCall(call.id, "twilio_status", mapped.status);
        return;
      }
      const current = store.getCall(call.id);
      if (!TERMINAL.has(current.status) && current.status !== "in_progress") {
        store.updateCall(call.id, { status: mapped.status });
      }
    },

    async tickCallbacks() {
      const due = store.dueCallbacks(new Date().toISOString());
      for (const thread of due) {
        if (!isOnline(thread.agentId) || liveByAgent.has(thread.agentId)) {
          log(`callback waiting ${thread.id}`, { agentId: thread.agentId });
          continue;
        }
        try {
          await this.startOutbound({
            agentId: thread.agentId,
            to: thread.contactE164,
            objective: thread.currentGoal || thread.callbackNote || "Callback",
          });
          store.updateThread(thread.id, { callbackStatus: "completed" });
          log(`callback placed ${thread.id}`);
        } catch (error) {
          store.updateThread(thread.id, {
            callbackStatus: "failed",
            callbackNote: error instanceof Error ? error.message : "callback failed",
          });
          log(`callback failed ${thread.id}`, { error: error instanceof Error ? error.message : "unknown" });
        }
      }
    },
  };

  async function handleAgent(agentId: string, frame: ClientFrame): Promise<void> {
    if (frame.type === "say.delta") {
      const live = liveByAgent.get(agentId);
      if (!live || live.ended || frame.callId !== live.callId) throw new HttpError(409, "no active call");
      const payload = frame.payload;
      const item: SayItem = {
        token: typeof payload.token === "string" ? payload.token : "",
        last: payload.last === true,
        preemptible: typeof payload.preemptible === "boolean" ? payload.preemptible : undefined,
        interruptible: typeof payload.interruptible === "boolean" ? payload.interruptible : undefined,
      };
      if (live.awaitingApprovalId) {
        live.sayQueue.push(item);
        return;
      }
      forwardSay(live, item);
      return;
    }
    if (frame.type === "action.propose") {
      const action = typeof frame.payload.action === "string" ? frame.payload.action : "";
      const args =
        frame.payload.arguments && typeof frame.payload.arguments === "object"
          ? (frame.payload.arguments as Record<string, unknown>)
          : {};
      await propose(agentId, action, args, frame.id);
      return;
    }
    if (frame.type === "thread.patch") {
      const thread = store.getThread(frame.threadId ?? "");
      if (thread.agentId !== agentId) throw new HttpError(404, "thread not found");
      store.updateThread(thread.id, {
        summary: typeof frame.payload.summary === "string" ? frame.payload.summary : undefined,
        currentGoal: typeof frame.payload.currentGoal === "string" ? frame.payload.currentGoal : undefined,
        pendingState:
          frame.payload.pendingState && typeof frame.payload.pendingState === "object"
            ? (frame.payload.pendingState as Record<string, unknown>)
            : frame.payload.pendingState === null
              ? null
              : undefined,
        callbackStatus:
          typeof frame.payload.callbackStatus === "string" ? frame.payload.callbackStatus : undefined,
        callbackAt:
          frame.payload.callbackAt === null
            ? null
            : typeof frame.payload.callbackAt === "string"
              ? frame.payload.callbackAt
              : undefined,
        callbackNote:
          frame.payload.callbackNote === null
            ? null
            : typeof frame.payload.callbackNote === "string"
              ? frame.payload.callbackNote
              : undefined,
        externalSessionId:
          frame.payload.externalSessionId === null
            ? null
            : typeof frame.payload.externalSessionId === "string"
              ? frame.payload.externalSessionId
              : undefined,
      });
      return;
    }
    if (frame.type === "call.hangup") {
      const live = liveByAgent.get(agentId);
      if (!live || frame.callId !== live.callId) throw new HttpError(409, "no active call");
      const reason = typeof frame.payload.reason === "string" ? frame.payload.reason : "agent_hangup";
      endCall(live.callId, reason, "completed");
      return;
    }
    if (frame.type === "callback.schedule") {
      const thread = store.getThread(frame.threadId ?? "");
      if (thread.agentId !== agentId) throw new HttpError(404, "thread not found");
      const at = typeof frame.payload.at === "string" ? frame.payload.at : "";
      if (!at) throw new HttpError(400, "at is required");
      store.updateThread(thread.id, {
        callbackStatus: "scheduled",
        callbackAt: at,
        callbackNote: typeof frame.payload.note === "string" ? frame.payload.note : thread.callbackNote,
      });
    }
  }

  function safeCall(id: string): CallView | null {
    try {
      return store.getCall(id);
    } catch {
      return null;
    }
  }
}

function mapTwilioStatus(status: string): { status: string; terminal: boolean } | null {
  switch (status) {
    case "queued":
    case "initiated":
      return { status: "queued", terminal: false };
    case "ringing":
      return { status: "ringing", terminal: false };
    case "in-progress":
    case "answered":
      return { status: "in_progress", terminal: false };
    case "completed":
      return { status: "completed", terminal: true };
    case "busy":
      return { status: "busy", terminal: true };
    case "no-answer":
      return { status: "no_answer", terminal: true };
    case "failed":
      return { status: "failed", terminal: true };
    case "canceled":
      return { status: "canceled", terminal: true };
    default:
      return null;
  }
}

function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data) && data.every((item) => Buffer.isBuffer(item))) {
    return Buffer.concat(data).toString("utf8");
  }
  return String(data ?? "");
}

function normalizeClient(value: unknown): ClientFrame {
  if (!value || typeof value !== "object") throw new Error("invalid json");
  const frame = value as Record<string, unknown>;
  if (frame.v !== 1 || typeof frame.type !== "string" || typeof frame.id !== "string") {
    throw new Error("invalid gateway message");
  }
  const payload =
    frame.payload && typeof frame.payload === "object" ? (frame.payload as Record<string, unknown>) : {};
  return {
    id: frame.id,
    type: frame.type,
    callId: typeof frame.callId === "string" ? frame.callId : undefined,
    threadId: typeof frame.threadId === "string" ? frame.threadId : undefined,
    payload,
  };
}
