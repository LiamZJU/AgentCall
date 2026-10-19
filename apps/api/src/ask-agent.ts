import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HermesClient } from "@agentphone/adapter-hermes";

const execFileAsync = promisify(execFile);

export type AgentLink = {
  adapter: string;
  hermesWsUrl: string;
  hermesToken: string;
  command: string;
};

type HeldHermes = {
  client: HermesClient;
  ready: Promise<void>;
};

const hermesByUrl = new Map<string, HeldHermes>();

export async function askAgent(input: {
  link: AgentLink;
  threadId: string;
  sessionId: string | null;
  prompt: string;
  onDelta?: (token: string) => void;
}): Promise<{ text: string; sessionId: string | null }> {
  if (input.link.adapter === "hermes") {
    if (!input.link.hermesWsUrl) throw new Error("Hermes URL is missing");
    try {
      return await hermesTurn(input);
    } catch {
      hermesByUrl.delete(input.link.hermesWsUrl);
      return await hermesTurn(input);
    }
  }
  if (input.link.adapter === "openclaw") {
    const text = await runOpenClaw(input.threadId, input.prompt);
    return { text, sessionId: input.sessionId };
  }
  if (!input.link.command.trim()) throw new Error("no local command configured");
  const text = await runCommand(input.link.command, input.prompt);
  return { text, sessionId: input.sessionId };
}

export function interruptAgent(url: string, sessionId: string): void {
  const held = hermesByUrl.get(url);
  if (!held || !sessionId) return;
  void held.client.interrupt(sessionId);
}

async function hermesTurn(input: {
  link: AgentLink;
  sessionId: string | null;
  prompt: string;
  onDelta?: (token: string) => void;
}): Promise<{ text: string; sessionId: string | null }> {
  const client = await openHermes(input.link.hermesWsUrl, input.link.hermesToken);
  const sessionId = await client.ensureSession(input.sessionId);
  let streamed = "";
  const text = await client.turn(sessionId, input.prompt, {
    onDelta: (token) => {
      streamed += token;
      input.onDelta?.(token);
    },
    onTool: () => undefined,
    onComplete: () => undefined,
  });
  return { text: text || streamed, sessionId };
}

async function openHermes(url: string, token: string): Promise<HermesClient> {
  let held = hermesByUrl.get(url);
  if (!held) {
    const client = new HermesClient(url, token);
    held = { client, ready: client.connect() };
    hermesByUrl.set(url, held);
  }
  try {
    await held.ready;
    return held.client;
  } catch (error) {
    hermesByUrl.delete(url);
    throw error;
  }
}

async function runOpenClaw(threadId: string, prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentcall-"));
  const file = join(dir, "turn.txt");
  await writeFile(file, prompt, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "openclaw",
      ["agent", "--session-key", `agentcall:${threadId}`, "--message-file", file, "--json"],
      { timeout: 90_000, windowsHide: true, shell: true, maxBuffer: 2_000_000 },
    );
    return openclawText(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function openclawText(stdout: string): string {
  const parsed = JSON.parse(stdout) as { final?: string; payloads?: Array<{ text?: string }> };
  const text = parsed.final || parsed.payloads?.find((item) => item.text)?.text || "";
  if (!text.trim()) throw new Error("OpenClaw returned no text");
  return text.trim();
}

function runCommand(command: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      env: { ...process.env, AGENTCALL_PROMPT: prompt },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("command timed out"));
    }, 90_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.trim() || `command exited ${code}`));
      else if (!out.trim()) reject(new Error("command returned no text"));
      else resolve(out.trim());
    });
    child.stdin.end(prompt);
  });
}
