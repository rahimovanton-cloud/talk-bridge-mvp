import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
  RtpHeader,
  useOPUS,
} from "werift";
import OpusScript from "opusscript";
import { createRealtimeClientSecret, getOpenAiRealtimeModel } from "./openai.js";
import type { SessionRole, TalkModelChoice } from "./types.js";

/* ── Opus codec constants ── */
const OPUS_SAMPLE_RATE = 48000;
const OPUS_FRAME_DURATION_MS = 20;
const OPUS_FRAME_SIZE = (OPUS_SAMPLE_RATE * OPUS_FRAME_DURATION_MS) / 1000; // 960 samples
const PCM_INPUT_RATE = 24000;
const PCM_FRAME_SIZE = (PCM_INPUT_RATE * OPUS_FRAME_DURATION_MS) / 1000; // 480 samples

/* ── Types ── */

interface SingleRelay {
  pc: RTCPeerConnection;
  track: MediaStreamTrack;
  encoder: OpusScript;
  decoder: OpusScript;
  seqNum: number;
  timestamp: number;
  ssrc: number;
  pcmBuffer: Buffer; // accumulates incoming PCM until we have a full frame
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
  opusFramesSent: number;
  rtpReceived: number;
  decodeErrors: number;
  decodeEmpty: number;
  translatedCallbacks: number;
  translatedBytes: number;
  connectionState: string;
  feedMaxAmplitude: number;
  translatedMaxAmplitude: number;
  onTrackFired: boolean;
  firstRtpReceivedAt: string | null;
  firstFeedAt: string | null;
  destroyedAt?: string;
}

function freshStats(): RelayStats {
  return {
    feedChunks: 0,
    feedBytes: 0,
    opusFramesSent: 0,
    rtpReceived: 0,
    decodeErrors: 0,
    decodeEmpty: 0,
    translatedCallbacks: 0,
    translatedBytes: 0,
    connectionState: "new",
    feedMaxAmplitude: 0,
    translatedMaxAmplitude: 0,
    onTrackFired: false,
    firstRtpReceivedAt: null,
    firstFeedAt: null,
  };
}

/* ── Event log ── */
const relayEventLog: Array<{ t: string; msg: string }> = [];
const RELAY_EVENT_LOG_MAX = 200;

function logEvent(msg: string) {
  if (relayEventLog.length >= RELAY_EVENT_LOG_MAX) relayEventLog.shift();
  relayEventLog.push({ t: new Date().toISOString(), msg });
  console.log(msg);
}

/** Expose relay event log for debug endpoint */
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

/** Expose relay stats for debug endpoint */
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

/**
 * Resample PCM16 from inputRate to outputRate (simple linear interpolation).
 */
