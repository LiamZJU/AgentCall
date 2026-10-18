import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  adapter: text("adapter").notNull(),
  adapterConfig: text("adapter_config").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status").notNull(),
  defaultPolicyId: text("default_policy_id"),
  voice: text("voice").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const phoneNumbers = sqliteTable("phone_numbers", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  e164: text("e164").notNull(),
  twilioSid: text("twilio_sid"),
  status: text("status").notNull(),
  localOnly: integer("local_only").notNull(),
  createdAt: text("created_at").notNull(),
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  e164: text("e164").notNull(),
  displayName: text("display_name"),
  createdAt: text("created_at").notNull(),
});

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  contactId: text("contact_id").notNull(),
  summary: text("summary").notNull(),
  currentGoal: text("current_goal").notNull(),
  pendingState: text("pending_state").notNull(),
  callbackStatus: text("callback_status").notNull(),
  callbackAt: text("callback_at"),
  callbackNote: text("callback_note"),
  externalSessionId: text("external_session_id"),
  lastCallAt: text("last_call_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const calls = sqliteTable("calls", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  agentId: text("agent_id").notNull(),
  direction: text("direction").notNull(),
  twilioCallSid: text("twilio_call_sid"),
  fromE164: text("from_e164").notNull(),
  toE164: text("to_e164").notNull(),
  status: text("status").notNull(),
  objective: text("objective").notNull(),
  policySnapshot: text("policy_snapshot").notNull(),
  simulated: integer("simulated").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationSec: integer("duration_sec"),
  endReason: text("end_reason"),
});

export const transcriptSegments = sqliteTable("transcript_segments", {
  id: text("id").primaryKey(),
  callId: text("call_id").notNull(),
  threadId: text("thread_id").notNull(),
  seq: integer("seq").notNull(),
  speaker: text("speaker").notNull(),
  text: text("text").notNull(),
  lang: text("lang"),
  interrupted: integer("interrupted").notNull(),
  createdAt: text("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  agentId: text("agent_id").notNull(),
  direction: text("direction").notNull(),
  fromE164: text("from_e164").notNull(),
  toE164: text("to_e164").notNull(),
  body: text("body").notNull(),
  twilioSid: text("twilio_sid"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  allowedActions: text("allowed_actions").notNull(),
  forbiddenActions: text("forbidden_actions").notNull(),
  approvalRules: text("approval_rules").notNull(),
  isDefault: integer("is_default").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const connectSessions = sqliteTable("connect_sessions", {
  code: text("code").primaryKey(),
  status: text("status").notNull(),
  agentName: text("agent_name"),
  adapter: text("adapter"),
  adapterConfig: text("adapter_config").notNull(),
  agentId: text("agent_id"),
  requestedE164: text("requested_e164"),
  policyJson: text("policy_json"),
  gatewayToken: text("gateway_token"),
  bridgeStatus: text("bridge_status"),
  bridgeError: text("bridge_error"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  callId: text("call_id").notNull(),
  threadId: text("thread_id").notNull(),
  action: text("action").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
});
