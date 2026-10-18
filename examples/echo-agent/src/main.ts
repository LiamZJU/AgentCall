import { AgentPhoneClient } from "@agentphone/sdk";

const args = parseArgs(process.argv.slice(2));
const phone = new AgentPhoneClient({
  url: required(args, "url", "AGENTPHONE_URL"),
  agentId: required(args, "agent", "AGENTPHONE_AGENT_ID"),
  token: required(args, "token", "AGENTPHONE_TOKEN"),
});

phone.on("call.started", (event) => {
  const callId = event.callId ?? "";
  const direction = String(event.payload.direction ?? "inbound");
  console.error(`[echo-agent] ${direction} call ${callId}`);
  phone.say(callId, "Hello. I can hear you.", { last: true });
});

phone.on("utterance.final", (event) => {
  const callId = event.callId ?? "";
  const text = String(event.payload.text ?? "");
  console.error(`[echo-agent] caller said: ${text}`);
  phone.say(callId, `You said: ${text}`, { last: true });
});

phone.on("barge_in", (event) => {
  console.error(`[echo-agent] interrupted ${event.callId ?? ""}`);
});

phone.on("call.ended", (event) => {
  console.error(`[echo-agent] call ended ${event.callId ?? ""} ${String(event.payload.reason ?? "")}`);
});

await phone.connect();
console.error("[echo-agent] connected");

function parseArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    map.set(key.slice(2), argv[index + 1] ?? "");
    index += 1;
  }
  return map;
}

function required(map: Map<string, string>, flag: string, envName: string): string {
  const value = map.get(flag) || process.env[envName] || "";
  if (!value) {
    console.error(`[echo-agent] missing --${flag} or ${envName}`);
    process.exit(1);
  }
  return value;
}
