import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ServerEvent } from "@agentphone/protocol";
import { AgentPhoneClient } from "@agentphone/sdk";
import { log } from "./log.js";

const exec = promisify(execFile);

export async function startOpenClawBridge(options: {
  agentphoneUrl: string;
  agentId: string;
  token: string;
}): Promise<{ close: () => void }> {
  const phone = new AgentPhoneClient({
    url: options.agentphoneUrl,
    agentId: options.agentId,
    token: options.token,
  });

  const ask = async (threadId: string, prompt: string) => {
    const dir = mkdtempSync(join(tmpdir(), "agentcall-"));
    const file = join(dir, "prompt.txt");
    writeFileSync(file, prompt, "utf8");
    const sessionKey = `agentcall:${threadId || "main"}`;
    const { stdout } = await exec(
      "openclaw",
      ["agent", "--session-key", sessionKey, "--message-file", file, "--json"],
      { timeout: 90_000, shell: true, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as { final?: string; payloads?: Array<{ text?: string }> };
    return (parsed.final || parsed.payloads?.[0]?.text || "").trim();
  };

  phone.on("utterance.final", (event: ServerEvent) => {
    const text = String(event.payload.text ?? "");
    const threadId = event.threadId ?? "";
    void ask(
      threadId,
      [
        "You are on a live phone call. Reply with only the words to speak.",
        `Caller said: ${text}`,
      ].join("\n"),
    )
      .then((reply) => {
        if (reply && event.callId) phone.say(event.callId, reply, { last: true });
      })
      .catch((error: unknown) => {
        log("openclaw call reply failed", { error: error instanceof Error ? error.message : "unknown" });
      });
  });

  phone.on("sms.received", (event: ServerEvent) => {
    const from = String(event.payload.from ?? "");
    const text = String(event.payload.body ?? "");
    const threadId = event.threadId ?? "";
    void ask(
      threadId,
      [
        "You received an SMS. Reply with only the text to send back.",
        "If you should not reply, write NO_REPLY.",
        `From: ${from}`,
        `Message: ${text}`,
      ].join("\n"),
    )
      .then((reply) => {
        if (reply && reply !== "NO_REPLY") phone.sms(from, reply);
      })
      .catch((error: unknown) => {
        log("openclaw sms reply failed", { error: error instanceof Error ? error.message : "unknown" });
      });
  });

  await phone.connect();
  log(`openclaw bridge online ${options.agentId}`);
  return {
    close() {
      phone.close();
    },
  };
}
