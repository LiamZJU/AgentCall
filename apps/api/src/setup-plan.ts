export type SetupFacts = {
  twilioSid: string;
  twilioToken: string;
  publicUrl: string;
  name: string;
  adapter: string;
  hermesWsUrl: string;
  proposedNumber: string;
  proposedLocality: string;
  approvedNumber: string;
  boundNumber: string;
};

export type SetupPlan = {
  status: string;
  needsUser: boolean;
  ask: string;
  instruction: string;
  rerun: string;
};

const SETUP = "pnpm --filter @agentphone/api agentphone --";

export function planSetup(facts: SetupFacts): SetupPlan {
  if (!facts.twilioSid || !facts.twilioToken) {
    return {
      status: "need_twilio",
      needsUser: true,
      ask: "请把 Twilio Account SID（AC 开头）和 Auth Token 发给我。它们在 Twilio Console 的 Account 页面。我不能替你注册账号或完成付款验证。",
      instruction: "Ask the user that question. When they reply, rerun the command with the values they gave. Do not ask them to edit files.",
      rerun: `${SETUP} --twilio-sid ACxxxxxxxx --twilio-token YOUR_TOKEN`,
    };
  }
  if (!facts.publicUrl.startsWith("https://")) {
    return {
      status: "need_public_url",
      needsUser: false,
      ask: "",
      instruction:
        "Inbound calls and SMS need a public https URL. Start a tunnel to http://127.0.0.1:8787, for example: cloudflared tunnel --url http://127.0.0.1:8787. Then rerun with --public-url. Ask the user only if you cannot start a tunnel.",
      rerun: `${SETUP} --public-url https://YOUR_TUNNEL`,
    };
  }
  if (!facts.name || !facts.adapter || (facts.adapter === "hermes" && !facts.hermesWsUrl.startsWith("ws"))) {
    return {
      status: "need_identity",
      needsUser: false,
      ask: "",
      instruction:
        "You are the agent receiving this phone. If you are Hermes, pass --adapter hermes and your /api/ws URL. If you are OpenClaw, pass --adapter openclaw. Otherwise pass --adapter generic. Ask the user only when you cannot find the Hermes WebSocket.",
      rerun: `${SETUP} --name "Your Name" --adapter hermes --hermes-url ws://127.0.0.1:9119/api/ws`,
    };
  }
  if (!facts.boundNumber && !facts.approvedNumber) {
    const place = facts.proposedLocality ? `（${facts.proposedLocality}）` : "";
    return {
      status: "need_number_approval",
      needsUser: Boolean(facts.proposedNumber),
      ask: facts.proposedNumber
        ? `我准备购买美国号码 ${facts.proposedNumber}${place}，用来接打电话和收发短信。Twilio 会按月收费。回复 ok 就购买，或给我一个三位区号。`
        : "",
      instruction: facts.proposedNumber
        ? "Ask the user that question. On ok, rerun with --approve-number set to that exact number. If they give an area code, rerun with --area-code."
        : "Search for a US local number with voice and SMS, remember it, and rerun so the user can approve that exact number.",
      rerun: facts.proposedNumber
        ? `${SETUP} --approve-number ${facts.proposedNumber}`
        : `${SETUP} --area-code 415`,
    };
  }
  return {
    status: "ready",
    needsUser: false,
    ask: "",
    instruction:
      "Apply credentials.wiring for your agent type, then reload. Do not show the token to the user. Tell them the phone number. Calls and SMS to that number now reach you.",
    rerun: "",
  };
}

export function isUsablePublicUrl(url: string): boolean {
  return url.startsWith("https://");
}
