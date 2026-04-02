import "dotenv/config";

import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createRealtimeClientSecret, getOpenAiRealtimeModel } from "./openai.js";
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

function broadcastToOther(sessionId: string, role: SessionRole, event: unknown) {
  const set = socketsBySession.get(sessionId);
  if (!set) return;

  for (const entry of set) {
    if (entry.role !== role && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify(event));
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

  try {
    const bootstrap = await createRealtimeClientSecret({
      apiKey,
      model: session.model,
      speakerRole: role,
      speakerLanguageHint: speakerHint,
      listenerLanguageHint: listenerHint,
      clientName: session.clientName,
    });

    store.markParticipant(sessionId, role, {
      realtimeConnected: true,
      languageHint: speakerHint,
      connected: true,
    });
    updateStatus(sessionId, "connecting", {
      startedAt: session.startedAt || new Date().toISOString(),
    });

    return res.json({
      clientSecret: bootstrap.value,
      expiresAt: bootstrap.expires_at,
      session: publicSessionView(sessionId),
    });
  } catch (error) {
    console.error(error);
    updateStatus(sessionId, "failed");
    return res.status(502).json({ error: "openai_bootstrap_failed", message: "Не удалось получить временный доступ к OpenAI Realtime." });
  }
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

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));

      if (message.type === "participant.state") {
        store.markParticipant(sessionId, role, message.patch ?? {});
        if (message.patch?.peerConnected) {
          updateStatus(sessionId, "active", {
            startedAt: session.startedAt || new Date().toISOString(),
          });
        } else {
          broadcast(sessionId, { type: "session.updated", session: publicSessionView(sessionId) });
        }
        return;
      }

      if (message.type === "peer.signal") {
        broadcastToOther(sessionId, role, {
          type: "peer.signal",
          from: role,
          payload: message.payload,
        });
      }
    } catch (error) {
      console.error("ws_message_error", error);
    }
  });

  ws.on("close", () => {
    set.delete(entry);
    store.markParticipant(sessionId, role, { wsConnected: false, connected: false, peerConnected: false });
    broadcast(sessionId, { type: "session.updated", session: publicSessionView(sessionId) });
  });
});

setInterval(() => {
  store.cleanupExpired();
}, 30_000).unref();

server.listen(port, () => {
  console.log(`Talk Bridge MVP listening on ${baseUrl}`);
});
