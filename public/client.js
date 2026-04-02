import {
  MODEL_LABELS,
  attachRemoteAudio,
  bootstrapRealtime,
  connectOpenAiRealtime,
  connectSignalSocket,
  fetchJson,
  formatDuration,
  languageHint,
} from "/shared.js";

const swipeTrack = document.getElementById("clientSwipeTrack");
const screenDots = [...document.querySelectorAll(".screen-dot")];
const backendStatus = document.getElementById("backendStatus");
const modelMeta = document.getElementById("modelMeta");
const statusGrid = document.getElementById("statusGrid");
const qrPlaceholder = document.getElementById("qrPlaceholder");
const qrImage = document.getElementById("qrImage");
const qrOverlay = document.getElementById("qrOverlay");
const contactHint = document.getElementById("contactHint");
const inviteUrlInput = document.getElementById("inviteUrl");
const copyInviteBtn = document.getElementById("copyInviteBtn");
const regenQrBtn = document.getElementById("regenQrBtn");
const regenQrSettingsBtn = document.getElementById("regenQrSettingsBtn");
const callStatus = document.getElementById("callStatus");
const callSubstatus = document.getElementById("callSubstatus");
const callTimer = document.getElementById("callTimer");
const clientEndSwipe = document.getElementById("clientEndSwipe");

let selectedModel = "mini";
let currentSession = null;
let ws = null;
let peerPc = null;
let openAiPc = null;
let micStream = null;
let timerId = null;
let remoteAudio = null;
let makingOffer = false;
let activeScreen = 0;
let touchStartX = 0;
let touchDeltaX = 0;
let autoStartedSessionId = null;

init();

async function init() {
  await checkBackend();
  renderModel();
  bindEvents();
  await createSession();
}

async function checkBackend() {
  try {
    await fetchJson("/health");
    backendStatus.textContent = "Backend ready";
  } catch {
    backendStatus.textContent = "Backend недоступен";
  }
}

function bindEvents() {
  document.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (selectedModel === button.dataset.model) return;
      selectedModel = button.dataset.model;
      renderModel();
      await createSession();
      setScreen(2);
    });
  });

  screenDots.forEach((dot) => {
    dot.addEventListener("click", () => setScreen(Number(dot.dataset.screenJump)));
  });

  swipeTrack.addEventListener("touchstart", (event) => {
    touchStartX = event.touches[0].clientX;
    touchDeltaX = 0;
  }, { passive: true });

  swipeTrack.addEventListener("touchmove", (event) => {
    touchDeltaX = event.touches[0].clientX - touchStartX;
  }, { passive: true });

  swipeTrack.addEventListener("touchend", () => {
    if (Math.abs(touchDeltaX) < 48) return;
    if (touchDeltaX < 0 && activeScreen < 2) setScreen(activeScreen + 1);
    if (touchDeltaX > 0 && activeScreen > 0) setScreen(activeScreen - 1);
  });

  copyInviteBtn.addEventListener("click", async () => {
    if (!inviteUrlInput.value) return;
    await navigator.clipboard.writeText(inviteUrlInput.value);
    contactHint.textContent = "Ссылка скопирована";
  });

  regenQrBtn.addEventListener("click", createSession);
  regenQrSettingsBtn.addEventListener("click", createSession);

  // Swipe to end call (client side)
  setupSwipeControl(clientEndSwipe, () => endConversation("ended_by_client"));
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

function setScreen(index) {
  activeScreen = Math.max(0, Math.min(2, index));
  swipeTrack.style.transform = `translateX(-${activeScreen * 100}%)`;
  screenDots.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === activeScreen));
}

function renderModel() {
  document.querySelectorAll("[data-model]").forEach((button) => {
    button.classList.toggle("active", button.dataset.model === selectedModel);
  });
  modelMeta.textContent = `${selectedModel === "mini" ? "Mini" : "Full"} · ${MODEL_LABELS[selectedModel]}`;
}

async function createSession() {
  qrOverlay.classList.add("hidden");
  qrPlaceholder.textContent = "Генерируем QR-код...";
  qrPlaceholder.classList.remove("hidden");
  qrImage.classList.add("hidden");

  try {
    if (currentSession) {
      await endConversation("regenerated_by_client", { silent: true });
    }

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
    autoStartedSessionId = null;
    qrImage.src = payload.qrDataUrl;
    qrImage.classList.remove("hidden");
    qrPlaceholder.classList.add("hidden");
    inviteUrlInput.value = payload.inviteUrl;
    contactHint.textContent = "Отсканируйте QR-код для разговора";

    // Reset call screen to idle state
    callStatus.textContent = "У вас пока нет текущей сессии";
    callTimer.classList.add("hidden");
    callSubstatus.textContent = "Создайте QR-код и дождитесь ответа собеседника.";
    clientEndSwipe.classList.add("hidden");

    connectSocket();
    renderSessionState();
    setScreen(0);
  } catch (error) {
    qrPlaceholder.textContent = error.message || "Не удалось создать QR";
    contactHint.textContent = "Попробуйте снова";
  }
}

