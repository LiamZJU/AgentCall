import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { start } from "./index.js";

const started = await start({
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  operatorKey: "test-key",
  devSimulate: true,
  approvalTimeoutMs: 400,
  twilioAccountSid: "",
  twilioAuthToken: "",
  publicBaseUrl: "http://127.0.0.1:8787",
});

before(() => undefined);
after(async () => {
  await started.close();
});

const headers = {
  authorization: "Bearer test-key",
  "content-type": "application/json",
};

test("inbound call resumes the same thread and speaks back", async () => {
  const created = await api("/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Echo", adapter: "generic" }),
  });
  const agentId = created.agent.id as string;
  const token = created.token as string;
  await api("/v1/numbers/local", {
    method: "POST",
    body: JSON.stringify({ agentId, e164: "+1 (415) 555-0100" }),
  });

  const events = await connect(token, agentId);
  const inbound = await api("/v1/dev/inbound", {
    method: "POST",
    body: JSON.stringify({ to: "4155550100", from: "+1 628 555 0142" }),
  });
  assert.equal(inbound.connected, true);
  const startedEvent = await events.wait((event) => event.type === "call.started");
  assert.equal(startedEvent.threadId, inbound.thread.id);

  await api("/v1/dev/prompt", {
    method: "POST",
    body: JSON.stringify({ callId: inbound.call.id, text: "Can you price fifty units?" }),
  });
  await events.wait((event) => event.type === "utterance.final");
  events.send({
    type: "say.delta",
    callId: inbound.call.id,
    payload: { token: "Fifty units are ninety dollars.", last: true },
  });

  await waitFor(async () => {
    const detail = await api(`/v1/calls/${inbound.call.id}`);
    const text = detail.segments.map((segment: { text: string }) => segment.text).join(" ");
    return text.includes("ninety dollars");
  });

  events.send({ type: "call.hangup", callId: inbound.call.id, payload: { reason: "done" } });
  await events.wait((event) => event.type === "call.ended");

  const again = await api("/v1/dev/inbound", {
    method: "POST",
    body: JSON.stringify({ to: "+14155550100", from: "6285550142" }),
  });
  assert.equal(again.thread.id, inbound.thread.id);
  const resumed = await events.wait(
    (event) => event.type === "call.started" && event.callId === again.call.id,
  );
  const turns = resumed.payload.thread.turns as Array<{ text: string }>;
  assert.ok(turns.some((turn) => turn.text.includes("fifty units")));
  assert.ok(turns.some((turn) => turn.text.includes("ninety dollars")));
  events.close();
});

test("an inbound call connects before any agent socket", async () => {
  const created = await api("/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Away", adapter: "generic" }),
  });
  await api("/v1/numbers/local", {
    method: "POST",
    body: JSON.stringify({ agentId: created.agent.id, e164: "+14155550199" }),
  });
  const inbound = await api("/v1/dev/inbound", {
    method: "POST",
    body: JSON.stringify({ to: "+14155550199", from: "+14155550123" }),
  });
  assert.equal(inbound.connected, true);
  assert.equal(inbound.call.status, "in_progress");
});

test("a local command speaks the reply without a gateway socket", async () => {
  const created = await api("/v1/agents", {
    method: "POST",
    body: JSON.stringify({
      name: "Command",
      adapter: "generic",
      adapterConfig: { command: "node -e \"process.stdout.write('heard you')\"" },
    }),
  });
  await api("/v1/numbers/local", {
    method: "POST",
    body: JSON.stringify({ agentId: created.agent.id, e164: "+14155550177" }),
  });
  const inbound = await api("/v1/dev/inbound", {
    method: "POST",
    body: JSON.stringify({ to: "+14155550177", from: "+14155550123" }),
  });
  await api("/v1/dev/prompt", {
    method: "POST",
    body: JSON.stringify({ callId: inbound.call.id, text: "Is anyone there?" }),
  });
  const spoken = await waitForSegment(inbound.call.id as string, "heard you");
  assert.equal(spoken, "heard you");
});

