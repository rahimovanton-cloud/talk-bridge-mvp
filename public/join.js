import {
  bootstrapRealtime,
  connectMediaStream,
  connectSignalSocket,
  createAudioContextNow,
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
let micStream = null;
let mediaHandle = null;
let timerId = null;
let ringerCtx = null;
let ringerTimer = null;
let answered = false;

/* ── Audio context — create eagerly, resume on gesture ── */
try {
  ringerCtx = new (window.AudioContext || window.webkitAudioContext)();
} catch { /* no audio support */ }

function unlockAudio() {
  if (ringerCtx && ringerCtx.state === "suspended") {
    ringerCtx.resume().catch(() => {});
  }
}
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

  // Try to vibrate as fallback for no-audio scenarios
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  function burst() {
    if (answered || !ringerCtx || ringerCtx.state === "closed") return;
    if (ringerCtx.state === "suspended") ringerCtx.resume().catch(() => {});
    if (ringerCtx.state !== "running") return; // skip sound if still suspended
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
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
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

  // Create AudioContext NOW, synchronously during user gesture (before any await)
  const callAudioCtx = createAudioContextNow();
  console.log("[receiver] AudioContext created during swipe gesture");

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

    const bootstrap = await bootstrapRealtime({
      sessionId: currentSession.id,
      role: "receiver",
      speakerLanguageHint: languageHint(),
    });

    if (!bootstrap.ready) {
      throw new Error("Сервер не смог создать relay.");
    }

    mediaHandle = await connectMediaStream(ws, micStream, callAudioCtx);
    console.log("[receiver] mediaHandle created, playback wired directly to WS");
    ws?.send(JSON.stringify({ type: "participant.state", patch: { micGranted: true, realtimeConnected: true } }));
    startTimer();
    receiverCallStatus.textContent = "Разговор";
    receiverBanner.textContent = "Перевод активен.";
  } catch (error) {
    console.error("acceptCall error:", error);
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
  mediaHandle?.teardown();
  mediaHandle = null;
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}
