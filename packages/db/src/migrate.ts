export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_config TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  default_policy_id TEXT,
  voice TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_numbers (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  e164 TEXT NOT NULL,
  twilio_sid TEXT,
  status TEXT NOT NULL,
  local_only INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  e164 TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  current_goal TEXT NOT NULL,
  pending_state TEXT NOT NULL,
  callback_status TEXT NOT NULL,
  callback_at TEXT,
  callback_note TEXT,
  external_session_id TEXT,
  last_call_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  twilio_call_sid TEXT,
  from_e164 TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  policy_snapshot TEXT NOT NULL,
  simulated INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_sec INTEGER,
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  lang TEXT,
  interrupted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,
  forbidden_actions TEXT NOT NULL,
  approval_rules TEXT NOT NULL,
  is_default INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_agent_e164 ON contacts(agent_id, e164);
CREATE UNIQUE INDEX IF NOT EXISTS threads_agent_contact ON threads(agent_id, contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_e164_active ON phone_numbers(e164) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_agent_active ON phone_numbers(agent_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS calls_thread ON calls(thread_id, started_at);
CREATE INDEX IF NOT EXISTS calls_sid ON calls(twilio_call_sid);
CREATE INDEX IF NOT EXISTS segments_call_seq ON transcript_segments(call_id, seq);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_e164 TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  body TEXT NOT NULL,
  twilio_sid TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS connect_sessions (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  agent_name TEXT,
  adapter TEXT,
  adapter_config TEXT NOT NULL,
  agent_id TEXT,
  requested_e164 TEXT,
  policy_json TEXT,
  gateway_token TEXT,
  bridge_status TEXT,
  bridge_error TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;
