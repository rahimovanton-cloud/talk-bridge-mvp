import "dotenv/config";

import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { getOpenAiRealtimeModel } from "./openai.js";
import { createRelay, destroyRelay, feedAudio, hasRelay, setOnTranslatedAudio, activeRelaySessionIds, getRelayStats, getRelayEventLog, logEvent } from "./relay.js";
import { SessionStore } from "./store.js";
import type { SessionCreateRequest, SessionRole, SessionStatus } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../../public");

const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const defaultClientName = process.env.DEFAULT_CLIENT_NAME || "Client";
const defaultClientPhotoUrl = process.env.DEFAULT_CLIENT_PHOTO_URL || "/assets/client-photo.jpg";
const defaultLanguageHint = process.env.DEFAULT_LANGUAGE_HINT || "en";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/api/session/signal" });
const store = new SessionStore();
const socketsBySession = new Map<string, Set<{ ws: WebSocket; role: SessionRole }>>();

/* ── Server-side audio diagnostic counters ── */
const serverAudioStats = new Map<string, { client: { wsBinaryIn: number; wsBinaryOut: number; outMaxAmplitude: number }; receiver: { wsBinaryIn: number; wsBinaryOut: number; outMaxAmplitude: number } }>();

function getServerAudioStats(sessionId: string) {
  let s = serverAudioStats.get(sessionId);
  if (!s) {
    s = { client: { wsBinaryIn: 0, wsBinaryOut: 0, outMaxAmplitude: 0 }, receiver: { wsBinaryIn: 0, wsBinaryOut: 0, outMaxAmplitude: 0 } };
    serverAudioStats.set(sessionId, s);
  }
  return s;
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

function getSessionSet(sessionId: string) {
  let set = socketsBySession.get(sessionId);
  if (!set) {
    set = new Set();
    socketsBySession.set(sessionId, set);
  }
  return set;
}

function broadcast(sessionId: string, event: unknown) {
  const set = socketsBySession.get(sessionId);
  if (!set) return;

  for (const entry of set) {
    if (entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify(event));
    }
  }
}

/** Send binary audio data to a specific role's WebSocket */
function sendBinaryToRole(sessionId: string, targetRole: SessionRole, data: Buffer) {
  const set = socketsBySession.get(sessionId);
  if (!set) return;

  const sas = getServerAudioStats(sessionId);
  const roleStats = targetRole === "client" ? sas.client : sas.receiver;
  roleStats.wsBinaryOut++;

  // Track max amplitude of outgoing PCM
  if (data.length >= 2) {
    const samples = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    let maxAmp = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > maxAmp) maxAmp = abs;
    }
    if (maxAmp > roleStats.outMaxAmplitude) roleStats.outMaxAmplitude = maxAmp;
  }

  if (roleStats.wsBinaryOut % 100 === 0) {
    console.log(`sendBinaryToRole [${sessionId}/${targetRole}]: sent ${roleStats.wsBinaryOut} frames, ${data.length} bytes last, outMaxAmp=${roleStats.outMaxAmplitude}`);
  }

  for (const entry of set) {
    if (entry.role === targetRole && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(data);
    }
  }
}

function publicSessionView(sessionId: string) {
  const session = store.getById(sessionId);
  if (!session) return null;
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    model: session.model,
    modelId: getOpenAiRealtimeModel(session.model),
    inviteUrl: session.inviteUrl,
    qrDataUrl: session.qrDataUrl,
    clientName: session.clientName,
    clientPhotoUrl: session.clientPhotoUrl,
    clientLanguageHint: session.clientLanguageHint,
    receiverLanguageHint: session.receiverLanguageHint,
    clientVoice: session.clientVoice,
    receiverVoice: session.receiverVoice,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
    clientState: session.clientState,
    receiverState: session.receiverState,
  };
}

function updateStatus(sessionId: string, status: SessionStatus, extra?: Record<string, unknown>) {
  const session = store.updateStatus(sessionId, status, extra as never);
  if (!session) return;
  broadcast(sessionId, {
    type: "session.updated",
    session: publicSessionView(sessionId),
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "talk-bridge-mvp", now: new Date().toISOString() });
});

// Voice preview via OpenAI TTS — cached in memory
const voicePreviewCache = new Map<string, Buffer>();
const VALID_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];

app.get("/api/voice/preview", async (req, res) => {
  const voice = String(req.query.voice || "").toLowerCase();
  if (!VALID_VOICES.includes(voice)) {
    return res.status(400).json({ error: "invalid_voice" });
  }

  const cached = voicePreviewCache.get(voice);
  if (cached) {
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" });
    return res.send(cached);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "no_api_key" });

  try {
    const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: "Hello, I am your translator. Привет, я ваш переводчик.",
        response_format: "mp3",
      }),
    });
    if (!ttsResp.ok) {
      const err = await ttsResp.text();
      return res.status(502).json({ error: "tts_failed", detail: err.slice(0, 200) });
    }
    const buf = Buffer.from(await ttsResp.arrayBuffer());
    voicePreviewCache.set(voice, buf);
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" });
    return res.send(buf);
  } catch (e) {
    return res.status(502).json({ error: "tts_error" });
  }
});

