import type { Policy } from "@agentphone/protocol";

export type PhoneBrief = {
  callbackStatus?: string;
  callbackAt?: string | null;
  callbackNote?: string | null;
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
  return [
    `Phone call. They just said: ${input.utterance}`,
    "Reply with only the next words to say out loud. One or two short sentences.",
  ].join("\n");
}
