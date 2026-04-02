import {
  MODEL_LABELS,
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

const backendStatus = document.getElementById("backendStatus");
const modelMeta = document.getElementById("modelMeta");
const showQrBtn = document.getElementById("showQrBtn");
const startCallBtn = document.getElementById("startCallBtn");
const statusGrid = document.getElementById("statusGrid");
const emptyQrState = document.getElementById("emptyQrState");
const qrState = document.getElementById("qrState");
const qrImage = document.getElementById("qrImage");
const inviteUrlInput = document.getElementById("inviteUrl");
const copyInviteBtn = document.getElementById("copyInviteBtn");
const sessionMeta = document.getElementById("sessionMeta");
const homeView = document.getElementById("homeView");
const callView = document.getElementById("callView");
const callStatus = document.getElementById("callStatus");
const callTimer = document.getElementById("callTimer");
const endCallBtn = document.getElementById("endCallBtn");
const callBanner = document.getElementById("callBanner");

let selectedModel = "mini";
let currentSession = null;
let ws = null;
let peerPc = null;
let openAiPc = null;
let micStream = null;
let timerId = null;
let remoteAudio = null;
let translatedTrack = null;
let makingOffer = false;

async function init() {
  try {
    await fetchJson("/health");
    backendStatus.textContent = "Backend ready";
  } catch {
    backendStatus.textContent = "Backend недоступен";
  }

  renderModel();
  bindEvents();
}

function bindEvents() {
  document.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedModel = button.dataset.model;
      renderModel();
    });
  });

  showQrBtn.addEventListener("click", createSession);
  startCallBtn.addEventListener("click", startConversation);
  copyInviteBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(inviteUrlInput.value);
    sessionMeta.textContent = "Ссылка скопирована";
  });
  endCallBtn.addEventListener("click", () => endConversation("ended_by_client"));
}

function renderModel() {
  document.querySelectorAll("[data-model]").forEach((button) => {
    button.classList.toggle("active", button.dataset.model === selectedModel);
  });
  modelMeta.textContent = `${selectedModel === "mini" ? "Mini" : "Full"} · ${MODEL_LABELS[selectedModel]}`;
}

async function createSession() {
  showQrBtn.disabled = true;
  clearErrorBanner(sessionMeta, "Создание invite...");

  try {
    const payload = await fetchJson("/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        model: selectedModel,
        clientName: "Anton",
        clientPhotoUrl: "/assets/client-photo.jpg",
        clientLanguageHint: languageHint(),
      }),
    });

    currentSession = payload.session;
    qrImage.src = payload.qrDataUrl;
    inviteUrlInput.value = payload.inviteUrl;
    emptyQrState.classList.add("hidden");
    qrState.classList.remove("hidden");
    sessionMeta.textContent = `Сессия активна до ${new Date(payload.expiresAt).toLocaleTimeString()}`;
    startCallBtn.classList.remove("hidden");
    connectSocket();
    renderSessionState();
  } catch (error) {
    setErrorBanner(sessionMeta, error.message);
  } finally {
    showQrBtn.disabled = false;
  }
}

function connectSocket() {
  if (!currentSession || ws) return;
  ws = connectSignalSocket({
    sessionId: currentSession.id,
    role: "client",
    onMessage: async (message) => {
      if (message.type === "session.updated") {
        currentSession = message.session;
        renderSessionState();
      }
      if (message.type === "session.ended") {
        currentSession = message.session;
        await teardownMedia();
        showEndedState(currentSession.endReason || "Разговор завершён");
      }
      if (message.type === "peer.signal") {
        await handlePeerSignal(message.payload);
      }
    },
  });

  ws.addEventListener("open", () => renderSessionState());
}

function renderSessionState() {
  if (!currentSession) return;

  const items = [
    ["Статус", currentSession.status],
    ["Собеседник", currentSession.receiverState.wsConnected ? "На линии" : "Не подключён"],
    ["Модель", MODEL_LABELS[currentSession.model]],
    ["Язык клиента", currentSession.clientLanguageHint || "auto"],
    ["Язык собеседника", currentSession.receiverLanguageHint || currentSession.receiverState.languageHint || "auto"],
  ];

  statusGrid.innerHTML = items
    .map(([label, value]) => `<div class="status-item"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");

  if (currentSession.status === "accepted") {
    startCallBtn.textContent = "Начать перевод";
    startCallBtn.disabled = false;
  }
}

async function startConversation() {
  if (!currentSession) return;

  startCallBtn.disabled = true;
  homeView.classList.add("hidden");
  callView.classList.remove("hidden");
  clearErrorBanner(callBanner, "Запрашиваем микрофон, OpenAI Realtime и peer audio...");

  try {
    await ensureMic();
    await ensurePeerConnection(true);
    const token = await bootstrapRealtime({
      sessionId: currentSession.id,
      role: "client",
      speakerLanguageHint: languageHint(),
    });

    const realtime = await connectOpenAiRealtime({
      token,
      micStream,
      onTrack: async (track, stream) => {
        translatedTrack = track;
        await attachTranslatedTrack(stream, track);
      },
      onState: (state) => {
        callStatus.textContent = state === "connected" ? "Active" : `OpenAI: ${state}`;
      },
    });

    openAiPc = realtime.pc;
    ws?.send(JSON.stringify({
      type: "participant.state",
      patch: { micGranted: true, realtimeConnected: true },
    }));
    startTimer();
  } catch (error) {
    setErrorBanner(callBanner, error.message || "Не удалось подключиться.");
    startCallBtn.disabled = false;
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
    callStatus.textContent = "Active";
    ws?.send(JSON.stringify({
      type: "participant.state",
      patch: { peerConnected: true },
    }));
  });

  peerPc.addEventListener("connectionstatechange", () => {
    if (peerPc.connectionState === "connected") {
      callStatus.textContent = "Active";
    }
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
    await ensurePeerConnection(true);
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
  if (!currentSession) return;
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
    callTimer.textContent = formatDuration(currentSession?.startedAt || new Date().toISOString());
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
  showEndedState("Разговор завершён");
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

function showEndedState(message) {
  callStatus.textContent = "Ended";
  setErrorBanner(callBanner, message);
}

init();
