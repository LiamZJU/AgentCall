export type VoiceProfile = {
  language: string;
  ttsProvider: string;
  voice: string;
  transcriptionProvider: string;
  speechModel: string;
};

export const DEFAULT_VOICE: VoiceProfile = {
  language: "en-US",
  ttsProvider: "Google",
  voice: "en-US-Journey-O",
  transcriptionProvider: "Deepgram",
  speechModel: "nova-3-general",
};

export function parseVoice(raw: string): VoiceProfile {
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceProfile>;
    return { ...DEFAULT_VOICE, ...parsed };
  } catch {
    return { ...DEFAULT_VOICE };
  }
}
