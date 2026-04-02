import {
  PEER_ICE_CONFIG,
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
const receiverCallTimer = document.getElementById("receiverCallTimer");
const receiverCallStatus = document.getElementById("receiverCallStatus");
const receiverBanner = document.getElementById("receiverBanner");
const receiverEndView = document.getElementById("receiverEndView");

const inviteToken = location.pathname.split("/").pop();
let currentSession = null;
let ws = null;
let peerPc = null;
let openAiPc = null;
let micStream = null;
let remoteAudio = null;
let timerId = null;
let makingOffer = false;
let ringerCtx = null;
let ringerTimer = null;
let answered = false;

/* ── Audio context needs user gesture on iOS ── */
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    ringerCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (ringerCtx.state === "suspended") ringerCtx.resume();
  } catch { /* no audio support */ }
}

// Unlock on any first touch/click
document.addEventListener("touchstart", unlockAudio, { once: true });
document.addEventListener("click", unlockAudio, { once: true });

init();

async function init() {
  try {
    const payload = await fetchJson(`/api/invite/${inviteToken}`);
    currentSession = payload.session;
    renderInvite();
    connectSocket();
    initSwipe("acceptSwipe", "acceptThumb", acceptCall);
    initSwipe("endSwipe", "endThumb", () => endConversation("ended_by_receiver"));
    startRinging();
  } catch (error) {
    clientName.textContent = "Ошибка";
    document.querySelector(".incoming-copy").textContent = error.message || "Ссылка недоступна";
  }
}

function renderInvite() {
  clientName.textContent = currentSession.clientName;
  if (currentSession.clientPhotoUrl) {
    clientPhotoBg.src = currentSession.clientPhotoUrl;
  }
}

/* ── swipe (touch + mouse) ── */
function initSwipe(railId, thumbId, onComplete) {
  const rail = document.getElementById(railId);
  const thumb = document.getElementById(thumbId);
  const fill = rail.querySelector(".swipe-rail-fill");
  let active = false;
  let startX = 0;
  let pos = 0;

  function maxX() { return rail.clientWidth - thumb.clientWidth - 12; }
  function paint(x) {
    pos = Math.max(0, Math.min(maxX(), x));
    thumb.style.transform = `translateX(${pos}px)`;
    fill.style.width = `${pos + thumb.clientWidth}px`;
  }

  thumb.addEventListener("touchstart", (e) => {
    e.preventDefault();
    active = true;
    startX = e.touches[0].clientX - pos;
  }, { passive: false });
  document.addEventListener("touchmove", (e) => { if (active) paint(e.touches[0].clientX - startX); }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (!active) return;
    active = false;
    if (pos >= maxX() * 0.75) { paint(maxX()); await onComplete(); } else { paint(0); }
  });

  thumb.addEventListener("mousedown", (e) => { e.preventDefault(); active = true; startX = e.clientX - pos; });
  document.addEventListener("mousemove", (e) => { if (active) paint(e.clientX - startX); });
  document.addEventListener("mouseup", async () => {
    if (!active) return;
    active = false;
    if (pos >= maxX() * 0.75) { paint(maxX()); await onComplete(); } else { paint(0); }
  });

  paint(0);
}

/* ── ringing ── */
function startRinging() {
  incomingInfo.classList.add("shaking");

  function burst() {
    if (answered || !ringerCtx || ringerCtx.state === "closed") return;
    if (ringerCtx.state === "suspended") ringerCtx.resume();
    const t = ringerCtx.currentTime;
    [0, 0.15].forEach((off) => {
      const o = ringerCtx.createOscillator();
      const g = ringerCtx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.08, t + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.12);
      o.connect(g).connect(ringerCtx.destination);
      o.start(t + off);
      o.stop(t + off + 0.13);
    });
  }

  burst();
  ringerTimer = setInterval(() => {
    if (answered) { clearInterval(ringerTimer); return; }
    burst();
    incomingInfo.classList.remove("shaking");
    void incomingInfo.offsetWidth;
    incomingInfo.classList.add("shaking");
  }, 1800);
}

function stopRinging() {
  answered = true;
  incomingInfo.classList.remove("shaking");
  clearInterval(ringerTimer);
  ringerCtx?.close?.().catch(() => {});
  ringerCtx = null;
}

/* ── socket ── */
function connectSocket() {
  ws = connectSignalSocket({
    sessionId: currentSession.id,
    role: "receiver",
    onMessage: async (msg) => {
      if (msg.type === "session.updated") {
        currentSession = msg.session;
        if (["ended", "expired", "failed", "cancelled"].includes(currentSession.status)) {
          await teardownMedia();
          showEndView();
        }
      }
      if (msg.type === "session.ended") {
        currentSession = msg.session;
        await teardownMedia();
        showEndView();
      }
      if (msg.type === "peer.signal") {
        await handlePeerSignal(msg.payload);
      }
    },
  });
}