app.get("/join/:inviteToken", (_req, res) => {
  res.sendFile(path.join(publicDir, "join.html"));
});

app.get("/api/invite/:inviteToken", (req, res) => {
  const session = store.getByInviteToken(req.params.inviteToken);
  if (!session || session.status === "expired") {
    return res.status(404).json({ error: "invite_expired", message: "Ссылка устарела. Попросите показать новый QR." });
  }

  if (session.status === "created" || session.status === "qr_displayed") {
    updateStatus(session.id, "opened");
    updateStatus(session.id, "ringing");
  }

  return res.json({ session: publicSessionView(session.id) });
});

app.post("/api/session/create", async (req, res) => {
  const body = (req.body ?? {}) as SessionCreateRequest;
  if (body.model !== "mini" && body.model !== "full") {
    return res.status(400).json({ error: "invalid_model" });
  }

  const session = await store.createSession({
    baseUrl,
    model: body.model,
    clientName: body.clientName?.trim() || defaultClientName,
    clientPhotoUrl: body.clientPhotoUrl?.trim() || defaultClientPhotoUrl,
    clientLanguageHint: body.clientLanguageHint?.trim() || defaultLanguageHint,
    clientVoice: body.clientVoice?.trim() || undefined,
    receiverVoice: body.receiverVoice?.trim() || undefined,
  });

  updateStatus(session.id, "qr_displayed");

  return res.status(201).json({
    sessionId: session.id,
    inviteUrl: session.inviteUrl,
    qrPayload: session.inviteUrl,
    qrDataUrl: session.qrDataUrl,
    expiresAt: session.expiresAt,
    session: publicSessionView(session.id),
  });
});

app.post("/api/session/accept", (req, res) => {
  const { sessionId, receiverLanguageHint } = req.body ?? {};
  const session = store.getById(sessionId);
  if (!session) {
    return res.status(404).json({ error: "not_found" });
  }

  store.markParticipant(sessionId, "receiver", {
    connected: true,
    languageHint: receiverLanguageHint || session.receiverState.languageHint,
  });
  store.updateStatus(sessionId, "accepted", {
    receiverLanguageHint: receiverLanguageHint || session.receiverLanguageHint,
  });

  broadcast(sessionId, {
    type: "session.updated",
    session: publicSessionView(sessionId),
  });

  return res.json({ session: publicSessionView(sessionId) });
});

app.post("/api/session/end", (req, res) => {
  const { sessionId, reason } = req.body ?? {};
  const session = store.getById(sessionId);
  if (!session) {
    return res.status(404).json({ error: "not_found" });
  }

  destroyRelay(sessionId);

  store.updateStatus(sessionId, "ended", {
    endedAt: new Date().toISOString(),
    endReason: reason || "ended_by_user",
  });

  broadcast(sessionId, {
    type: "session.ended",
    session: publicSessionView(sessionId),
  });

  return res.json({ ok: true });
});

app.get("/api/session/:id/status", (req, res) => {
  const session = publicSessionView(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "not_found" });
  }
  return res.json({ session });
});

/**
 * Server relay bootstrap: server connects to OpenAI on behalf of the browser.
 * No ephemeral token is returned — the server holds the connection.
 */
app.post("/api/realtime/bootstrap", async (req, res) => {
  const { sessionId, role, speakerLanguageHint } = req.body ?? {};
  const session = store.getById(sessionId);

  if (!session) {
    return res.status(404).json({ error: "not_found" });
  }

  if (role !== "client" && role !== "receiver") {
    return res.status(400).json({ error: "invalid_role" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "missing_openai_key", message: "OPENAI_API_KEY is not configured." });
  }

  const speakerHint = speakerLanguageHint || (role === "client" ? session.clientLanguageHint : session.receiverLanguageHint);
  const listenerHint = role === "client" ? (session.receiverLanguageHint || session.receiverState.languageHint) : (session.clientLanguageHint || session.clientState.languageHint);
  const voice = role === "client" ? session.clientVoice : session.receiverVoice;

  try {
    // Create server-side WebSocket relay to OpenAI
    await createRelay(sessionId, role, {
      apiKey,
      model: session.model,
      speakerLanguageHint: speakerHint,
      listenerLanguageHint: listenerHint,
      voice,
    });

    // Register callback: when translated audio arrives, send to the OTHER browser
    setOnTranslatedAudio(sessionId, (targetRole, pcmBuffer) => {
      sendBinaryToRole(sessionId, targetRole, pcmBuffer);
    });

    store.markParticipant(sessionId, role, {
      realtimeConnected: true,
      relayConnected: true,
      languageHint: speakerHint,
      connected: true,
    });

    // Check if both sides have relay → transition to active
    if (hasRelay(sessionId, "client") && hasRelay(sessionId, "receiver")) {
      updateStatus(sessionId, "active", {
        startedAt: session.startedAt || new Date().toISOString(),
      });
    } else {
      updateStatus(sessionId, "connecting", {
        startedAt: session.startedAt || new Date().toISOString(),
      });
    }

    return res.json({
      ready: true,
      session: publicSessionView(sessionId),
    });
  } catch (error) {
    console.error(error);
    updateStatus(sessionId, "failed");
    return res.status(502).json({ error: "relay_failed", message: "Не удалось создать серверный relay к OpenAI Realtime." });
  }
});

