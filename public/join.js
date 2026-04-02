import {
  attachRemoteAudio,
  bootstrapRealtime,
  clearErrorBanner,
  connectOpenAiRealtime,
  connectSignalSocket,
  fetchJson,
  formatDuration,
  languageHint,
  setErrorBanner,
} from "/shared.js";

const incomingView = document.getElementById("incomingView");
const receiverCallView = document.getElementById("receiverCallView");
const clientPhoto = document.getElementById("clientPhoto");
const clientInitial = document.getElementById("clientInitial");
const clientName = document.getElementById("clientName");
const incomingBanner = document.getElementById("incomingBanner");
const acceptBtn = document.getElementById("acceptBtn");
const declineBtn = document.getElementById("declineBtn");
const receiverCallTimer = document.getElementById("receiverCallTimer");
const receiverCallStatus = document.getElementById("receiverCallStatus");
const receiverBanner = document.getElementById("receiverBanner");
const receiverEndBtn = document.getElementById("receiverEndBtn");

const inviteToken = location.pathname.split("/").pop();
let currentSession = null;
let ws = null;
let peerPc = null;
let openAiPc = null;
let micStream = null;
let remoteAudio = null;
let timerId = null;
let makingOffer = false;

async function init() {
  try {
    const payload = await fetchJson(`/api/invite/${inviteToken}`);
    currentSession = payload.session;
    renderInvite();
    connectSocket();
  } catch (error) {
    setErrorBanner(incomingBanner, error.message);
    acceptBtn.disabled = true;
  }

  acceptBtn.addEventListener("click", acceptCall);
  declineBtn.addEventListener("click", () => endConversation("declined_by_receiver"));
  receiverEndBtn.addEventListener("click", () => endConversation("ended_by_receiver"));
}

function renderInvite() {
  clientName.textContent = currentSession.clientName;
  clientInitial.textContent = currentSession.clientName.slice(0, 1).toUpperCase();
  if (currentSession.clientPhotoUrl) {
    clientPhoto.src = currentSession.clientPhotoUrl;
    clientPhoto.classList.remove("hidden");
    clientInitial.classList.add("hidden");
  }
}

function connectSocket() {
  ws = connectSignalSocket({
    sessionId: currentSession.id,
    role: "receiver",
    onMessage: async (message) => {
      if (message.type === "session.updated") {
        currentSession = message.session;
      }
      if (message.type === "session.ended") {
        currentSession = message.session;
        await teardownMedia();
        setErrorBanner(receiverBanner, "Собеседник завершил разговор.");
      }
      if (message.type === "peer.signal") {
        await handlePeerSignal(message.payload);
      }
    },
  });
}

async function acceptCall() {
  acceptBtn.disabled = true;
  incomingView.classList.add("hidden");
  receiverCallView.classList.remove("hidden");
  clearErrorBanner(receiverBanner, "Разрешите микрофон для запуска разговора.");

  try {
    await ensureMic();
    await fetchJson("/api/session/accept", {
      method: "POST",
      body: JSON.stringify({
        sessionId: currentSession.id,
        receiverLanguageHint: languageHint(),
      }),
    });
    await ensurePeerConnection(false);
    const token = await bootstrapRealtime({
      sessionId: currentSession.id,
      role: "receiver",
      speakerLanguageHint: languageHint(),
    });

    const realtime = await connectOpenAiRealtime({
      token,
      micStream,
      onTrack: async (track, stream) => {
        await attachTranslatedTrack(stream, track);
      },
      onState: (state) => {
        receiverCallStatus.textContent = state === "connected" ? "Active" : `OpenAI: ${state}`;
      },
    });

    openAiPc = realtime.pc;
    ws?.send(JSON.stringify({
      type: "participant.state",
      patch: { micGranted: true, realtimeConnected: true },
    }));
    startTimer();
  } catch (error) {
    setErrorBanner(receiverBanner, error.message || "Не удалось подключиться.");
    acceptBtn.disabled = false;
  }
}

async function ensureMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
}

async function ensurePeerConnection(isInitiator) {
  if (peerPc) return;
  peerPc = new RTCPeerConnection();

  peerPc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) {
      sendPeerSignal({ type: "ice", candidate });
    }
  });

  peerPc.addEventListener("track", (event) => {
    remoteAudio = attachRemoteAudio(event.streams[0] || event.track);
    receiverCallStatus.textContent = "Active";
    ws?.send(JSON.stringify({
      type: "participant.state",
      patch: { peerConnected: true },
    }));
  });

  if (isInitiator) {
    makingOffer = true;
    const offer = await peerPc.createOffer();
    await peerPc.setLocalDescription(offer);
    sendPeerSignal({ type: "offer", sdp: offer.sdp });
    makingOffer = false;
  }
}

async function attachTranslatedTrack(stream, track) {
  if (!peerPc) {
    await ensurePeerConnection(false);
  }
  const existing = peerPc.getSenders().find((sender) => sender.track?.id === track.id);
  if (!existing) {
    peerPc.addTrack(track, stream);
    if (peerPc.signalingState === "stable" && !makingOffer) {
      makingOffer = true;
      const offer = await peerPc.createOffer();
      await peerPc.setLocalDescription(offer);
      sendPeerSignal({ type: "offer", sdp: offer.sdp });
      makingOffer = false;
    }
  }
}

async function handlePeerSignal(payload) {
  await ensurePeerConnection(false);

  if (payload.type === "offer") {
    await peerPc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await peerPc.createAnswer();
    await peerPc.setLocalDescription(answer);
    sendPeerSignal({ type: "answer", sdp: answer.sdp });
    return;
  }

  if (payload.type === "answer") {
    await peerPc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    return;
  }

  if (payload.type === "ice" && payload.candidate) {
    await peerPc.addIceCandidate(payload.candidate);
  }
}

function sendPeerSignal(payload) {
  ws?.send(JSON.stringify({ type: "peer.signal", payload }));
}

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    receiverCallTimer.textContent = formatDuration(currentSession?.startedAt || new Date().toISOString());
  }, 250);
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

async function endConversation(reason) {
  if (currentSession) {
    await fetchJson("/api/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId: currentSession.id, reason }),
    }).catch(() => {});
  }
  await teardownMedia();
  setErrorBanner(receiverBanner, reason === "declined_by_receiver" ? "Разговор отклонён." : "Разговор завершён.");
}

async function teardownMedia() {
  stopTimer();
  [peerPc, openAiPc].forEach((pc) => pc?.close());
  peerPc = null;
  openAiPc = null;
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  remoteAudio?.remove();
  remoteAudio = null;
}

init();
