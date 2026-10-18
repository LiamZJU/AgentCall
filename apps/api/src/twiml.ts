import type { VoiceProfile } from "./voice.js";

export function sayTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">${xml(message)}</Say><Hangup/></Response>`;
}

export function conversationRelayTwiml(input: {
  relayUrl: string;
  actionUrl: string;
  callId: string;
  voice: VoiceProfile;
  welcome: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${xml(input.actionUrl)}">
    <ConversationRelay
      url="${xml(input.relayUrl)}"
      welcomeGreeting="${xml(input.welcome)}"
      language="${xml(input.voice.language)}"
      ttsProvider="${xml(input.voice.ttsProvider)}"
      voice="${xml(input.voice.voice)}"
      transcriptionProvider="${xml(input.voice.transcriptionProvider)}"
      speechModel="${xml(input.voice.speechModel)}"
      interruptible="speech"
      dtmfDetection="true">
      <Parameter name="callId" value="${xml(input.callId)}"/>
    </ConversationRelay>
  </Connect>
</Response>`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