test("a scheduled callback places another call on the same thread", async () => {
  const created = await api("/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Callback", adapter: "generic" }),
  });
  await api("/v1/numbers/local", {
    method: "POST",
    body: JSON.stringify({ agentId: created.agent.id, e164: "+14155550188" }),
  });
  const events = await connect(created.token, created.agent.id);
  const inbound = await api("/v1/dev/inbound", {
    method: "POST",
    body: JSON.stringify({ to: "+14155550188", from: "+14155550110" }),
  });
  await events.wait((event) => event.type === "call.started");
  events.send({ type: "call.hangup", callId: inbound.call.id, payload: { reason: "later" } });
  await events.wait((event) => event.type === "call.ended");
  await api(`/v1/threads/${inbound.thread.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      callbackStatus: "scheduled",
      callbackAt: new Date(Date.now() - 1000).toISOString(),
      callbackNote: "Call them back about the quote",
    }),
  });
  const dialed = events.wait((event) => event.type === "call.started" && event.payload.direction === "outbound");
  await api("/v1/dev/tick-callbacks", { method: "POST", body: "{}" });
  const event = await dialed;
  assert.equal(event.threadId, inbound.thread.id);
  const thread = await api(`/v1/threads/${inbound.thread.id}`);
  assert.equal(thread.thread.callbackStatus, "completed");
  events.close();
});

test("an agent binds a phone through the connect link and the human only approves", async () => {
  const created = await api("/v1/connect", { method: "POST", body: "{}" });
  const code = created.code as string;
  const page = await fetch(`${started.url}/connect/${code}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /等待 Agent 打开这个链接/);
  assert.match(html, /agentphone-connect/);

  const claimed = await publicJson(`/v1/connect/${code}/claim`, {
    name: "Desk",
    adapter: "generic",
  });
  assert.equal(claimed.status, "pending_agent_authorization");

  const approvedAgent = await publicJson(`/v1/connect/${code}/authorize-agent`, { decision: "approved" });
  assert.equal(approvedAgent.status, "awaiting_number_request");

  const requested = await publicJson(`/v1/connect/${code}/number`, { e164: "+14155550155" });
  assert.equal(requested.status, "pending_number_authorization");
  const rejectedNumber = await publicJson(`/v1/connect/${code}/authorize-number`, { decision: "denied" });
  assert.equal(rejectedNumber.status, "awaiting_number_request");

  await publicJson(`/v1/connect/${code}/number`, { e164: "4155550166" });
  const ready = await publicJson(`/v1/connect/${code}/authorize-number`, { decision: "approved" });
  assert.equal(ready.status, "credentials_ready");

  const humanView = await publicJson(`/v1/connect/${code}?as=human`);
  assert.equal(humanView.credentials, undefined);
  const agentView = await publicJson(`/v1/connect/${code}?as=agent`);
  assert.equal(agentView.status, "credentials_ready");
  assert.equal(typeof agentView.credentials.token, "string");
  assert.match(agentView.credentials.wiring.hermes, /Bearer /);

  const events = await connect(agentView.credentials.token, agentView.credentials.agentId);
  events.close();

  await publicJson(`/v1/connect/${code}/complete`, {});
  const done = await publicJson(`/v1/connect/${code}?as=human`);
  assert.equal(done.status, "completed");
  const agents = await api("/v1/agents");
  const bound = agents.agents.find((agent: { id: string }) => agent.id === agentView.credentials.agentId);
  assert.equal(bound.name, "Desk");
  assert.equal(bound.adapterConfig.gatewayToken, undefined);
  const numbers = await api("/v1/numbers");
  assert.equal(
    numbers.numbers.some((number: { e164: string; agentId: string }) => number.e164 === "+14155550166" && number.agentId === bound.id),
    true,
  );
});

test("an inbound SMS stays on the contact thread and the agent can text back", async () => {
  const created = await api("/v1/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Texter", adapter: "generic" }),
  });
  await api("/v1/numbers/local", {
    method: "POST",
    body: JSON.stringify({ agentId: created.agent.id, e164: "+14155550144" }),
  });
  const inbound = await fetch(`${started.url}/twilio/sms`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: "+14155550145",
      To: "+14155550144",
      Body: "Need a quote",
      MessageSid: "SM1",
    }),
  });
  assert.equal(inbound.status, 200);
  const threads = await api(`/v1/threads?agentId=${created.agent.id}`);
  const detail = await api(`/v1/threads/${threads.threads[0].id}`);
  assert.equal(detail.messages[0].body, "Need a quote");
  const sent = await fetch(`${started.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "sms_send", arguments: { to: "+14155550145", body: "Fifty dollars." } },
    }),
  });
  const payload = await sent.json();
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.simulated, true);
  assert.equal(result.needsUser, false);
});

async function publicJson(path: string, body?: unknown) {
  const response = await fetch(`${started.url}${path}`, {
    method: body === undefined && path.includes("?") ? "GET" : body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return parsed;
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${started.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return body;
}

async function connect(token: string, agentId: string) {
  const ws = new WebSocket(started.url.replace("http", "ws") + "/v1/gateway");
  const queue: Array<Record<string, any>> = [];
  const pending: Array<{
    predicate: (event: Record<string, any>) => boolean;
    resolve: (event: Record<string, any>) => void;
  }> = [];
  const deliver = (event: Record<string, any>) => {
    const index = pending.findIndex((waiter) => waiter.predicate(event));
    if (index >= 0) {
      pending.splice(index, 1)[0]?.resolve(event);
      return;
    }
    queue.push(event);
  };
  ws.addEventListener("message", (event) => deliver(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway open timeout")), 2000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({
        v: 1,
        id: "hello",
        type: "session.hello",
        payload: { agentId, token },
      }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("gateway error")));
  });
  const wait = (predicate: (event: Record<string, any>) => boolean) => {
    const existing = queue.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0]);
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event timeout: ${queue.map((item) => item.type).join(",")}`)), 2000);
      pending.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  };
  await wait((event) => event.type === "session.ready");
  return {
    send(message: Record<string, unknown>) {
      ws.send(JSON.stringify({ v: 1, id: `m_${Math.random().toString(16).slice(2)}`, ...message }));
    },
    wait,
    close() {
      ws.close();
    },
  };
}

async function waitForSegment(callId: string, text: string) {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const body = await api(`/v1/calls/${callId}`);
    const match = (body.segments as Array<{ speaker: string; text: string }>).find(
      (segment) => segment.speaker === "agent" && segment.text.includes(text),
    );
    if (match) return match.text;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`agent did not say ${text}`);
}

async function waitFor(check: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timeout");
}
