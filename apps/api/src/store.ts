import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { openDatabase, schema, type AgentPhoneDatabase } from "@agentphone/db";
import {
  createId,
  createToken,
  EMPTY_POLICY,
  type ApprovalRule,
  type Policy,
} from "@agentphone/protocol";
import { HttpError } from "./errors.js";
import { DEFAULT_VOICE, parseVoice, type VoiceProfile } from "./voice.js";

const ADAPTERS = new Set(["hermes", "generic", "openclaw"]);
const CALLBACKS = new Set(["none", "requested", "scheduled", "completed", "failed"]);

export type AgentView = {
  id: string;
  name: string;
  adapter: string;
  adapterConfig: Record<string, unknown>;
  status: string;
  defaultPolicyId: string | null;
  voice: VoiceProfile;
  createdAt: string;
  updatedAt: string;
};

export type NumberView = {
  id: string;
  agentId: string;
  e164: string;
  twilioSid: string | null;
  status: string;
  localOnly: boolean;
  createdAt: string;
};

export type ContactView = {
  id: string;
  agentId: string;
  e164: string;
  displayName: string | null;
  createdAt: string;
};

export type ThreadView = {
  id: string;
  agentId: string;
  contactId: string;
  contactE164: string;
  summary: string;
  currentGoal: string;
  pendingState: Record<string, unknown>;
  callbackStatus: string;
  callbackAt: string | null;
  callbackNote: string | null;
  externalSessionId: string | null;
  lastCallAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CallView = {
  id: string;
  threadId: string;
  agentId: string;
  direction: string;
  twilioCallSid: string | null;
  fromE164: string;
  toE164: string;
  status: string;
  objective: string;
  policy: Policy;
  simulated: boolean;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  endReason: string | null;
};

export type SegmentView = {
  id: string;
  callId: string;
  threadId: string;
  seq: number;
  speaker: string;
  text: string;
  lang: string | null;
  interrupted: boolean;
  createdAt: string;
};

export type PolicyView = Policy & {
  id: string;
  agentId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalView = {
  id: string;
  callId: string;
  threadId: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type ThreadPatch = {
  summary?: string;
  currentGoal?: string;
  pendingState?: Record<string, unknown> | null;
  callbackStatus?: string;
  callbackAt?: string | null;
  callbackNote?: string | null;
  externalSessionId?: string | null;
};

export type Store = ReturnType<typeof createStore>;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(hash: string, token: string): boolean {
  const left = Buffer.from(hash);
  const right = Buffer.from(hashToken(token));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createStore(databasePath: string) {
  const opened = openDatabase(databasePath);
  const db: AgentPhoneDatabase = opened.db;
  const stamp = () => new Date().toISOString();

  function requireAgent(id: string) {
    const row = db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
    if (!row) throw new HttpError(404, "agent not found");
    return row;
  }

  function toAgent(row: typeof schema.agents.$inferSelect): AgentView {
    return {
      id: row.id,
      name: row.name,
      adapter: row.adapter,
      adapterConfig: publicAdapterConfig(parseObject(row.adapterConfig)),
      status: row.status,
      defaultPolicyId: row.defaultPolicyId,
      voice: parseVoice(row.voice),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toNumber(row: typeof schema.phoneNumbers.$inferSelect): NumberView {
    return {
      id: row.id,
      agentId: row.agentId,
      e164: row.e164,
      twilioSid: row.twilioSid,
      status: row.status,
      localOnly: row.localOnly === 1,
      createdAt: row.createdAt,
    };
  }

  function toContact(row: typeof schema.contacts.$inferSelect): ContactView {
    return {
      id: row.id,
      agentId: row.agentId,
      e164: row.e164,
      displayName: row.displayName,
      createdAt: row.createdAt,
    };
  }

  function toThread(
    row: typeof schema.threads.$inferSelect,
    contactE164: string,
  ): ThreadView {
    return {
      id: row.id,
      agentId: row.agentId,
      contactId: row.contactId,
      contactE164,
      summary: row.summary,
      currentGoal: row.currentGoal,
      pendingState: parseObject(row.pendingState),
      callbackStatus: row.callbackStatus,
      callbackAt: row.callbackAt,
      callbackNote: row.callbackNote,
      externalSessionId: row.externalSessionId,
      lastCallAt: row.lastCallAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toCall(row: typeof schema.calls.$inferSelect): CallView {
    return {
      id: row.id,
      threadId: row.threadId,
      agentId: row.agentId,
      direction: row.direction,
      twilioCallSid: row.twilioCallSid,
      fromE164: row.fromE164,
      toE164: row.toE164,
      status: row.status,
      objective: row.objective,
      policy: parsePolicy(row.policySnapshot),
      simulated: row.simulated === 1,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      endReason: row.endReason,
    };
  }

  function toSegment(row: typeof schema.transcriptSegments.$inferSelect): SegmentView {
    return {
      id: row.id,
      callId: row.callId,
      threadId: row.threadId,
      seq: row.seq,
      speaker: row.speaker,
      text: row.text,
      lang: row.lang,
      interrupted: row.interrupted === 1,
      createdAt: row.createdAt,
    };
  }

  function toPolicy(row: typeof schema.policies.$inferSelect): PolicyView {
    return {
      id: row.id,
      agentId: row.agentId,
      name: row.name,
      objective: row.objective,
      allowedActions: parseStringArray(row.allowedActions),
      forbiddenActions: parseStringArray(row.forbiddenActions),
      approvalRules: parseRules(row.approvalRules),
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toApproval(row: typeof schema.approvals.$inferSelect): ApprovalView {
    return {
      id: row.id,
      callId: row.callId,
      threadId: row.threadId,
      action: row.action,
      payload: parseObject(row.payload),
      status: row.status,
      note: row.note,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    };
  }

  function threadWithContact(row: typeof schema.threads.$inferSelect): ThreadView {
    const contact = db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, row.contactId))
      .get();
    return toThread(row, contact?.e164 ?? "");
  }

  return {
    close: opened.close,

    resetPresence() {
      db.update(schema.agents)
        .set({ status: "offline", updatedAt: stamp() })
        .run();
    },

    createAgent(input: {
      name: string;
      adapter: string;
      adapterConfig?: Record<string, unknown>;
      voice?: Partial<VoiceProfile>;
    }) {
      if (!ADAPTERS.has(input.adapter)) throw new HttpError(400, "unknown adapter");
      const token = createToken();
      const ts = stamp();
      const row = {
        id: createId("agt"),
        name: input.name.trim(),
        adapter: input.adapter,
        adapterConfig: JSON.stringify(input.adapterConfig ?? {}),
        tokenHash: hashToken(token),
        status: "offline",
        defaultPolicyId: null,
        voice: JSON.stringify({ ...DEFAULT_VOICE, ...input.voice }),
        createdAt: ts,
        updatedAt: ts,
      };
      if (!row.name) throw new HttpError(400, "name is required");
      db.insert(schema.agents).values(row).run();
      return { agent: toAgent(row), token };
    },

    listAgents() {
      return db
        .select()
        .from(schema.agents)
        .orderBy(desc(schema.agents.createdAt))
        .all()
        .map(toAgent);
    },

    getAgent(id: string) {
      return toAgent(requireAgent(id));
    },

    agentSecrets(id: string) {
      const config = parseObject(requireAgent(id).adapterConfig);
      return {
        hermesToken: typeof config.hermesToken === "string" ? config.hermesToken : "",
      };
    },

    authenticate(agentId: string, token: string) {
      const row = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
      if (!row || !tokenMatches(row.tokenHash, token)) return null;
      return toAgent(row);
    },

    authenticateToken(token: string) {
      const hash = hashToken(token);
      const row = db.select().from(schema.agents).where(eq(schema.agents.tokenHash, hash)).get();
      return row ? toAgent(row) : null;
    },

    updateAgent(
      id: string,
      patch: {
        name?: string;
        adapter?: string;
        adapterConfig?: Record<string, unknown>;
        voice?: Partial<VoiceProfile>;
        defaultPolicyId?: string | null;
      },
    ) {
      const current = requireAgent(id);
      if (patch.adapter && !ADAPTERS.has(patch.adapter)) throw new HttpError(400, "unknown adapter");
      const voice = { ...parseVoice(current.voice), ...patch.voice };
      const adapterConfig = patch.adapterConfig ?? parseObject(current.adapterConfig);
      db.update(schema.agents)
        .set({
          name: patch.name?.trim() || current.name,
          adapter: patch.adapter ?? current.adapter,
          adapterConfig: JSON.stringify(adapterConfig),
          voice: JSON.stringify(voice),
          defaultPolicyId:
            patch.defaultPolicyId === undefined ? current.defaultPolicyId : patch.defaultPolicyId,
          updatedAt: stamp(),
        })
        .where(eq(schema.agents.id, id))
        .run();
      return this.getAgent(id);
    },

    rotateToken(id: string) {
      requireAgent(id);
      const token = createToken();
      db.update(schema.agents)
        .set({ tokenHash: hashToken(token), updatedAt: stamp() })
        .where(eq(schema.agents.id, id))
        .run();
      return { agent: this.getAgent(id), token };
    },

    setStatus(id: string, status: "online" | "offline") {
      db.update(schema.agents)
        .set({ status, updatedAt: stamp() })
        .where(eq(schema.agents.id, id))
        .run();
    },

    createNumber(input: {
      agentId: string;
      e164: string;
      twilioSid?: string | null;
      localOnly: boolean;
    }) {
      requireAgent(input.agentId);
      const existingAgent = db
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.agentId, input.agentId), eq(schema.phoneNumbers.status, "active")))
        .get();
      if (existingAgent) throw new HttpError(409, "agent already has a phone number");
      const existingNumber = db
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.e164, input.e164), eq(schema.phoneNumbers.status, "active")))
        .get();
      if (existingNumber) throw new HttpError(409, "phone number is already bound");
      const row = {
        id: createId("num"),
        agentId: input.agentId,
        e164: input.e164,
        twilioSid: input.twilioSid ?? null,
        status: "active",
        localOnly: input.localOnly ? 1 : 0,
        createdAt: stamp(),
      };
      db.insert(schema.phoneNumbers).values(row).run();
      return toNumber(row);
    },

    listNumbers() {
      return db
        .select()
        .from(schema.phoneNumbers)
        .where(eq(schema.phoneNumbers.status, "active"))
        .orderBy(desc(schema.phoneNumbers.createdAt))
        .all()
        .map(toNumber);
    },

    getNumber(id: string) {
      const row = db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, id)).get();
      if (!row) throw new HttpError(404, "phone number not found");
      return toNumber(row);
    },

    numberForAgent(agentId: string) {
      const row = db
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.agentId, agentId), eq(schema.phoneNumbers.status, "active")))
        .get();
      return row ? toNumber(row) : null;
    },

    numberByE164(e164: string) {
      const row = db
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.e164, e164), eq(schema.phoneNumbers.status, "active")))
        .get();
      return row ? toNumber(row) : null;
    },

    releaseNumber(id: string) {
      const row = this.getNumber(id);
      db.update(schema.phoneNumbers)
        .set({ status: "released" })
        .where(eq(schema.phoneNumbers.id, id))
        .run();
      return { ...row, status: "released" };
    },

    upsertContact(agentId: string, e164: string, displayName?: string) {
      const existing = db
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.agentId, agentId), eq(schema.contacts.e164, e164)))
        .get();
      if (existing) {
        if (displayName) {
          db.update(schema.contacts)
            .set({ displayName })
            .where(eq(schema.contacts.id, existing.id))
            .run();
          return toContact({ ...existing, displayName });
        }
        return toContact(existing);
      }
      const row = {
        id: createId("ctc"),
        agentId,
        e164,
        displayName: displayName ?? null,
        createdAt: stamp(),
      };
      db.insert(schema.contacts).values(row).run();
      return toContact(row);
    },

    upsertThread(agentId: string, contactId: string) {
      const existing = db
        .select()
        .from(schema.threads)
        .where(and(eq(schema.threads.agentId, agentId), eq(schema.threads.contactId, contactId)))
        .get();
      if (existing) return threadWithContact(existing);
      const ts = stamp();
      const row = {
        id: createId("thr"),
        agentId,
        contactId,
        summary: "",
        currentGoal: "",
        pendingState: "{}",
        callbackStatus: "none",
        callbackAt: null,
        callbackNote: null,
        externalSessionId: null,
        lastCallAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(schema.threads).values(row).run();
      return threadWithContact(row);
    },

    getThread(id: string) {
      const row = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
      if (!row) throw new HttpError(404, "thread not found");
      return threadWithContact(row);
    },

    listThreads(agentId?: string) {
      const rows = agentId
        ? db.select().from(schema.threads).where(eq(schema.threads.agentId, agentId)).all()
        : db.select().from(schema.threads).all();
      return rows
        .map((row) => threadWithContact(row))
        .sort((a, b) => (b.lastCallAt ?? b.updatedAt).localeCompare(a.lastCallAt ?? a.updatedAt));
    },

    updateThread(id: string, patch: ThreadPatch) {
      const current = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
      if (!current) throw new HttpError(404, "thread not found");
      if (patch.callbackStatus && !CALLBACKS.has(patch.callbackStatus)) {
        throw new HttpError(400, "invalid callback status");
      }
      db.update(schema.threads)
        .set({
          summary: patch.summary ?? current.summary,
          currentGoal: patch.currentGoal ?? current.currentGoal,
          pendingState:
            patch.pendingState === undefined
              ? current.pendingState
              : JSON.stringify(patch.pendingState ?? {}),
          callbackStatus: patch.callbackStatus ?? current.callbackStatus,
          callbackAt: patch.callbackAt === undefined ? current.callbackAt : patch.callbackAt,
          callbackNote: patch.callbackNote === undefined ? current.callbackNote : patch.callbackNote,
          externalSessionId:
            patch.externalSessionId === undefined
              ? current.externalSessionId
              : patch.externalSessionId,
          updatedAt: stamp(),
        })
        .where(eq(schema.threads.id, id))
        .run();
      return this.getThread(id);
    },

    touchThread(id: string, at: string) {
      db.update(schema.threads)
        .set({ lastCallAt: at, updatedAt: at })
        .where(eq(schema.threads.id, id))
        .run();
    },

    dueCallbacks(at: string) {
      return db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.callbackStatus, "scheduled"))
        .all()
        .map((row) => threadWithContact(row))
        .filter((thread) => thread.callbackAt !== null && thread.callbackAt <= at);
    },

    createCall(input: {
      threadId: string;
      agentId: string;
      direction: "inbound" | "outbound";
      twilioCallSid?: string | null;
      fromE164: string;
      toE164: string;
      status: string;
      objective: string;
      policy: Policy;
      simulated: boolean;
      endedAt?: string | null;
      endReason?: string | null;
      durationSec?: number | null;
    }) {
      const row = {
        id: createId("call"),
        threadId: input.threadId,
        agentId: input.agentId,
        direction: input.direction,
        twilioCallSid: input.twilioCallSid ?? null,
        fromE164: input.fromE164,
        toE164: input.toE164,
        status: input.status,
        objective: input.objective,
        policySnapshot: JSON.stringify(input.policy),
        simulated: input.simulated ? 1 : 0,
        startedAt: stamp(),
        endedAt: input.endedAt ?? null,
        durationSec: input.durationSec ?? null,
        endReason: input.endReason ?? null,
      };
      db.insert(schema.calls).values(row).run();
      this.touchThread(input.threadId, row.startedAt);
      return toCall(row);
    },

    updateCall(
      id: string,
      patch: Partial<{
        twilioCallSid: string | null;
        status: string;
        endedAt: string | null;
        durationSec: number | null;
        endReason: string | null;
      }>,
    ) {
      const current = db.select().from(schema.calls).where(eq(schema.calls.id, id)).get();
      if (!current) throw new HttpError(404, "call not found");
      db.update(schema.calls)
        .set({
          twilioCallSid: patch.twilioCallSid === undefined ? current.twilioCallSid : patch.twilioCallSid,
          status: patch.status ?? current.status,
          endedAt: patch.endedAt === undefined ? current.endedAt : patch.endedAt,
          durationSec: patch.durationSec === undefined ? current.durationSec : patch.durationSec,
          endReason: patch.endReason === undefined ? current.endReason : patch.endReason,
        })
        .where(eq(schema.calls.id, id))
        .run();
      return this.getCall(id);
    },

    getCall(id: string) {
      const row = db.select().from(schema.calls).where(eq(schema.calls.id, id)).get();
      if (!row) throw new HttpError(404, "call not found");
      return toCall(row);
    },

    getCallBySid(sid: string) {
      const row = db.select().from(schema.calls).where(eq(schema.calls.twilioCallSid, sid)).get();
      return row ? toCall(row) : null;
    },

    listCalls(filter: { agentId?: string; threadId?: string } = {}) {
      const rows = db.select().from(schema.calls).orderBy(desc(schema.calls.startedAt)).all();
      return rows
        .filter((row) => (filter.agentId ? row.agentId === filter.agentId : true))
        .filter((row) => (filter.threadId ? row.threadId === filter.threadId : true))
        .slice(0, 100)
        .map(toCall);
    },

    addTurn(input: {
      threadId: string;
      callId?: string | null;
      channel: "call" | "sms";
      who: "contact" | "agent" | "system";
      text: string;
      interrupted?: boolean;
    }) {
      const row = {
        id: createId("trn"),
        threadId: input.threadId,
        callId: input.callId ?? null,
        channel: input.channel,
        who: input.who,
        text: input.text,
        interrupted: input.interrupted ? 1 : 0,
        createdAt: stamp(),
      };
      db.insert(schema.turns).values(row).run();
      this.touchThread(input.threadId, row.createdAt);
      return {
        id: row.id,
        threadId: row.threadId,
        callId: row.callId,
        channel: row.channel as "call" | "sms",
        who: row.who as "contact" | "agent" | "system",
        text: row.text,
        createdAt: row.createdAt,
      };
    },

    listTurns(threadId: string, limit = 50) {
      const rows = db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(desc(schema.turns.createdAt))
        .limit(limit)
        .all();
      return rows.reverse().map((row) => ({
        id: row.id,
        threadId: row.threadId,
        callId: row.callId,
        channel: row.channel as "call" | "sms",
        who: row.who as "contact" | "agent" | "system",
        text: row.text,
        createdAt: row.createdAt,
      }));
    },

    addSegment(input: {
      callId: string;
      threadId: string;
      speaker: "contact" | "agent" | "system";
      text: string;
      lang?: string | null;
      interrupted?: boolean;
    }) {
      const turn = this.addTurn({
        threadId: input.threadId,
        callId: input.callId,
        channel: "call",
        who: input.speaker,
        text: input.text,
        interrupted: input.interrupted,
      });
      return {
        id: turn.id,
        callId: input.callId,
        threadId: input.threadId,
        seq: this.listSegments(input.callId).length,
        speaker: input.speaker,
        text: input.text,
        lang: input.lang ?? null,
        interrupted: Boolean(input.interrupted),
        createdAt: turn.createdAt,
      };
    },

    listSegments(callId: string) {
      return db
        .select()
        .from(schema.turns)
        .where(and(eq(schema.turns.callId, callId), eq(schema.turns.channel, "call")))
        .orderBy(schema.turns.createdAt)
        .all()
        .map((row, index) => ({
          id: row.id,
          callId: row.callId ?? callId,
          threadId: row.threadId,
          seq: index + 1,
          speaker: row.who,
          text: row.text,
          lang: null as string | null,
          interrupted: row.interrupted === 1,
          createdAt: row.createdAt,
        }));
    },

    recentSegments(threadId: string, limit = 20) {
      return this.listTurns(threadId, limit)
        .filter((turn) => turn.channel === "call")
        .map((turn) => ({ speaker: turn.who, text: turn.text }));
    },

    addMessage(input: {
      threadId: string;
      agentId: string;
      direction: "inbound" | "outbound";
      fromE164: string;
      toE164: string;
      body: string;
      twilioSid?: string | null;
      status: string;
    }) {
      const turn = this.addTurn({
        threadId: input.threadId,
        channel: "sms",
        who: input.direction === "outbound" ? "agent" : "contact",
        text: input.body,
      });
      return {
        id: turn.id,
        threadId: input.threadId,
        agentId: input.agentId,
        direction: input.direction,
        fromE164: input.fromE164,
        toE164: input.toE164,
        body: input.body,
        twilioSid: input.twilioSid ?? null,
        status: input.status,
        createdAt: turn.createdAt,
      };
    },

    listMessages(threadId: string) {
      return this.listTurns(threadId, 200)
        .filter((turn) => turn.channel === "sms")
        .map((turn) => ({
          id: turn.id,
          threadId: turn.threadId,
          direction: turn.who === "agent" ? "outbound" : "inbound",
          fromE164: "",
          body: turn.text,
          status: turn.who === "agent" ? "sent" : "received",
          createdAt: turn.createdAt,
        }));
    },

    createPolicy(input: {
      agentId: string;
      name: string;
      objective: string;
      allowedActions: string[];
      forbiddenActions: string[];
      approvalRules: ApprovalRule[];
      isDefault: boolean;
    }) {
      requireAgent(input.agentId);
      if (input.isDefault) this.clearDefault(input.agentId);
      const ts = stamp();
      const row = {
        id: createId("pol"),
        agentId: input.agentId,
        name: input.name.trim() || "policy",
        objective: input.objective,
        allowedActions: JSON.stringify(input.allowedActions),
        forbiddenActions: JSON.stringify(input.forbiddenActions),
        approvalRules: JSON.stringify(input.approvalRules),
        isDefault: input.isDefault ? 1 : 0,
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(schema.policies).values(row).run();
      if (input.isDefault) {
        db.update(schema.agents)
          .set({ defaultPolicyId: row.id, updatedAt: ts })
          .where(eq(schema.agents.id, input.agentId))
          .run();
      }
      return toPolicy(row);
    },

    listPolicies(agentId?: string) {
      const rows = agentId
        ? db.select().from(schema.policies).where(eq(schema.policies.agentId, agentId)).all()
        : db.select().from(schema.policies).all();
      return rows.map(toPolicy);
    },

    getPolicy(id: string) {
      const row = db.select().from(schema.policies).where(eq(schema.policies.id, id)).get();
      if (!row) throw new HttpError(404, "policy not found");
      return toPolicy(row);
    },

    resolvePolicy(agentId: string, policyId?: string | null): Policy {
      if (policyId) {
        const policy = this.getPolicy(policyId);
        if (policy.agentId !== agentId) throw new HttpError(404, "policy not found");
        return policy;
      }
      const agent = requireAgent(agentId);
      if (!agent.defaultPolicyId) return { ...EMPTY_POLICY };
      const policy = db
        .select()
        .from(schema.policies)
        .where(eq(schema.policies.id, agent.defaultPolicyId))
        .get();
      return policy ? toPolicy(policy) : { ...EMPTY_POLICY };
    },

    clearDefault(agentId: string) {
      db.update(schema.policies)
        .set({ isDefault: 0, updatedAt: stamp() })
        .where(eq(schema.policies.agentId, agentId))
        .run();
    },

    updatePolicy(
      id: string,
      patch: {
        name?: string;
        objective?: string;
        allowedActions?: string[];
        forbiddenActions?: string[];
        approvalRules?: ApprovalRule[];
        isDefault?: boolean;
      },
    ) {
      const current = db.select().from(schema.policies).where(eq(schema.policies.id, id)).get();
      if (!current) throw new HttpError(404, "policy not found");
      if (patch.isDefault) this.clearDefault(current.agentId);
      const ts = stamp();
      db.update(schema.policies)
        .set({
          name: patch.name ?? current.name,
          objective: patch.objective ?? current.objective,
          allowedActions: JSON.stringify(patch.allowedActions ?? parseStringArray(current.allowedActions)),
          forbiddenActions: JSON.stringify(
            patch.forbiddenActions ?? parseStringArray(current.forbiddenActions),
          ),
          approvalRules: JSON.stringify(patch.approvalRules ?? parseRules(current.approvalRules)),
          isDefault: patch.isDefault === undefined ? current.isDefault : patch.isDefault ? 1 : 0,
          updatedAt: ts,
        })
        .where(eq(schema.policies.id, id))
        .run();
      if (patch.isDefault === true) {
        db.update(schema.agents)
          .set({ defaultPolicyId: id, updatedAt: ts })
          .where(eq(schema.agents.id, current.agentId))
          .run();
      }
      if (patch.isDefault === false) {
        const agent = requireAgent(current.agentId);
        if (agent.defaultPolicyId === id) {
          db.update(schema.agents)
            .set({ defaultPolicyId: null, updatedAt: ts })
            .where(eq(schema.agents.id, current.agentId))
            .run();
        }
      }
      return this.getPolicy(id);
    },

    deletePolicy(id: string) {
      const current = this.getPolicy(id);
      db.delete(schema.policies).where(eq(schema.policies.id, id)).run();
      const agent = requireAgent(current.agentId);
      if (agent.defaultPolicyId === id) {
        db.update(schema.agents)
          .set({ defaultPolicyId: null, updatedAt: stamp() })
          .where(eq(schema.agents.id, current.agentId))
          .run();
      }
    },

    createApproval(input: {
      callId: string;
      threadId: string;
      action: string;
      payload: Record<string, unknown>;
    }) {
      const row = {
        id: createId("appr"),
        callId: input.callId,
        threadId: input.threadId,
        action: input.action,
        payload: JSON.stringify(input.payload),
        status: "pending",
        note: null,
        createdAt: stamp(),
        decidedAt: null,
      };
      db.insert(schema.approvals).values(row).run();
      return toApproval(row);
    },

    getApproval(id: string) {
      const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
      if (!row) throw new HttpError(404, "approval not found");
      return toApproval(row);
    },

    listApprovals(status?: string) {
      const rows = status
        ? db.select().from(schema.approvals).where(eq(schema.approvals.status, status)).all()
        : db.select().from(schema.approvals).all();
      return rows
        .map(toApproval)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);
    },

    resolveApproval(id: string, status: string, note: string | null) {
      const current = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
      if (!current) throw new HttpError(404, "approval not found");
      if (current.status !== "pending") return toApproval(current);
      db.update(schema.approvals)
        .set({ status, note, decidedAt: stamp() })
        .where(eq(schema.approvals.id, id))
        .run();
      return this.getApproval(id);
    },

    createConnectSession() {
      const ts = stamp();
      const row = {
        code: `con_${createToken()}`,
        status: "waiting_for_agent",
        agentName: null,
        adapter: null,
        adapterConfig: "{}",
        agentId: null,
        requestedE164: null,
        policyJson: null,
        gatewayToken: null,
        bridgeStatus: null,
        bridgeError: null,
        lastError: null,
        createdAt: ts,
        updatedAt: ts,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      };
      db.insert(schema.connectSessions).values(row).run();
      return toConnect(row);
    },

    getConnectSession(code: string) {
      const row = db.select().from(schema.connectSessions).where(eq(schema.connectSessions.code, code)).get();
      if (!row) throw new HttpError(404, "connect link not found");
      if (row.expiresAt < stamp() && !["completed", "denied", "expired"].includes(row.status)) {
        db.update(schema.connectSessions)
          .set({ status: "expired", updatedAt: stamp() })
          .where(eq(schema.connectSessions.code, code))
          .run();
        return toConnect({ ...row, status: "expired" });
      }
      return toConnect(row);
    },

    updateConnectSession(
      code: string,
      patch: Partial<{
        status: string;
        agentName: string | null;
        adapter: string | null;
        adapterConfig: Record<string, unknown>;
        agentId: string | null;
        requestedE164: string | null;
        policyJson: string | null;
        gatewayToken: string | null;
        bridgeStatus: string | null;
        bridgeError: string | null;
        lastError: string | null;
      }>,
    ) {
      const current = db.select().from(schema.connectSessions).where(eq(schema.connectSessions.code, code)).get();
      if (!current) throw new HttpError(404, "connect link not found");
      db.update(schema.connectSessions)
        .set({
          status: patch.status ?? current.status,
          agentName: patch.agentName === undefined ? current.agentName : patch.agentName,
          adapter: patch.adapter === undefined ? current.adapter : patch.adapter,
          adapterConfig:
            patch.adapterConfig === undefined ? current.adapterConfig : JSON.stringify(patch.adapterConfig),
          agentId: patch.agentId === undefined ? current.agentId : patch.agentId,
          requestedE164: patch.requestedE164 === undefined ? current.requestedE164 : patch.requestedE164,
          policyJson: patch.policyJson === undefined ? current.policyJson : patch.policyJson,
          gatewayToken: patch.gatewayToken === undefined ? current.gatewayToken : patch.gatewayToken,
          bridgeStatus: patch.bridgeStatus === undefined ? current.bridgeStatus : patch.bridgeStatus,
          bridgeError: patch.bridgeError === undefined ? current.bridgeError : patch.bridgeError,
          lastError: patch.lastError === undefined ? current.lastError : patch.lastError,
          updatedAt: stamp(),
        })
        .where(eq(schema.connectSessions.code, code))
        .run();
      return this.getConnectSession(code);
    },

    listHermesBridges() {
      return this.listVoiceBridges().filter((item) => item.kind === "hermes");
    },

    listVoiceBridges(): Array<
      | {
          kind: "hermes";
          agentId: string;
          hermesWsUrl: string;
          hermesToken: string;
          gatewayToken: string;
        }
      | {
          kind: "openclaw";
          agentId: string;
          hermesWsUrl: string;
          hermesToken: string;
          gatewayToken: string;
        }
    > {
      const bridges: Array<
        | {
            kind: "hermes";
            agentId: string;
            hermesWsUrl: string;
            hermesToken: string;
            gatewayToken: string;
          }
        | {
            kind: "openclaw";
            agentId: string;
            hermesWsUrl: string;
            hermesToken: string;
            gatewayToken: string;
          }
      > = [];
      for (const row of db.select().from(schema.agents).all()) {
        const config = parseObject(row.adapterConfig);
        if (typeof config.gatewayToken !== "string") continue;
        if (
          row.adapter === "hermes" &&
          typeof config.hermesWsUrl === "string" &&
          config.hermesWsUrl.startsWith("ws")
        ) {
          bridges.push({
            kind: "hermes",
            agentId: row.id,
            hermesWsUrl: config.hermesWsUrl,
            hermesToken: typeof config.hermesToken === "string" ? config.hermesToken : "",
            gatewayToken: config.gatewayToken,
          });
        } else if (row.adapter === "openclaw") {
          bridges.push({
            kind: "openclaw",
            agentId: row.id,
            hermesWsUrl: "",
            hermesToken: "",
            gatewayToken: config.gatewayToken,
          });
        }
      }
      return bridges;
    },
  };
}