/* ── Debug endpoints ── */
app.get("/api/debug/relay-log", (_req, res) => {
  res.json({ events: getRelayEventLog() });
});

app.get("/api/debug/relay-stats", (_req, res) => {
  res.json({
    relayStats: getRelayStats(),
    serverAudioStats: Object.fromEntries(serverAudioStats),
    activeSessions: activeRelaySessionIds(),
  });
});

app.get("/api/debug/session/:id", (req, res) => {
  const sessionId = req.params.id;
  const session = publicSessionView(sessionId);
  if (!session) {
    return res.status(404).json({ error: "not_found" });
  }
  const relayStats = getRelayStats();
  const sas = serverAudioStats.get(sessionId);
  const set = socketsBySession.get(sessionId);
  const sockets = set ? [...set].map((e) => ({ role: e.role, readyState: e.ws.readyState })) : [];
  return res.json({
    session,
    relayStats: relayStats[sessionId] || null,
    serverAudioStats: sas || null,
    connectedSockets: sockets,
    hasRelay: { client: hasRelay(sessionId, "client"), receiver: hasRelay(sessionId, "receiver") },
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", baseUrl);
  const sessionId = url.searchParams.get("sessionId");
  const role = url.searchParams.get("role") as SessionRole | null;

  if (!sessionId || (role !== "client" && role !== "receiver")) {
    ws.close(1008, "invalid_params");
    return;
  }

  const session = store.getById(sessionId);
  if (!session) {
    ws.close(1008, "session_not_found");
    return;
  }

  const entry = { ws: ws as unknown as WebSocket, role };
  const set = getSessionSet(sessionId);
  set.add(entry);
  store.markParticipant(sessionId, role, { wsConnected: true, connected: true });
  broadcast(sessionId, { type: "session.updated", session: publicSessionView(sessionId) });

  ws.on("message", (raw, isBinary) => {
    // Binary frame = PCM audio from browser mic → feed to relay
    if (isBinary) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      const sas = getServerAudioStats(sessionId);
      const roleStats = role === "client" ? sas.client : sas.receiver;
      roleStats.wsBinaryIn++;
      if (roleStats.wsBinaryIn % 100 === 0) {
        console.log(`ws binary IN [${sessionId}/${role}]: ${roleStats.wsBinaryIn} frames, ${buf.length} bytes last`);
      }
      feedAudio(sessionId, role, buf);
      return;
    }

    // Text frame = JSON control message
    try {
      const message = JSON.parse(String(raw));

      if (message.type === "participant.state") {
        store.markParticipant(sessionId, role, message.patch ?? {});
        broadcast(sessionId, { type: "session.updated", session: publicSessionView(sessionId) });
        return;
      }

      if (message.type === "debug.playback") {
        logEvent(`[browser.playback] ${sessionId}/${role}: chunks=${message.chunks}, bytes=${message.bytes}, ctxState=${message.ctxState}, ctxTime=${message.ctxTime}, sampleRate=${message.sampleRate}`);
        return;
      }
    } catch (error) {
      console.error("ws_message_error", error);
    }
  });

  ws.on("close", () => {
    set.delete(entry);
    store.markParticipant(sessionId, role, { wsConnected: false, connected: false, relayConnected: false });
    broadcast(sessionId, { type: "session.updated", session: publicSessionView(sessionId) });

    // If both participants disconnected, destroy relay
    const remaining = [...set].filter((e) => e.ws.readyState === e.ws.OPEN);
    if (remaining.length === 0) {
      destroyRelay(sessionId);
    }
  });
});

setInterval(() => {
  store.cleanupExpired();
  // Also cleanup relays for expired sessions
  for (const sid of activeRelaySessionIds()) {
    const session = store.getById(sid);
    if (!session || session.status === "expired" || session.status === "ended" || session.status === "failed") {
      destroyRelay(sid);
    }
  }
}, 30_000).unref();

server.listen(port, () => {
  console.log(`Talk Bridge MVP (server relay) listening on ${baseUrl}`);
});