function connectSocket() {
  if (!currentSession) return;
  if (ws) {
    ws.close();
    ws = null;
  }

  ws = connectSignalSocket({
    sessionId: currentSession.id,
    role: "client",
    onMessage: async (message) => {
      if (message.type === "session.updated") {
        currentSession = message.session;
        renderSessionState();
        if (["accepted", "connecting", "active"].includes(currentSession.status)) {
          setScreen(1);
          if (autoStartedSessionId !== currentSession.id) {
            autoStartedSessionId = currentSession.id;
            await startConversation();
          }
        }
        if (["expired", "failed", "cancelled"].includes(currentSession.status)) {
          markQrExpired();
        }
      }

      if (message.type === "session.ended") {
        currentSession = message.session;
        await teardownMedia();
        callStatus.textContent = "Разговор завершён";
        callSubstatus.textContent = "Сгенерируйте новый QR-код для следующего разговора.";
        callTimer.classList.add("hidden");
        clientEndSwipe.classList.add("hidden");
        markQrExpired();
      }

      if (message.type === "peer.signal") {
        await handlePeerSignal(message.payload);
      }
    },
  });
}

function renderSessionState() {
  if (!currentSession) return;

  const mapping = {
    created: "Готово",
    qr_displayed: "QR показан",
    opened: "Собеседник открыл ссылку",
    ringing: "Идёт вызов",
    accepted: "Собеседник ответил",
    connecting: "Соединяем перевод",
    active: "Разговор активен",
    ended: "Разговор завершён",
    expired: "QR истёк",
    failed: "Ошибка",
  };

  const items = [
    ["Сессия", mapping[currentSession.status] || currentSession.status],
    ["Модель", MODEL_LABELS[currentSession.model]],
    ["Backend", backendStatus.textContent],
    ["Собеседник", currentSession.receiverState.wsConnected ? "На линии" : "Ещё не подключён"],
    ["Язык", currentSession.receiverLanguageHint || currentSession.receiverState.languageHint || "Авто"],
  ];

  statusGrid.innerHTML = items
    .map(([label, value]) => `<div class="status-row-card"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");

  const expiresAt = new Date(currentSession.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  contactHint.textContent = currentSession.status === "active"
    ? "Разговор идёт"
    : `Отсканируйте QR-код для разговора · до ${expiresAt}`;

  if (currentSession.status === "ringing") {
    callStatus.textContent = "Идёт вызов";
    callSubstatus.textContent = "Ждём свайп-ответ от собеседника.";
    callTimer.classList.add("hidden");
    clientEndSwipe.classList.add("hidden");
  }
  if (currentSession.status === "accepted") {
    callStatus.textContent = "Ответ получен";
    callSubstatus.textContent = "Подключаем перевод автоматически.";
  }
  if (currentSession.status === "connecting") {
    callStatus.textContent = "Подключение";
    callSubstatus.textContent = "Настраиваем аудио и перевод.";
  }
  if (currentSession.status === "active") {
    callStatus.textContent = "Разговор";
    callSubstatus.textContent = "Перевод идёт автоматически.";
    callTimer.classList.remove("hidden");
    clientEndSwipe.classList.remove("hidden");
  }
}

function markQrExpired() {
  qrOverlay.classList.remove("hidden");
}

async function startConversation() {
  if (!currentSession || openAiPc) return;

  callStatus.textContent = "Подключение";
  callSubstatus.textContent = "Запрашиваем микрофон и запускаем перевод.";

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
        await attachTranslatedTrack(stream, track);
      },
      onState: (state) => {
        if (state === "connected") {
          callStatus.textContent = "Разговор";
          callSubstatus.textContent = "Перевод идёт автоматически.";
        } else {
          callSubstatus.textContent = `OpenAI: ${state}`;
        }
      },
    });

    openAiPc = realtime.pc;
    ws?.send(JSON.stringify({
      type: "participant.state",
      patch: { micGranted: true, realtimeConnected: true },
    }));
    startTimer();
  } catch (error) {
    callStatus.textContent = "Ошибка";
    callSubstatus.textContent = error.message || "Не удалось подключиться.";
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
    callStatus.textContent = "Разговор";
    callSubstatus.textContent = "Собеседник подключён.";
    ws?.send(JSON.stringify({ type: "participant.state", patch: { peerConnected: true } }));
  });

  peerPc.addEventListener("connectionstatechange", () => {
    if (peerPc.connectionState === "connected") {
      callStatus.textContent = "Разговор";
      callSubstatus.textContent = "Канал связи стабилен.";
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
  if (!peerPc) await ensurePeerConnection(true);
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
  callTimer.classList.remove("hidden");
  clientEndSwipe.classList.remove("hidden");
  timerId = setInterval(() => {
    callTimer.textContent = formatDuration(currentSession?.startedAt || new Date().toISOString());
  }, 250);
}

function stopTimer() {
  if (!timerId) return;
  clearInterval(timerId);
  timerId = null;
}

async function endConversation(reason, options = {}) {
  if (currentSession) {
    await fetchJson("/api/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId: currentSession.id, reason }),
    }).catch(() => {});
  }
  await teardownMedia();
  if (!options.silent) {
    callStatus.textContent = "Разговор завершён";
    callSubstatus.textContent = "Для нового разговора обновите QR-код.";
    callTimer.classList.add("hidden");
    clientEndSwipe.classList.add("hidden");
    markQrExpired();
  }
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