export type ConnectSessionView = {
  code: string;
  status: string;
  agentName: string | null;
  adapter: string | null;
  adapterConfig: Record<string, unknown>;
  agentId: string | null;
  requestedE164: string | null;
  policyJson: string | null;
  gatewayToken: string | null;
  bridgeStatus: string | null;
  bridgeError: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

function toConnect(row: typeof schema.connectSessions.$inferSelect): ConnectSessionView {
  return {
    code: row.code,
    status: row.status,
    agentName: row.agentName,
    adapter: row.adapter,
    adapterConfig: parseObject(row.adapterConfig),
    agentId: row.agentId,
    requestedE164: row.requestedE164,
    policyJson: row.policyJson,
    gatewayToken: row.gatewayToken,
    bridgeStatus: row.bridgeStatus,
    bridgeError: row.bridgeError,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function publicAdapterConfig(config: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...config };
  delete copy.gatewayToken;
  delete copy.hermesToken;
  return copy;
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    return [];
  }
  return [];
}

function parseRules(raw: string): ApprovalRule[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const action = "action" in item && typeof item.action === "string" ? item.action : "";
      const when = "when" in item ? item.when : null;
      if (!action) return [];
      if (when === "always") return [{ action, when }];
      if (
        when &&
        typeof when === "object" &&
        "amountUsdGt" in when &&
        typeof when.amountUsdGt === "number"
      ) {
        return [{ action, when: { amountUsdGt: when.amountUsdGt } }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

function parsePolicy(raw: string): Policy {
  const body = parseObject(raw);
  return {
    objective: typeof body.objective === "string" ? body.objective : "",
    allowedActions: Array.isArray(body.allowedActions)
      ? body.allowedActions.filter((item): item is string => typeof item === "string")
      : [],
    forbiddenActions: Array.isArray(body.forbiddenActions)
      ? body.forbiddenActions.filter((item): item is string => typeof item === "string")
      : [],
    approvalRules: parseRules(JSON.stringify(body.approvalRules ?? [])),
  };
}
