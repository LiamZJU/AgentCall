import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, loadEnvFiles } from "./config.js";
import { normalizeE164 } from "@agentphone/protocol";
import { planSetup, type SetupFacts } from "./setup-plan.js";

type SetupState = {
  name: string;
  adapter: string;
  hermesWsUrl: string;
  hermesToken: string;
  areaCode: string;
  proposedNumber: string;
  proposedLocality: string;
  approvedNumber: string;
  policyApproved: boolean;
  policyObjective: string;
  agentId: string;
  agentToken: string;
};

const root = findRepoRoot();
const statePath = join(root, "data", "setup.json");
const envPath = join(root, ".env");
const pidPath = join(root, "data", "api.pid");

loadEnvFiles();
const args = parseArgs(process.argv.slice(2));
const state = loadState();
applyArgs(state, args);
if (args.get("twilio-sid") || args.get("twilio-token") || args.get("public-url")) {
  writeEnv({
    ...(args.get("twilio-sid") ? { TWILIO_ACCOUNT_SID: args.get("twilio-sid") ?? "" } : {}),
    ...(args.get("twilio-token") ? { TWILIO_AUTH_TOKEN: args.get("twilio-token") ?? "" } : {}),
    ...(args.get("public-url") ? { PUBLIC_BASE_URL: (args.get("public-url") ?? "").replace(/\/$/, "") } : {}),
  });
  loadEnvFiles();
}
saveState(state);

