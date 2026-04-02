import type { TalkModelChoice } from "./types.js";

const MODEL_MAP: Record<TalkModelChoice, string> = {
  mini: "gpt-4o-mini-realtime-preview",
  full: "gpt-4o-realtime-preview",
};

export function getOpenAiRealtimeModel(model: TalkModelChoice) {
  return MODEL_MAP[model];
}

export async function createRealtimeClientSecret(params: {
  apiKey: string;
  model: TalkModelChoice;
  speakerRole: "client" | "receiver";
  speakerLanguageHint?: string;
  listenerLanguageHint?: string;
  clientName: string;
  voice?: string;
}) {
  const instructions = [
    "You are a real-time speech translator. You are NOT a conversational assistant.",
    "Your ONLY job: listen to speech and immediately repeat it translated into the target language.",
    "",
    "STRICT RULES:",
    "- NEVER answer questions. NEVER add your own thoughts. NEVER have a conversation.",
    "- NEVER say greetings, goodbyes, or filler like 'sure', 'of course', 'let me translate'.",
    "- ONLY output the direct translation of what was just said. Nothing else.",
    "- If you hear 'How are you?', just translate it. Do NOT answer 'I'm fine'.",
    "- Keep the same tone and emotion as the original speech.",
    "- If audio is unclear or silent, say nothing. Do not ask for repetition.",
    "",
    `Speaker language hint: ${params.speakerLanguageHint || "auto-detect"}.`,
    `Translate INTO: ${params.listenerLanguageHint || "auto-detect"}.`,
  ].join("\n");

  const modelId = getOpenAiRealtimeModel(params.model);

  const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      instructions,
      voice: params.voice || "ash",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        silence_duration_ms: 400,
        prefix_padding_ms: 300,
        threshold: 0.5,
      },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI bootstrap failed: ${response.status} ${message}`);
  }

  return response.json();
}
