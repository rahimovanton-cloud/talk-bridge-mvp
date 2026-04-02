import type { TalkModelChoice } from "./types.js";

const MODEL_MAP: Record<TalkModelChoice, string> = {
  mini: "gpt-realtime-mini",
  full: "gpt-realtime",
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
}) {
  const instructions = [
    "You are a live interpreter for an in-person conversation.",
    `Current speaker role: ${params.speakerRole}.`,
    `Client name: ${params.clientName}.`,
    `Translate the speaker into the listener's language only.`,
    `Speaker language hint: ${params.speakerLanguageHint || "unknown"}.`,
    `Listener language hint: ${params.listenerLanguageHint || "unknown"}.`,
    "Output only the spoken translation.",
    "Do not add explanations, preambles, or meta commentary.",
    "If audio is unclear, briefly ask for repetition in the listener's language.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "realtime",
        model: getOpenAiRealtimeModel(params.model),
        instructions,
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
              silence_duration_ms: 300,
              prefix_padding_ms: 250,
            },
          },
          output: {
            voice: "marin",
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI bootstrap failed: ${response.status} ${message}`);
  }

  return response.json();
}
