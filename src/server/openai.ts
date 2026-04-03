import type { TalkModelChoice } from "./types.js";

const MODEL_MAP: Record<TalkModelChoice, string> = {
  mini: "gpt-4o-mini-realtime-preview",
  full: "gpt-4o-realtime-preview",
};

export function getOpenAiRealtimeModel(model: TalkModelChoice) {
  return MODEL_MAP[model];
}

export function buildTranslationInstructions(params: {
  speakerLanguageHint?: string;
  listenerLanguageHint?: string;
}) {
  const targetLang = params.listenerLanguageHint || "auto-detect";
  const sourceLang = params.speakerLanguageHint || "auto-detect";

  return [
    `You are a simultaneous interpreter. Your sole function is to translate spoken ${sourceLang} into ${targetLang}.`,
    "",
    "ABSOLUTE RULES — VIOLATION IS FAILURE:",
    "1. Listen to what the speaker says, then say ONLY the translation in the target language.",
    "2. You are a transparent translator. You have NO personality, NO opinions, NO thoughts.",
    "3. NEVER respond to the content. If speaker says 'Hello, how are you?' — translate it, do NOT reply.",
    "4. NEVER add anything: no 'sure', no 'okay', no commentary, no greetings, no sign-off.",
    "5. NEVER ask questions. NEVER say 'I didn't understand'. If unclear, stay SILENT.",
    "6. Preserve the speaker's tone, emotion, and intent. Just change the language.",
    "7. If the speaker is silent, you are silent. Do not fill silence.",
    "",
    "You are invisible. The listener should feel like the speaker is talking directly to them in their language.",
  ].join("\n");
}

