import twilio from "twilio";
import type { AppConfig } from "./config.js";
import { wsOrigin } from "./config.js";

export function twilioConfigured(config: AppConfig): boolean {
  return Boolean(config.twilioAccountSid && config.twilioAuthToken);
}

export function signatureIsValid(
  config: AppConfig,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (config.skipTwilioSignature) return true;
  if (!config.twilioAuthToken) return config.devSimulate;
  if (!signature) return false;
  const candidates = [url];
  if (url.startsWith("wss://")) candidates.push(`https://${url.slice("wss://".length)}`);
  if (url.startsWith("ws://")) candidates.push(`http://${url.slice("ws://".length)}`);
  return candidates.some((candidate) =>
    twilio.validateRequest(config.twilioAuthToken, signature, candidate, params),
  );
}

export function relayUrl(config: AppConfig): string {
  return `${wsOrigin(config.publicBaseUrl)}/twilio/relay`;
}

export async function searchUsNumbers(config: AppConfig, areaCode?: string) {
  const client = clientFor(config);
  const rows = await client.availablePhoneNumbers("US").local.list({
    ...(areaCode ? { areaCode: Number(areaCode) } : {}),
    voiceEnabled: true,
    smsEnabled: true,
    limit: 8,
  });
  return rows.map((row) => ({
    phoneNumber: row.phoneNumber,
    locality: row.locality,
    region: row.region,
  }));
}

export async function buyUsNumber(config: AppConfig, phoneNumber: string): Promise<string> {
  const client = clientFor(config);
  const created = await client.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl: `${config.publicBaseUrl}/twilio/voice`,
    voiceMethod: "POST",
    smsUrl: `${config.publicBaseUrl}/twilio/sms`,
    smsMethod: "POST",
    statusCallback: `${config.publicBaseUrl}/twilio/status`,
    statusCallbackMethod: "POST",
  });
  return created.sid;
}

export async function releaseSid(config: AppConfig, sid: string): Promise<void> {
  const client = clientFor(config);
  await client.incomingPhoneNumbers(sid).remove();
}

export async function dial(config: AppConfig, input: { callId: string; from: string; to: string }) {
  const client = clientFor(config);
  const created = await client.calls.create({
    to: input.to,
    from: input.from,
    url: `${config.publicBaseUrl}/twilio/voice?callId=${encodeURIComponent(input.callId)}`,
    method: "POST",
    statusCallback: `${config.publicBaseUrl}/twilio/status?callId=${encodeURIComponent(input.callId)}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });
  return created.sid;
}

export async function sendTwilioSms(config: AppConfig, from: string, to: string, body: string): Promise<string> {
  const client = clientFor(config);
  const message = await client.messages.create({ from, to, body });
  return message.sid;
}

export async function completeTwilioCall(config: AppConfig, sid: string): Promise<void> {
  const client = clientFor(config);
  await client.calls(sid).update({ status: "completed" });
}

function clientFor(config: AppConfig) {
  if (!twilioConfigured(config)) throw new Error("Twilio is not configured");
  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}
