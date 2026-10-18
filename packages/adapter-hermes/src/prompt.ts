import type { Policy } from "@agentphone/protocol";

export type PhoneBrief = {
  summary?: string;
  currentGoal?: string;
  pendingState?: Record<string, unknown>;
  callbackStatus?: string;
  callbackAt?: string | null;
  callbackNote?: string | null;
  recent?: Array<{ speaker: string; text: string }>;
};

export function livePrompt(input: {
  direction: string;
  from: string;
  to: string;
  objective: string;
  policy: Policy;
  thread: PhoneBrief;
  utterance: string;
}): string {
  const recent = (input.thread.recent ?? [])
    .map((line) => `${line.speaker}: ${line.text}`)
    .join("\n");
  return [
    "You are in a live phone call. Speak in short spoken sentences.",
    "Reply with only the words that should be played to the caller.",
    "Your own calendar, email, and browser tools still work. AgentPhone does not replace them.",
    "Before you agree to a price, purchase, or anything the policy marks as sensitive, call the agentphone phone_action tool and wait for the result.",
    `Direction: ${input.direction}`,
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Objective: ${input.objective || input.policy.objective || "(none)"}`,
    `Allowed actions: ${input.policy.allowedActions.join(", ") || "(any non-forbidden action)"}`,
    `Forbidden actions: ${input.policy.forbiddenActions.join(", ") || "(none)"}`,
    `Approval rules: ${JSON.stringify(input.policy.approvalRules)}`,
    `Thread summary: ${input.thread.summary || "(none)"}`,
    `Current goal: ${input.thread.currentGoal || "(none)"}`,
    `Pending: ${JSON.stringify(input.thread.pendingState ?? {})}`,
    `Callback: ${input.thread.callbackStatus ?? "none"} ${input.thread.callbackAt ?? ""} ${input.thread.callbackNote ?? ""}`.trim(),
    recent ? `Recent transcript:\n${recent}` : "Recent transcript: (none)",
    `Caller just said: ${input.utterance}`,
  ].join("\n");
}

export function summaryPrompt(): string {
  return [
    "The phone call has ended.",
    "Reply with JSON only, no markdown.",
    '{"summary":"","currentGoal":"","pendingState":{}}',
    "summary is under 400 characters. pendingState is a JSON object.",
  ].join("\n");
}

export function parseSummary(text: string): {
  summary: string;
  currentGoal: string;
  pendingState: Record<string, unknown>;
} | null {
  const stripped = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    return {
      summary: typeof value.summary === "string" ? value.summary : "",
      currentGoal: typeof value.currentGoal === "string" ? value.currentGoal : "",
      pendingState:
        value.pendingState && typeof value.pendingState === "object"
          ? (value.pendingState as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}