function resamplePcm16(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLen = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLen);
  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(a + frac * (b - a));
  }
  return output;
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

  // 1. Get ephemeral token
  const bootstrap = await createRealtimeClientSecret({
    apiKey: config.apiKey,
    model: config.model,
    speakerLanguageHint: config.speakerLanguageHint,
    listenerLanguageHint: config.listenerLanguageHint,
    voice: config.voice,
  });
  const secret = bootstrap.client_secret || bootstrap;
  const token: string = secret.value || secret;

  // 2. Create werift RTCPeerConnection with Opus codec
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        useOPUS({
          payloadType: 111,
        }),
      ],
    },
  });

  // 3. Create synthetic audio track for mic input
  const track = new MediaStreamTrack({ kind: "audio" });
  const transceiver = pc.addTransceiver(track, { direction: "sendrecv" });

  // 4. Opus encoder/decoder
  const encoder = new OpusScript(OPUS_SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
  const decoder = new OpusScript(OPUS_SAMPLE_RATE, 1, OpusScript.Application.AUDIO);

  const relay: SingleRelay = {
    pc,
    track,
    encoder,
    decoder,
    seqNum: Math.floor(Math.random() * 0xffff),
    timestamp: Math.floor(Math.random() * 0xffffffff),
    ssrc: transceiver.sender.ssrc ?? Math.floor(Math.random() * 0xffffffff),
    pcmBuffer: Buffer.alloc(0),
  };

  if (role === "client") {
    pair.clientRelay = relay;
  } else {
    pair.receiverRelay = relay;
  }

  // 5. Listen for translated audio from OpenAI via remote track
  const targetRole = oppositeRole(role);
  const stats = getStatsForSession(sessionId);
  const roleStats = role === "client" ? stats.client : stats.receiver;

  pc.onTrack.subscribe((remoteTrack) => {
    roleStats.onTrackFired = true;
    logEvent(`relay [${sessionId}/${role}] onTrack fired: remote track kind=${remoteTrack.kind}`);
    remoteTrack.onReceiveRtp.subscribe((rtp: RtpPacket) => {
      roleStats.rtpReceived++;
      if (roleStats.rtpReceived === 1) {
        roleStats.firstRtpReceivedAt = new Date().toISOString();
        logEvent(`relay [${sessionId}/${role}] first RTP received`);
      }
      if (roleStats.rtpReceived % 100 === 0) {
        console.log(`relay [${sessionId}/${role}] received ${roleStats.rtpReceived} translated RTP packets`);
      }
      try {
        // Decode Opus → PCM 48kHz → resample to 24kHz
        // Ensure payload is a proper Buffer (werift gives Uint8Array)
        const payloadBuf = Buffer.isBuffer(rtp.payload) ? rtp.payload : Buffer.from(rtp.payload);
        const decoded = decoder.decode(payloadBuf);
        if (!decoded || decoded.length === 0) {
          roleStats.decodeEmpty++;
          if (roleStats.decodeEmpty % 50 === 0) {
            console.log(`relay [${sessionId}/${role}] decode returned empty (${roleStats.decodeEmpty} total)`);
          }
          return;
        }

        const pcm48 = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);

        // Log first decoded frame in detail
        if (roleStats.rtpReceived <= 3) {
          const first10 = Array.from(pcm48.slice(0, 10));
          logEvent(`relay [${sessionId}/${role}] decode frame #${roleStats.rtpReceived}: payloadSize=${payloadBuf.length}, decodedBytes=${decoded.byteLength}, samples=${pcm48.length}, first10=${JSON.stringify(first10)}`);
        }

        // Track translated audio max amplitude
        let maxAmpTranslated = 0;
        for (let i = 0; i < pcm48.length; i++) {
          const abs = Math.abs(pcm48[i]);
          if (abs > maxAmpTranslated) maxAmpTranslated = abs;
        }
        if (maxAmpTranslated > roleStats.translatedMaxAmplitude) roleStats.translatedMaxAmplitude = maxAmpTranslated;

        const pcm24 = resamplePcm16(pcm48, OPUS_SAMPLE_RATE, PCM_INPUT_RATE);
        const outBuf = Buffer.from(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength);

        roleStats.translatedCallbacks++;
        roleStats.translatedBytes += outBuf.length;
        if (roleStats.translatedCallbacks % 100 === 0) {
          console.log(`relay [${sessionId}/${role}] onTranslatedAudio: ${roleStats.translatedCallbacks} callbacks, ${roleStats.translatedBytes} bytes total → target=${targetRole}`);
        }

        pair.onTranslatedAudio?.(targetRole, outBuf);
      } catch (e) {
        roleStats.decodeErrors++;
        console.error(`relay decode error [${sessionId}/${role}] (#${roleStats.decodeErrors}):`, e);
      }
    });
  });

  pc.connectionStateChange.subscribe((state) => {
    roleStats.connectionState = state;
    logEvent(`relay [${sessionId}/${role}] connection: ${state}`);
  });

  // ICE connection state logging
  pc.iceConnectionStateChange.subscribe((state) => {
    logEvent(`relay [${sessionId}/${role}] ICE: ${state}`);
  });

  // 6. SDP offer/answer with OpenAI
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const modelId = getOpenAiRealtimeModel(config.model);
  const sdpResponse = await fetch(
    `https://api.openai.com/v1/realtime?model=${encodeURIComponent(modelId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
      body: pc.localDescription!.sdp,
    },
  );

  if (!sdpResponse.ok) {
    const errText = await sdpResponse.text();
    pc.close();
    logEvent(`relay [${sessionId}/${role}] SDP exchange FAILED: ${sdpResponse.status} ${errText.slice(0, 200)}`);
    throw new Error(`OpenAI SDP exchange failed: ${sdpResponse.status} ${errText.slice(0, 300)}`);
  }

  const answerSdp = await sdpResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  logEvent(`relay [${sessionId}/${role}] SDP exchange success`);
  logEvent(`relay created [${sessionId}/${role}] model=${modelId}`);
}

/**
 * Feed raw PCM16 24kHz mono audio from browser mic into the OpenAI WebRTC connection.
 */
export function feedAudio(sessionId: string, role: SessionRole, pcmChunk: Buffer): void {
  const pair = relays.get(sessionId);
  if (!pair) return;

  const relay = role === "client" ? pair.clientRelay : pair.receiverRelay;
  if (!relay) return;

  const stats = getStatsForSession(sessionId);
  const roleStats = role === "client" ? stats.client : stats.receiver;

  roleStats.feedChunks++;
  roleStats.feedBytes += pcmChunk.length;

  if (roleStats.feedChunks === 1) {
    roleStats.firstFeedAt = new Date().toISOString();
    logEvent(`relay [${sessionId}/${role}] first feedAudio call`);
  }

  if (roleStats.feedChunks % 100 === 0) {
    console.log(`feedAudio [${sessionId}/${role}]: received ${roleStats.feedChunks} chunks, ${roleStats.feedBytes} bytes total, ${roleStats.opusFramesSent} opus frames sent`);
  }

  // Accumulate PCM until we have a full 20ms frame
  relay.pcmBuffer = Buffer.concat([relay.pcmBuffer, pcmChunk]);

  const frameSizeBytes = PCM_FRAME_SIZE * 2; // Int16 = 2 bytes per sample

  while (relay.pcmBuffer.length >= frameSizeBytes) {
    const frameData = relay.pcmBuffer.subarray(0, frameSizeBytes);
    relay.pcmBuffer = relay.pcmBuffer.subarray(frameSizeBytes);

    // Track incoming PCM max amplitude
    const samples = new Int16Array(frameData.buffer, frameData.byteOffset, frameData.byteLength / 2);
    let maxAmp = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > maxAmp) maxAmp = abs;
    }
    if (maxAmp > roleStats.feedMaxAmplitude) roleStats.feedMaxAmplitude = maxAmp;

    try {
      // Resample 24kHz → 48kHz for Opus
      const pcm24 = new Int16Array(
        frameData.buffer,
        frameData.byteOffset,
        frameData.byteLength / 2,
      );
      const pcm48 = resamplePcm16(pcm24, PCM_INPUT_RATE, OPUS_SAMPLE_RATE);

      // Encode to Opus
      const pcm48Buf = Buffer.from(pcm48.buffer, pcm48.byteOffset, pcm48.byteLength);
      const opusFrame = relay.encoder.encode(pcm48Buf, OPUS_FRAME_SIZE);

      // Log first encode
      if (roleStats.opusFramesSent < 3) {
        logEvent(`relay [${sessionId}/${role}] encode frame #${roleStats.opusFramesSent}: pcm48samples=${pcm48.length}, pcm48bytes=${pcm48Buf.length}, opusBytes=${opusFrame.length}, maxAmp=${maxAmp}`);
      }

      // Wrap in RTP
      const header = new RtpHeader();
      header.payloadType = 111;
      header.sequenceNumber = relay.seqNum++ & 0xffff;
      header.timestamp = relay.timestamp;
      header.ssrc = relay.ssrc;

      relay.timestamp = (relay.timestamp + OPUS_FRAME_SIZE) >>> 0;

      const rtp = new RtpPacket(header, opusFrame);
      relay.track.writeRtp(rtp);
      roleStats.opusFramesSent++;
    } catch (e) {
      console.error(`relay encode error [${sessionId}/${role}]:`, e);
    }
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
      relay.pc.close();
      relay.encoder.delete();
      relay.decoder.delete();
    } catch (e) {
      console.error(`relay cleanup error [${sessionId}]:`, e);
    }
  }

  // Log final stats — preserve in relayStatsMap with destroyedAt timestamp
  const finalStats = relayStatsMap.get(sessionId);
  if (finalStats) {
    finalStats.client.destroyedAt = new Date().toISOString();
    finalStats.receiver.destroyedAt = new Date().toISOString();
    logEvent(`relay destroyed [${sessionId}] final stats: ${JSON.stringify(finalStats)}`);
  } else {
    logEvent(`relay destroyed [${sessionId}] (no stats)`);
  }

  relays.delete(sessionId);
  // NOTE: intentionally NOT deleting from relayStatsMap so stats survive for debugging
}

/**
 * Check if relay exists for a session.
 */
export function hasRelay(sessionId: string, role?: SessionRole): boolean {
  const pair = relays.get(sessionId);
  if (!pair) return false;
  if (!role) return !!(pair.clientRelay || pair.receiverRelay);
  return role === "client" ? !!pair.clientRelay : !!pair.receiverRelay;
}

/**
 * Get all active session IDs with relays.
 */
export function activeRelaySessionIds(): string[] {
  return [...relays.keys()];
}