try {
  await run(state);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "error",
    needsUser: true,
    ask: error instanceof Error ? error.message : "setup failed",
    instruction: "Tell the user this error. Continue only if they can resolve it.",
    rerun: "pnpm --filter @agentphone/api agentphone",
  }, null, 2)}\n`);
  process.exit(1);
}

async function run(current: SetupState) {
  let facts = currentFacts(current, "");
  let plan = planSetup(facts);
  if (["need_twilio", "need_public_url", "need_identity"].includes(plan.status)) return emit(plan);

  await ensureServer();
  const bound = await boundNumber(current);
  facts = currentFacts(current, bound);
  plan = planSetup(facts);
  if (plan.status === "need_number_approval" && !current.proposedNumber && !current.approvedNumber) {
    const searched = await searchNumber(current.areaCode);
    if (!searched) {
      return emit({
        status: "need_area_code",
        needsUser: true,
        ask: "没有找到同时支持电话和短信的美国号码。请给我一个三位区号，例如 415。",
        instruction: "Ask the user for an area code, then rerun with --area-code.",
        rerun: "pnpm --filter @agentphone/api agentphone -- --area-code 415",
      });
    }
    current.proposedNumber = searched.phoneNumber;
    current.proposedLocality = [searched.locality, searched.region].filter(Boolean).join(", ");
    saveState(current);
    plan = planSetup(currentFacts(current, bound));
  }
  if (current.approvedNumber && !bound) {
    await buyApprovedNumber(current);
    facts = currentFacts(current, current.approvedNumber);
    plan = planSetup(facts);
  }
  if (plan.status === "ready") {
    const ready = await finish(current);
    return emit({ ...plan, ...ready });
  }
  return emit(plan);
}

function emit(plan: unknown): never {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

function currentFacts(current: SetupState, bound: string): SetupFacts {
  return {
    twilioSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    twilioToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    publicUrl: process.env.PUBLIC_BASE_URL ?? "",
    name: current.name,
    adapter: current.adapter,
    hermesWsUrl: current.hermesWsUrl,
    proposedNumber: current.proposedNumber,
    proposedLocality: current.proposedLocality,
    approvedNumber: current.approvedNumber,
    boundNumber: bound,
  };
}

async function boundNumber(current: SetupState): Promise<string> {
  if (!current.agentId) return "";
  const numbers = await api<{ numbers: Array<{ agentId: string; e164: string }> }>("/v1/numbers");
  return numbers.numbers.find((number) => number.agentId === current.agentId)?.e164 ?? "";
}

async function searchNumber(areaCode: string) {
  const health = await ensureServer();
  if (!health.twilio) {
    process.stdout.write(`${JSON.stringify({
      status: "restart_server",
      needsUser: false,
      ask: "",
      instruction: "The API is running without the Twilio credentials saved in .env. Stop the process on port 8787, then run pnpm setup again.",
      rerun: "pnpm --filter @agentphone/api agentphone",
    }, null, 2)}\n`);
    process.exit(0);
  }
  const query = areaCode ? `?areaCode=${areaCode}` : "";
  const body = await api<{ numbers: Array<{ phoneNumber: string; locality: string; region: string }> }>(
    `/v1/numbers/available${query}`,
  );
  return body.numbers[0] ?? null;
}

async function buyApprovedNumber(current: SetupState) {
  await ensureServer();
  const agent = await ensureAgent(current);
  await api("/v1/numbers", {
    method: "POST",
    body: JSON.stringify({ agentId: agent.id, phoneNumber: current.approvedNumber }),
  });
}

async function finish(current: SetupState) {
  await ensureServer();
  const agent = await ensureAgent(current);
  const numbers = await api<{ numbers: Array<{ agentId: string; e164: string }> }>("/v1/numbers");
  const mine = numbers.numbers.find((number) => number.agentId === agent.id);
  if (current.adapter === "hermes" || current.adapter === "openclaw") await restartServer();
  const token = current.agentToken;
  const base = process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787";
  const yaml = [
    "mcp_servers:",
    "  agentcall:",
    `    url: ${base}/mcp`,
    "    headers:",
    `      Authorization: "Bearer ${token}"`,
  ].join("\n");
  return {
    credentials: {
      agentId: agent.id,
      token,
      phoneNumber: mine?.e164 ?? current.approvedNumber,
      gatewayUrl: base,
      mcp: { url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      wiring: {
        hermes: yaml,
        openclaw: `Add an MCP server named agentcall. Transport is streamable-http. URL is ${base}/mcp. Header Authorization is Bearer ${token}. Voice and SMS are connected with openclaw agent.`,
        generic: `Connect a WebSocket to ${base.replace(/^http/, "ws")}/v1/gateway. First message is {"v":1,"id":"hello","type":"session.hello","payload":{"agentId":"${agent.id}","token":"${token}"}}. On utterance.final, reply with say.delta. On sms.received, reply with sms.send. Also add the same MCP server so you can place calls and send texts yourself.`,
      },
    },
  };
}

async function ensureAgent(current: SetupState) {
  if (current.agentId && current.agentToken) {
    return { id: current.agentId, token: current.agentToken };
  }
  if (current.agentId && !current.agentToken) {
    const rotated = await api<{ agent: { id: string }; token: string }>(`/v1/agents/${current.agentId}/token`, {
      method: "POST",
    });
    current.agentToken = rotated.token;
    saveState(current);
    await api(`/v1/agents/${current.agentId}`, {
      method: "PATCH",
      body: JSON.stringify({
        adapterConfig: {
          hermesWsUrl: current.hermesWsUrl,
          hermesToken: current.hermesToken,
          gatewayToken: rotated.token,
        },
      }),
    });
    return { id: current.agentId, token: rotated.token };
  }
  const created = await api<{ agent: { id: string }; token: string }>("/v1/agents", {
    method: "POST",
    body: JSON.stringify({
      name: current.name,
      adapter: current.adapter,
      adapterConfig: { hermesWsUrl: current.hermesWsUrl, hermesToken: current.hermesToken },
    }),
  });
  current.agentId = created.agent.id;
  current.agentToken = created.token;
  saveState(current);
  await api(`/v1/agents/${created.agent.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      adapterConfig: {
        hermesWsUrl: current.hermesWsUrl,
        hermesToken: current.hermesToken,
        gatewayToken: created.token,
      },
    }),
  });
  return { id: created.agent.id, token: created.token };
}

