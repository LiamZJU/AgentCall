import { pathToFileURL } from "node:url";
import { startHermesBridge } from "./bridge.js";

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArgs(process.argv.slice(2));
  await startHermesBridge({
    agentphoneUrl: required(args, "agentphone-url", "AGENTPHONE_URL"),
    agentId: required(args, "agent", "AGENTPHONE_AGENT_ID"),
    token: required(args, "token", "AGENTPHONE_TOKEN"),
    hermesWsUrl: required(args, "hermes-url", "HERMES_WS_URL"),
    hermesToken: process.env.HERMES_TOKEN ?? args.get("hermes-token") ?? "",
  });
  console.error("[agentphone-hermes] connected");
}

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
    console.error(`[agentphone-hermes] missing --${flag} or ${envName}`);
    process.exit(1);
  }
  return value;
}
