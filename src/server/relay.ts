import WebSocket from "ws";
import { buildTranslationInstructions, getOpenAiRealtimeModel } from "./openai.js";
import type { SessionRole, TalkModelChoice } from "./types.js";

/* ── Types ── */

interface SingleRelay {
  ws: WebSocket;
  sessionReady: boolean;
}

interface RelayPair {
  clientRelay: SingleRelay | null;
  receiverRelay: SingleRelay | null;
  onTranslatedAudio: ((targetRole: SessionRole, pcm: Buffer) => void) | null;
}

/* ── Diagnostic counters ── */
interface RelayStats {
  feedChunks: number;
  feedBytes: number;
  audioAppendsSent: number;
  audioDeltasReceived: number;
  translatedCallbacks: number;
  translatedBytes: number;
  connectionState: string;
  feedMaxAmplitude: number;
  translatedMaxAmplitude: number;
  sessionCreated: boolean;
  sessionUpdated: boolean;
  firstDeltaAt: string | null;
  firstFeedAt: string | null;
  speechStarted: number;
  speechStopped: number;
  errors: number;
  destroyedAt?: string;
}

function freshStats(): RelayStats {
  return {
    feedChunks: 0,
    feedBytes: 0,
    audioAppendsSent: 0,
    audioDeltasReceived: 0,
    translatedCallbacks: 0,
    translatedBytes: 0,
    connectionState: "new",
    feedMaxAmplitude: 0,
    translatedMaxAmplitude: 0,
    sessionCreated: false,
    sessionUpdated: false,
    firstDeltaAt: null,
    firstFeedAt: null,
    speechStarted: 0,
    speechStopped: 0,
    errors: 0,
  };
}

/* ── Event log ── */
const relayEventLog: Array<{ t: string; msg: string }> = [];
const RELAY_EVENT_LOG_MAX = 200;

export function logEvent(msg: string) {
  if (relayEventLog.length >= RELAY_EVENT_LOG_MAX) relayEventLog.shift();
  relayEventLog.push({ t: new Date().toISOString(), msg });
  console.log(msg);
}

export function getRelayEventLog(): Array<{ t: string; msg: string }> {
  return relayEventLog;
}

const relayStatsMap = new Map<string, { client: RelayStats; receiver: RelayStats }>();

function getStatsForSession(sessionId: string) {
  let s = relayStatsMap.get(sessionId);
  if (!s) {
    s = { client: freshStats(), receiver: freshStats() };
    relayStatsMap.set(sessionId, s);
  }
  return s;
}

const relays = new Map<string, RelayPair>();

export function getRelayStats(): Record<string, { client: RelayStats; receiver: RelayStats }> {
  const out: Record<string, { client: RelayStats; receiver: RelayStats }> = {};
  relayStatsMap.forEach((stats, sid) => {
    out[sid] = stats;
  });
  return out;
}

function getOrCreatePair(sessionId: string): RelayPair {
  let pair = relays.get(sessionId);
  if (!pair) {
    pair = { clientRelay: null, receiverRelay: null, onTranslatedAudio: null };
    relays.set(sessionId, pair);
  }
  return pair;
}

function oppositeRole(role: SessionRole): SessionRole {
  return role === "client" ? "receiver" : "client";
}

/* ── Public API ── */

export function setOnTranslatedAudio(
  sessionId: string,
  cb: (targetRole: SessionRole, pcm: Buffer) => void,
) {
  const pair = getOrCreatePair(sessionId);
  pair.onTranslatedAudio = cb;
}

