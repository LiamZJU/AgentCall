import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function findRepoRoot(start = process.cwd()): string {
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function loadEnvFiles(): void {
  const root = findRepoRoot();
  loadEnvFile(join(root, ".env"));
  loadEnvFile(join(root, "apps", "api", ".env"));
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type AppConfig = {
  port: number;
  host: string;
  databasePath: string;
  operatorKey: string;
  publicBaseUrl: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  skipTwilioSignature: boolean;
  devSimulate: boolean;
  approvalTimeoutMs: number;
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const port = overrides.port ?? Number(process.env.PORT ?? 8787);
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const publicBaseUrl = (
    overrides.publicBaseUrl ??
    process.env.PUBLIC_BASE_URL ??
    `http://127.0.0.1:${port}`
  ).replace(/\/$/, "");
  return {
    port,
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    databasePath: overrides.databasePath ?? process.env.DATABASE_PATH ?? "./data/agentphone.db",
    operatorKey: overrides.operatorKey ?? process.env.OPERATOR_KEY ?? "dev-operator",
    publicBaseUrl,
    twilioAccountSid: overrides.twilioAccountSid ?? process.env.TWILIO_ACCOUNT_SID ?? "",
    twilioAuthToken: overrides.twilioAuthToken ?? process.env.TWILIO_AUTH_TOKEN ?? "",
    skipTwilioSignature:
      overrides.skipTwilioSignature ?? process.env.TWILIO_SKIP_SIGNATURE === "1",
    devSimulate: overrides.devSimulate ?? nodeEnv !== "production",
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? 60_000,
  };
}

export function wsOrigin(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}
