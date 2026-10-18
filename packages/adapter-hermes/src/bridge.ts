import { AgentPhoneClient } from "@agentphone/sdk";
import type { ServerEvent } from "@agentphone/protocol";
import { HermesClient } from "./hermes.js";
import { livePrompt, parseSummary, summaryPrompt, type PhoneBrief } from "./prompt.js";

type CallContext = {
  callId: string;
  threadId: string;
  direction: string;
  from: string;
  to: string;
  objective: string;
  policy: {
    objective: string;
    allowedActions: string[];
    forbiddenActions: string[];
    approvalRules: Array<{ action: string; when: "always" | { amountUsdGt: number } }>;
  };
  thread: PhoneBrief;
  sessionId: string | null;
};

export type HermesBridgeOptions = {
  agentphoneUrl: string;
  agentId: string;
  token: string;
  hermesWsUrl: string;
  hermesToken?: string;
};

export async function startHermesBridge(options: HermesBridgeOptions): Promise<{ close: () => void }> {
  const phone = new AgentPhoneClient({
    url: options.agentphoneUrl,
    agentId: options.agentId,
    token: options.token,
  });
  const hermes = new HermesClient(options.hermesWsUrl, options.hermesToken ?? "");
  const calls = new Map<string, CallContext>();
  const sessions = new Map<string, string>();
  let queue = Promise.resolve();
  let generation = 0;

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: unknown) => {
      console.error("[agentphone-hermes]", error instanceof Error ? error.message : error);
    });
  };

  phone.on("call.started", (event) => {
    const payload = event.payload;
    const thread = (payload.thread ?? {}) as PhoneBrief & { externalSessionId?: string | null; id?: string };
    const callId = event.callId ?? "";
    const threadId = event.threadId ?? String(thread.id ?? "");
    calls.set(callId, {
      callId,
      threadId,
      direction: String(payload.direction ?? ""),
      from: String(payload.from ?? ""),
      to: String(payload.to ?? ""),
      objective: String(payload.objective ?? ""),
      policy: normalizePolicy(payload.policy),
      thread,
      sessionId: sessions.get(threadId) ?? thread.externalSessionId ?? null,
    });
    console.error(`[agentphone-hermes] call started ${callId} thread ${threadId}`);
  });

  phone.on("utterance.final", (event) => {
    const call = calls.get(event.callId ?? "");
    if (!call) return;
    const text = String(event.payload.text ?? "");
    const turn = ++generation;
    enqueue(async () => {
      if (turn !== generation) return;
      call.sessionId = await hermes.ensureSession(call.sessionId);
      sessions.set(call.threadId, call.sessionId);
      phone.patchThread(call.threadId, { externalSessionId: call.sessionId });
      let started = false;
      let held = false;
      await hermes.turn(call.sessionId, livePrompt({ ...call, utterance: text }), {
        onDelta: (token) => {
          if (turn !== generation) return;
          started = true;
          phone.say(call.callId, token, { last: false });
        },
        onTool: () => {
          if (turn !== generation || started || held) return;
          held = true;
          phone.say(call.callId, "Let me check that.", { last: true, preemptible: true });
        },
        onComplete: () => {
          if (turn !== generation || !started) return;
          phone.say(call.callId, "", { last: true });
        },
      });
    });
  });

  phone.on("barge_in", (event) => {
    generation += 1;
    const call = calls.get(event.callId ?? "");
    if (call?.sessionId) void hermes.interrupt(call.sessionId);
    console.error(`[agentphone-hermes] barge-in ${event.callId ?? ""}`);
  });

  phone.on("call.ended", (event) => {
    const call = calls.get(event.callId ?? "");
    calls.delete(event.callId ?? "");
    if (!call?.sessionId) return;
    const sessionId = call.sessionId;
    const threadId = call.threadId;
    enqueue(async () => {
      const text = await hermes.turn(sessionId, summaryPrompt(), {
        onDelta: () => undefined,
        onTool: () => undefined,
        onComplete: () => undefined,
      });
      const summary = parseSummary(text);
      if (!summary) {
        console.error("[agentphone-hermes] summary was not JSON");
        return;
      }
      phone.patchThread(threadId, summary);
      console.error(`[agentphone-hermes] thread ${threadId} updated`);
    });
  });

  phone.on("sms.received", (event) => {
    const from = String(event.payload.from ?? "");
    const text = String(event.payload.body ?? "");
    const threadId = event.threadId ?? "";
    enqueue(async () => {
      const sessionId = await hermes.ensureSession(sessions.get(threadId) ?? null);
      if (threadId) {
        sessions.set(threadId, sessionId);
        phone.patchThread(threadId, { externalSessionId: sessionId });
      }
      await hermes.turn(
        sessionId,
        [
          "You received an SMS. This is not a phone call. Do not speak aloud.",
          `From: ${from}`,
          `Thread: ${threadId}`,
          `Message: ${text}`,
          "If a reply is useful, call the agentphone sms_send tool.",
          "If that tool says the user must confirm, ask the user. Call sms_send again with userApproved true only after they agree.",
        ].join("\n"),
        { onDelta: () => undefined, onTool: () => undefined, onComplete: () => undefined },
      );
    });
  });

  phone.on("*", (event: ServerEvent) => {
    if (event.type === "error") console.error("[agentphone-hermes] gateway error", event.payload);
  });

  await hermes.connect();
  await phone.connect();
  console.error(`[agentphone-hermes] connected agent ${options.agentId}`);
  return {
    close() {
      phone.close();
      hermes.close();
    },
  };
}

function normalizePolicy(value: unknown): CallContext["policy"] {
  const policy = (value ?? {}) as Record<string, unknown>;
  return {
    objective: typeof policy.objective === "string" ? policy.objective : "",
    allowedActions: stringList(policy.allowedActions),
    forbiddenActions: stringList(policy.forbiddenActions),
    approvalRules: Array.isArray(policy.approvalRules)
      ? (policy.approvalRules as CallContext["policy"]["approvalRules"])
      : [],
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
