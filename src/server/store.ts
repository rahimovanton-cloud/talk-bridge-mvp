import crypto from "node:crypto";
import QRCode from "qrcode";
import type {
  ConversationSession,
  ParticipantState,
  SessionRole,
  SessionStatus,
  TalkModelChoice,
} from "./types.js";

const SESSION_TTL_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function createParticipantState(role: SessionRole): ParticipantState {
  return {
    role,
    connected: false,
    wsConnected: false,
    micGranted: false,
    realtimeConnected: false,
    peerConnected: false,
  };
}

export class SessionStore {
  private readonly byId = new Map<string, ConversationSession>();
  private readonly byInvite = new Map<string, string>();

  async createSession(params: {
    baseUrl: string;
    model: TalkModelChoice;
    clientName: string;
    clientPhotoUrl?: string;
    clientLanguageHint?: string;
    clientVoice?: string;
    receiverVoice?: string;
  }) {
    const id = crypto.randomUUID();
    const inviteToken = crypto.randomBytes(18).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
    const inviteUrl = `${params.baseUrl.replace(/\/$/, "")}/join/${inviteToken}`;
    const qrDataUrl = await QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 512,
    });

    const session: ConversationSession = {
      id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "created",
      model: params.model,
      clientName: params.clientName,
      clientPhotoUrl: params.clientPhotoUrl,
      clientLanguageHint: params.clientLanguageHint,
      clientVoice: params.clientVoice || "ash",
      receiverVoice: params.receiverVoice || "shimmer",
      inviteToken,
      inviteUrl,
      qrDataUrl,
      clientState: createParticipantState("client"),
      receiverState: createParticipantState("receiver"),
    };

    this.byId.set(id, session);
    this.byInvite.set(inviteToken, id);
    return session;
  }

  getById(id: string) {
    const session = this.byId.get(id);
    if (!session) return undefined;
    return this.ensureFresh(session);
  }

  getByInviteToken(inviteToken: string) {
    const id = this.byInvite.get(inviteToken);
    if (!id) return undefined;
    return this.getById(id);
  }

  updateStatus(id: string, status: SessionStatus, patch?: Partial<ConversationSession>) {
    const session = this.getById(id);
    if (!session) return undefined;
    session.status = status;
    Object.assign(session, patch ?? {});
    return session;
  }

  markParticipant(id: string, role: SessionRole, patch: Partial<ParticipantState>) {
    const session = this.getById(id);
    if (!session) return undefined;
    const state = role === "client" ? session.clientState : session.receiverState;
    Object.assign(state, patch, { lastSeenAt: nowIso() });
    return session;
  }

  cleanupExpired() {
    for (const session of this.byId.values()) {
      this.ensureFresh(session);
    }
  }

  private ensureFresh(session: ConversationSession) {
    if (session.status === "ended" || session.status === "cancelled" || session.status === "failed") {
      return session;
    }

    if (Date.now() > new Date(session.expiresAt).getTime()) {
      session.status = "expired";
    }
    return session;
  }
}