/* ── view switching ── */
function showIncoming() {
  incomingView.style.display = "flex";
  receiverCallView.style.display = "none";
  receiverEndView.style.display = "none";
}

function showCallView() {
  incomingView.style.display = "none";
  receiverCallView.style.display = "flex";
  receiverEndView.style.display = "none";
}

function showEndView() {
  incomingView.style.display = "none";
  receiverCallView.style.display = "none";
  receiverEndView.style.display = "flex";
}

/* ── accept call ── */
async function acceptCall() {
  if (answered) return;
  stopRinging();

  try {
    await ensureMic();
    await fetchJson("/api/session/accept", {
      method: "POST",
      body: JSON.stringify({
        sessionId: currentSession.id,
        receiverLanguageHint: languageHint(),
      }),
    });

    showCallView();
    receiverCallStatus.textContent = "Подключение";
    receiverBanner.textContent = "Запускаем перевод.";

    await ensurePeerConnection(false);
    const bootstrap = await bootstrapRealtime({
      sessionId: currentSession.id,
      role: "receiver",
      speakerLanguageHint: languageHint(),
    });

    const realtime = await connectOpenAiRealtime({
      token: bootstrap.token,
      model: bootstrap.model,
      micStream,
      onTrack: async (track, stream) => {
        await attachTranslatedTrack(stream, track);
      },
      onState: (state) => {
        receiverBanner.textContent = state === "connected" ? "Перевод идёт автоматически." : `OpenAI: ${state}`;
      },
    });

    openAiPc = realtime.pc;
    ws?.send(JSON.stringify({ type: "participant.state", patch: { micGranted: true, realtimeConnected: true } }));
    startTimer();
    receiverCallStatus.textContent = "Разговор";
    receiverBanner.textContent = "Перевод активен.";
  } catch (error) {
    console.error("acceptCall error:", error);
    // If we already showed the call view, stay on it and show error there
    if (receiverCallView.style.display !== "none") {
      receiverCallStatus.textContent = "Ошибка";
      receiverBanner.textContent = error.message || "Не удалось подключиться.";
    } else {
      answered = false;
      showIncoming();
      document.querySelector(".incoming-copy").textContent = error.message || "Не удалось подключиться.";
    }
  }
}

async function ensureMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
}

async function ensurePeerConnection(isInitiator) {
  if (peerPc) return;
  peerPc = new RTCPeerConnection(PEER_ICE_CONFIG);
  peerPc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) sendPeerSignal({ type: "ice", candidate });
  });
  peerPc.addEventListener("track", (event) => {
    console.log("RECEIVER: got peer track", event.track.kind, event.track.id);
    remoteAudio = attachRemoteAudio(event.streams[0] || event.track);
    receiverCallStatus.textContent = "Разговор";
    receiverBanner.textContent = "Собеседник на линии.";
    ws?.send(JSON.stringify({ type: "participant.state", patch: { peerConnected: true } }));
  });
  peerPc.addEventListener("connectionstatechange", () => {
    console.log("RECEIVER peer connection:", peerPc.connectionState);
  });
  peerPc.addEventListener("iceconnectionstatechange", () => {
    console.log("RECEIVER ICE connection:", peerPc.iceConnectionState);
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
  try {
    if (!peerPc) await ensurePeerConnection(false);
    const existing = peerPc.getSenders().find((s) => s.track?.id === track.id);
    if (existing) return;
    console.log("RECEIVER: adding translated track to peer connection", track.kind, track.id);
    peerPc.addTrack(track, stream);
    if (!makingOffer) {
      makingOffer = true;
      const offer = await peerPc.createOffer();
      await peerPc.setLocalDescription(offer);
      sendPeerSignal({ type: "offer", sdp: offer.sdp });
      console.log("RECEIVER: sent offer with translated track");
      makingOffer = false;
    }
  } catch (e) {
    console.error("RECEIVER: attachTranslatedTrack error:", e);
    makingOffer = false;
  }
}

async function handlePeerSignal(p) {
  await ensurePeerConnection(false);
  if (p.type === "offer") {
    await peerPc.setRemoteDescription({ type: "offer", sdp: p.sdp });
    const answer = await peerPc.createAnswer();
    await peerPc.setLocalDescription(answer);
    sendPeerSignal({ type: "answer", sdp: answer.sdp });
    return;
  }
  if (p.type === "answer") { await peerPc.setRemoteDescription({ type: "answer", sdp: p.sdp }); return; }
  if (p.type === "ice" && p.candidate) { await peerPc.addIceCandidate(p.candidate); }
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
  showEndView();
}

async function teardownMedia() {
  stopTimer();
  [peerPc, openAiPc].forEach((pc) => pc?.close());
  peerPc = null;
  openAiPc = null;
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  remoteAudio?.remove();
  remoteAudio = null;
}
