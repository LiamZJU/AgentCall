import { z } from "zod";

export const GATEWAY_VERSION = 1 as const;

const envelope = {
  v: z.literal(GATEWAY_VERSION),
  id: z.string().min(1),
  ts: z.string().optional(),
  callId: z.string().optional(),
  threadId: z.string().optional(),
};

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("session.hello"),
    payload: z.object({
      agentId: z.string().min(1),
      token: z.string().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("say.delta"),
    callId: z.string().min(1),
    payload: z.object({
      token: z.string(),
      last: z.boolean().optional(),
      preemptible: z.boolean().optional(),
      interruptible: z.boolean().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("action.propose"),
    callId: z.string().min(1),
    payload: z.object({
      action: z.string().min(1),
      arguments: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("thread.patch"),
    threadId: z.string().min(1),
    payload: z.object({
      summary: z.string().optional(),
      currentGoal: z.string().optional(),
      pendingState: z.record(z.unknown()).nullable().optional(),
      callbackStatus: z
        .enum(["none", "requested", "scheduled", "completed", "failed"])
        .optional(),
      callbackAt: z.string().nullable().optional(),
      callbackNote: z.string().nullable().optional(),
      externalSessionId: z.string().nullable().optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("call.hangup"),
    callId: z.string().min(1),
    payload: z.object({ reason: z.string().optional() }).optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("callback.schedule"),
    threadId: z.string().min(1),
    payload: z.object({
      at: z.string().min(1),
      note: z.string().optional(),
    }),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerEvent = {
  v: typeof GATEWAY_VERSION;
  id: string;
  ts: string;
  type: string;
  callId?: string;
  threadId?: string;
  payload: Record<string, unknown>;
};

export function serverEvent(
  type: string,
  payload: Record<string, unknown>,
  refs: { callId?: string; threadId?: string } = {},
): ServerEvent {
  return {
    v: GATEWAY_VERSION,
    id: `evt_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
    ts: new Date().toISOString(),
    type,
    ...refs,
    payload,
  };
}