async function ensureServer(): Promise<{ twilio: boolean }> {
  const existing = await health();
  const wantTwilio = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  if (existing && existing.twilio === wantTwilio) return existing;
  if (existing && existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (Number.isFinite(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else if (existing && existing.twilio !== wantTwilio) {
    throw new Error("API is already running without the saved Twilio credentials. Stop port 8787 and rerun setup.");
  }
  mkdirSync(join(root, "data"), { recursive: true });
  const child = spawn("pnpm", ["--filter", "@agentphone/api", "start"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    shell: true,
    env: process.env,
  });
  if (child.pid) writeFileSync(pidPath, String(child.pid));
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const live = await health();
    if (live) return live;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("API did not start on port 8787");
}

async function restartServer(): Promise<void> {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8"));
  if (Number.isFinite(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  await ensureServer();
}

async function health(): Promise<{ twilio: boolean } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? "8787"}/health`);
    if (!response.ok) return null;
    return (await response.json()) as { twilio: boolean };
  } catch {
    return null;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? "8787"}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.OPERATOR_KEY ?? "dev-operator"}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || text);
  return body as T;
}

function applyArgs(current: SetupState, flags: Map<string, string>) {
  if (flags.get("name")) current.name = flags.get("name") ?? "";
  if (flags.get("adapter")) current.adapter = flags.get("adapter") ?? "";
  if (flags.get("hermes-url")) current.hermesWsUrl = flags.get("hermes-url") ?? "";
  if (flags.get("hermes-token")) current.hermesToken = flags.get("hermes-token") ?? "";
  if (flags.get("area-code")) {
    current.areaCode = flags.get("area-code") ?? "";
    current.proposedNumber = "";
    current.proposedLocality = "";
    current.approvedNumber = "";
  }
  if (flags.get("approve-number")) current.approvedNumber = normalizeE164(flags.get("approve-number") ?? "");
  if (flags.has("approve-policy")) current.policyApproved = true;
  if (flags.get("policy-objective")) current.policyObjective = flags.get("policy-objective") ?? "";
}

function loadState(): SetupState {
  if (!existsSync(statePath)) {
    return {
      name: "",
      adapter: "",
      hermesWsUrl: "",
      hermesToken: "",
      areaCode: "",
      proposedNumber: "",
      proposedLocality: "",
      approvedNumber: "",
      policyApproved: false,
      policyObjective: "",
      agentId: "",
      agentToken: "",
    };
  }
  return { ...emptyState(), ...JSON.parse(readFileSync(statePath, "utf8")) };
}

function emptyState(): SetupState {
  return {
    name: "",
    adapter: "",
    hermesWsUrl: "",
    hermesToken: "",
    areaCode: "",
    proposedNumber: "",
    proposedLocality: "",
    approvedNumber: "",
    policyApproved: false,
    policyObjective: "",
    agentId: "",
    agentToken: "",
  };
}

function saveState(current: SetupState) {
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(statePath, JSON.stringify(current, null, 2));
}

function writeEnv(updates: Record<string, string>) {
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = current.split(/\r?\n/).filter((line) => line.trim() !== "");
  for (const [key, value] of Object.entries(updates)) {
    const rendered = `${key}=${JSON.stringify(value)}`;
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = rendered;
    else lines.push(rendered);
    process.env[key] = value;
  }
  if (!lines.some((line) => line.startsWith("OPERATOR_KEY="))) lines.push("OPERATOR_KEY=\"dev-operator\"");
  if (!lines.some((line) => line.startsWith("PORT="))) lines.push("PORT=\"8787\"");
  writeFileSync(envPath, `${lines.join("\n")}\n`);
}

function parseArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (name === "approve-policy") {
      map.set(name, "1");
      continue;
    }
    map.set(name, next ?? "");
    index += 1;
  }
  return map;
}
