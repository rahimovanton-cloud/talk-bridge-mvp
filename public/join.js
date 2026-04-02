import {
  attachRemoteAudio,
  bootstrapRealtime,
  connectOpenAiRealtime,
  connectSignalSocket,
  fetchJson,
  formatDuration,
  languageHint,
} from "/shared.js";

const incomingView = document.getElementById("incomingView");
const receiverCallView = document.getElementById("receiverCallView");
const clientPhotoBg = document.getElementById("clientPhotoBg");
const clientName = document.getElementById("clientName");
const incomingInfo = document.getElementById("incomingInfo");
const incomingBanner = document.getElementById("incomingBanner");
const receiverCallTimer = document.getElementById("receiverCallTimer");
const receiverCallStatus = document.getElementById("receiverCallStatus");
const receiverBanner2 = document.getElementById("receiverBanner2");

const inviteToken = location.pathname.split("/").pop();
let currentSession = null;
let ws = null;
let peerPc = null;
let openAiPc = null;
let micStream = null;
let remoteAudio = null;
let timerId = null;
let makingOffer = false;
let ringerAudioContext = null;
let ringerInterval = null;
let answered = false;
let shakeInterval = null;

init();

async function init() {
  try {
    const payload = await fetchJson(`/api/invite/${inviteToken}`);
    currentSession = payload.session;
    renderInvite();
    connectSocket();
    setupSwipeControl(document.getElementById("acceptSwipe"), acceptCall);
    setupSwipeControl(document.getElementById("endSwipe"), () => endConversation("ended_by_receiver"));
    startRinging();
  } catch (error) {
    incomingBanner.textContent = error.message || "Ссылка недоступна";
  }
}

function renderInvite() {
  clientName.textContent = currentSession.clientName;
  if (currentSession.clientPhotoUrl) {
    clientPhotoBg.src = currentSession.clientPhotoUrl;
  }
}

function startRinging() {
  // Start shake animation on the info block
  incomingInfo.classList.add("shaking");

  // Start ringtone sound synced with shake pulses
  try {
    ringerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    // Audio not available
  }

  const ringBurst = () => {
    if (answered || !ringerAudioContext) return;
    const now = ringerAudioContext.currentTime;
    // Two short beeps per burst
    [0, 0.15].forEach((offset) => {
      const osc = ringerAudioContext.createOscillator();
      const gain = ringerAudioContext.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.06, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.12);
      osc.connect(gain).connect(ringerAudioContext.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.13);
    });
  };

  // Shake: 600ms shake, 1200ms pause = 1800ms cycle
  // Sync sound with shake start
  ringBurst();
  ringerInterval = setInterval(() => {
    if (answered) {
      clearInterval(ringerInterval);
      return;
    }
    ringBurst();
    // Re-trigger shake animation
    incomingInfo.classList.remove("shaking");
    void incomingInfo.offsetWidth; // force reflow
    incomingInfo.classList.add("shaking");
  }, 1800);
}

function stopRinging() {
  answered = true;
  incomingInfo.classList.remove("shaking");
  if (ringerInterval) {
    clearInterval(ringerInterval);
    ringerInterval = null;
  }
  ringerAudioContext?.close?.().catch(() => {});
  ringerAudioContext = null;
}

function connectSocket() {
  ws = connectSignalSocket({
    sessionId: currentSession.id,
    role: "receiver",
    onMessage: async (message) => {
      if (message.type === "session.updated") {
        currentSession = message.session;
        if (["ended", "expired", "failed", "cancelled"].includes(currentSession.status)) {
          await teardownMedia();
          receiverBanner2.textContent = "Собеседник завершил разговор.";
        }
      }
      if (message.type === "session.ended") {
        currentSession = message.session;
        await teardownMedia();
        receiverBanner2.textContent = "Собеседник завершил разговор.";
      }
      if (message.type === "peer.signal") {
        await handlePeerSignal(message.payload);
      }
    },
  });
}

function setupSwipeControl(root, onComplete) {
  const thumb = root.querySelector(".swipe-thumb");
  const fill = root.querySelector(".swipe-track-fill");
  let dragging = false;
  let startX = 0;
  let current = 0;

  const maxShift = () => root.clientWidth - thumb.clientWidth - 12;

  const paint = (value) => {
    current = Math.max(0, Math.min(maxShift(), value));
    thumb.style.transform = `translateX(${current}px)`;
    fill.style.width = `${current + thumb.clientWidth}px`;
  };

  const finish = async () => {
    if (current >= maxShift() * 0.82) {
      paint(maxShift());
      root.classList.add("completed");
      await onComplete();
      return;
    }
    root.classList.remove("completed");
    paint(0);
  };

  const start = (clientX) => {
    dragging = true;
    startX = clientX - current;
  };

  const move = (clientX) => {
    if (!dragging) return;
    paint(clientX - startX);
  };

  const end = async () => {
    if (!dragging) return;
    dragging = false;
    await finish();
  };

  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    start(event.clientX);
    thumb.setPointerCapture(event.pointerId);
  });
  thumb.addEventListener("pointermove", (event) => move(event.clientX));
  thumb.addEventListener("pointerup", end);
  thumb.addEventListener("pointercancel", end);

  paint(0);
}

async function acceptCall() {
  if (answered) return;
  stopRinging();
  incomingBanner.textContent = "Разрешите микрофон...";

  try {
    await ensureMic();
    await fetchJson("/api/session/accept", {
      method: "POST",
      body: JSON.stringify({
        sessionId: currentSession.id,
        receiverLanguageHint: languageHint(),
      }),
    });

    incomingView.classList.add("hidden");
    receiverCallView.classList.remove("hidden");
    receiverCallStatus.textContent = "Подключение";
    receiverBanner2.textContent = "Запускаем перевод и аудиоканал.";

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
        receiverBanner2.textContent = state === "connected" ? "Перевод идёт автоматически." : `OpenAI: ${state}`;
      },
    });

    openAiPc = realtime.pc;
    ws?.send(JSON.stringify({ type: "participant.state", patch: { micGranted: true, realtimeConnected: true } }));
    startTimer();
  } catch (error) {
    answered = false;
    incomingView.classList.remove("hidden");
    receiverCallView.classList.add("hidden");
    incomingBanner.textContent = error.message || "Не удалось подключиться.";
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
    if (candidate) sendPeerSignal({ type: "ice", candidate });
  });

  peerPc.addEventListener("track", (event) => {
    remoteAudio = attachRemoteAudio(event.streams[0] || event.track);
    receiverCallStatus.textContent = "Разговор";
    receiverBanner2.textContent = "Собеседник на линии.";
    ws?.send(JSON.stringify({ type: "participant.state", patch: { peerConnected: true } }));
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
  if (!peerPc) await ensurePeerConnection(false);
  const existing = peerPc.getSenders().find((sender) => sender.track?.id === track.id);
  if (existing) return;

  peerPc.addTrack(track, stream);
  if (peerPc.signalingState === "stable" && !makingOffer) {
    makingOffer = true;
    const offer = await peerPc.createOffer();
    await peerPc.setLocalDescription(offer);
    sendPeerSignal({ type: "offer", sdp: offer.sdp });
    makingOffer = false;
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
  if (!timerId) return;
  clearInterval(timerId);
  timerId = null;
}

async function endConversation(reason) {
  stopRinging();
  if (currentSession) {
    await fetchJson("/api/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId: currentSession.id, reason }),
    }).catch(() => {});
  }
  await teardownMedia();
  receiverBanner2.textContent = reason === "declined_by_receiver" ? "Разговор отклонён." : "Разговор завершён.";
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