export async function createRelay(
  sessionId: string,
  role: SessionRole,
  config: {
    apiKey: string;
    model: TalkModelChoice;
    speakerLanguageHint?: string;
    listenerLanguageHint?: string;
    voice?: string;
  },
): Promise<void> {
  const pair = getOrCreatePair(sessionId);
  const targetRole = oppositeRole(role);
  const stats = getStatsForSession(sessionId);
  const roleStats = role === "client" ? stats.client : stats.receiver;
  const modelId = getOpenAiRealtimeModel(config.model);

  const instructions = buildTranslationInstructions({
    speakerLanguageHint: config.speakerLanguageHint,
    listenerLanguageHint: config.listenerLanguageHint,
  });

  return new Promise<void>((resolve, reject) => {
    const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(modelId)}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    const relay: SingleRelay = { ws, sessionReady: false };

    if (role === "client") {
      pair.clientRelay = relay;
    } else {
      pair.receiverRelay = relay;
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("OpenAI WebSocket connection timeout (10s)"));
      }
    }, 10000);

    ws.on("open", () => {
      roleStats.connectionState = "open";
      logEvent(`relay [${sessionId}/${role}] WS opened to OpenAI model=${modelId}`);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));

        if (msg.type === "session.created") {
          roleStats.sessionCreated = true;
          logEvent(`relay [${sessionId}/${role}] session.created received`);

          // Send session.update with our config
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              instructions,
              voice: config.voice || "ash",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: 100,
                prefix_padding_ms: 100,
                threshold: 0.7,
              },
            },
          }));
        }

        if (msg.type === "session.updated") {
          roleStats.sessionUpdated = true;
          relay.sessionReady = true;
          roleStats.connectionState = "ready";
          logEvent(`relay [${sessionId}/${role}] session.updated — ready`);

          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve();
          }
        }

        // Translated audio delta from OpenAI
        if (msg.type === "response.audio.delta" && msg.delta) {
          roleStats.audioDeltasReceived++;

          if (roleStats.audioDeltasReceived === 1) {
            roleStats.firstDeltaAt = new Date().toISOString();
            logEvent(`relay [${sessionId}/${role}] first audio delta received`);
          }

          // Decode base64 → PCM16 Buffer
          const pcmBuf = Buffer.from(msg.delta, "base64");

          // Track max amplitude
          if (pcmBuf.length >= 2) {
            const samples = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
            let maxAmp = 0;
            for (let i = 0; i < samples.length; i++) {
              const abs = Math.abs(samples[i]);
              if (abs > maxAmp) maxAmp = abs;
            }
            if (maxAmp > roleStats.translatedMaxAmplitude) roleStats.translatedMaxAmplitude = maxAmp;

            // Log first few deltas in detail
            if (roleStats.audioDeltasReceived <= 3) {
              const first10 = Array.from(samples.slice(0, 10));
              logEvent(`relay [${sessionId}/${role}] audio delta #${roleStats.audioDeltasReceived}: bytes=${pcmBuf.length}, samples=${samples.length}, maxAmp=${maxAmp}, first10=${JSON.stringify(first10)}`);
            }
          }

          roleStats.translatedCallbacks++;
          roleStats.translatedBytes += pcmBuf.length;

          if (roleStats.translatedCallbacks % 100 === 0) {
            console.log(`relay [${sessionId}/${role}] translated: ${roleStats.translatedCallbacks} deltas, ${roleStats.translatedBytes} bytes → target=${targetRole}, maxAmp=${roleStats.translatedMaxAmplitude}`);
          }

          pair.onTranslatedAudio?.(targetRole, pcmBuf);
        }

        if (msg.type === "input_audio_buffer.speech_started") {
          roleStats.speechStarted++;
          if (roleStats.speechStarted <= 5) {
            logEvent(`relay [${sessionId}/${role}] speech started (#${roleStats.speechStarted})`);
          }
        }

        if (msg.type === "input_audio_buffer.speech_stopped") {
          roleStats.speechStopped++;
          if (roleStats.speechStopped <= 5) {
            logEvent(`relay [${sessionId}/${role}] speech stopped (#${roleStats.speechStopped})`);
          }
        }

        if (msg.type === "error") {
          roleStats.errors++;
          logEvent(`relay [${sessionId}/${role}] OpenAI error: ${JSON.stringify(msg.error || msg).slice(0, 300)}`);
        }

      } catch (e) {
        roleStats.errors++;
        console.error(`relay [${sessionId}/${role}] message parse error:`, e);
      }
    });

    ws.on("error", (err) => {
      roleStats.connectionState = "error";
      logEvent(`relay [${sessionId}/${role}] WS error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on("close", (code, reason) => {
      roleStats.connectionState = "closed";
      logEvent(`relay [${sessionId}/${role}] WS closed: code=${code} reason=${String(reason).slice(0, 100)}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed before ready: ${code}`));
      }
    });
  });
}

/**
 * Feed raw PCM16 24kHz mono audio from browser mic into the OpenAI WebSocket.
 */
export function feedAudio(sessionId: string, role: SessionRole, pcmChunk: Buffer): void {
  const pair = relays.get(sessionId);
  if (!pair) return;

  const relay = role === "client" ? pair.clientRelay : pair.receiverRelay;
  if (!relay || !relay.sessionReady || relay.ws.readyState !== WebSocket.OPEN) return;

  // Skip invalid PCM16 chunks (must be even byte count, at least 2 bytes)
  if (pcmChunk.length < 2 || pcmChunk.length % 2 !== 0) return;

  const stats = getStatsForSession(sessionId);
  const roleStats = role === "client" ? stats.client : stats.receiver;

  roleStats.feedChunks++;
  roleStats.feedBytes += pcmChunk.length;

  if (roleStats.feedChunks === 1) {
    roleStats.firstFeedAt = new Date().toISOString();
    logEvent(`relay [${sessionId}/${role}] first feedAudio call, ${pcmChunk.length} bytes`);
  }

  // Track max amplitude
  if (pcmChunk.length >= 2) {
    const samples = new Int16Array(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.byteLength / 2);
    let maxAmp = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > maxAmp) maxAmp = abs;
    }
    if (maxAmp > roleStats.feedMaxAmplitude) roleStats.feedMaxAmplitude = maxAmp;
  }

  // Send PCM16 as base64 to OpenAI
  const base64 = pcmChunk.toString("base64");
  relay.ws.send(JSON.stringify({
    type: "input_audio_buffer.append",
    audio: base64,
  }));
  roleStats.audioAppendsSent++;

  if (roleStats.feedChunks % 100 === 0) {
    console.log(`feedAudio [${sessionId}/${role}]: ${roleStats.feedChunks} chunks, ${roleStats.feedBytes} bytes, ${roleStats.audioAppendsSent} appends sent, maxAmp=${roleStats.feedMaxAmplitude}`);
  }
}

/**
 * Destroy all relay connections for a session.
 */
export function destroyRelay(sessionId: string): void {
  const pair = relays.get(sessionId);
  if (!pair) return;

  for (const relay of [pair.clientRelay, pair.receiverRelay]) {
    if (!relay) continue;
    try {
      if (relay.ws.readyState === WebSocket.OPEN || relay.ws.readyState === WebSocket.CONNECTING) {
        relay.ws.close();
      }
    } catch (e) {
      console.error(`relay cleanup error [${sessionId}]:`, e);
    }
  }

  const finalStats = relayStatsMap.get(sessionId);
  if (finalStats) {
    finalStats.client.destroyedAt = new Date().toISOString();
    finalStats.receiver.destroyedAt = new Date().toISOString();
    logEvent(`relay destroyed [${sessionId}] final stats: ${JSON.stringify(finalStats)}`);
  } else {
    logEvent(`relay destroyed [${sessionId}] (no stats)`);
  }

  relays.delete(sessionId);
}

export function hasRelay(sessionId: string, role?: SessionRole): boolean {
  const pair = relays.get(sessionId);
  if (!pair) return false;
  if (!role) return !!(pair.clientRelay || pair.receiverRelay);
  return role === "client" ? !!pair.clientRelay : !!pair.receiverRelay;
}

export function activeRelaySessionIds(): string[] {
  return [...relays.keys()];
}
