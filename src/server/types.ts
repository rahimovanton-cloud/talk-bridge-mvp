export type TalkModelChoice = "mini" | "full";
export type SessionStatus =
  | "created"
  | "qr_displayed"
  | "opened"
  | "ringing"
  | "accepted"
  | "connecting"
  | "active"
  | "ended"
  | "cancelled"
  | "expired"
  | "failed";

export type SessionRole = "client" | "receiver";

export interface ParticipantState {
  role: SessionRole;
  connected: boolean;
  wsConnected: boolean;
  micGranted: boolean;
  realtimeConnected: boolean;
  peerConnected: boolean;
  languageHint?: string;
  lastSeenAt?: string;
}

export interface ConversationSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: SessionStatus;
  model: TalkModelChoice;
  clientName: string;
  clientPhotoUrl?: string;
  clientLanguageHint?: string;
  receiverLanguageHint?: string;
  clientVoice?: string;
  receiverVoice?: string;
  inviteToken: string;
  inviteUrl: string;
  qrDataUrl?: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
  clientState: ParticipantState;
  receiverState: ParticipantState;
}

export interface SessionCreateRequest {
  model: TalkModelChoice;
  clientName?: string;
  clientPhotoUrl?: string;
  clientLanguageHint?: string;
  clientVoice?: string;
  receiverVoice?: string;
}
