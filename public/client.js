import {
  MODEL_LABELS,
  bootstrapRealtime,
  connectMediaStream,
  connectSignalSocket,
  fetchJson,
  formatDuration,
  languageHint,
} from "/shared.js";

const tabBtns = [...document.querySelectorAll(".tab-btn")];
const tabPanels = [...document.querySelectorAll(".tab-panel")];
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
const clientVoiceList = document.getElementById("clientVoiceList");
const receiverVoiceList = document.getElementById("receiverVoiceList");

const VOICES = [
  { id: "ash", label: "Ash", tag: "male" },
  { id: "echo", label: "Echo", tag: "male" },
  { id: "ballad", label: "Ballad", tag: "male" },
  { id: "verse", label: "Verse", tag: "male" },
  { id: "shimmer", label: "Shimmer", tag: "female" },
  { id: "coral", label: "Coral", tag: "female" },
  { id: "alloy", label: "Alloy", tag: "neutral" },
  { id: "sage", label: "Sage", tag: "neutral" },
];

let selectedModel = "mini";
let selectedClientVoice = "ash";
let selectedReceiverVoice = "shimmer";
let currentSession = null;
let ws = null;
let micStream = null;
let timerId = null;
let mediaHandle = null; // { teardown, handleBinaryAudio }
let autoStartedSessionId = null;

init();

async function init() {
  await checkBackend();
  renderModel();
  renderVoices();
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

/* ── tabs ── */
function setTab(index) {
  tabBtns.forEach((b, i) => b.classList.toggle("active", i === index));
  tabPanels.forEach((p, i) => p.classList.toggle("active", i === index));
}

/* ── swipe control ── */
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

function bindEvents() {
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => setTab(Number(btn.dataset.tab)));
  });

  document.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (selectedModel === button.dataset.model) return;
      selectedModel = button.dataset.model;
      renderModel();
      await createSession();
    });
  });

  copyInviteBtn.addEventListener("click", async () => {
    if (!inviteUrlInput.value) return;
    try {
      await navigator.clipboard.writeText(inviteUrlInput.value);
      contactHint.textContent = "Ссылка скопирована ✓";
    } catch {
      inviteUrlInput.select();
      document.execCommand("copy");
      contactHint.textContent = "Ссылка скопирована ✓";
    }
  });

  regenQrBtn.addEventListener("click", createSession);
  regenQrSettingsBtn.addEventListener("click", createSession);
  initSwipe("clientEndSwipe", "clientEndThumb", () => endConversation("ended_by_client"));
}

function renderModel() {
  document.querySelectorAll("[data-model]").forEach((button) => {
    button.classList.toggle("active", button.dataset.model === selectedModel);
  });
  modelMeta.textContent = `${selectedModel === "mini" ? "Mini" : "Full"} · ${MODEL_LABELS[selectedModel]}`;
}

/* ── voice selection ── */
let previewAudio = null;

function renderVoices() {
  renderVoiceList(clientVoiceList, selectedClientVoice, (v) => { selectedClientVoice = v; renderVoices(); });
  renderVoiceList(receiverVoiceList, selectedReceiverVoice, (v) => { selectedReceiverVoice = v; renderVoices(); });
}

function renderVoiceList(container, selected, onSelect) {
  container.innerHTML = VOICES.map((v) => `
    <div class="voice-item${v.id === selected ? " active" : ""}" data-voice="${v.id}">
      <span class="voice-item-name">${v.label}</span>
      <span class="voice-item-tag">${v.tag}</span>
      <button type="button" class="voice-preview-btn" data-preview="${v.id}">&#9654;</button>
    </div>
  `).join("");

  container.querySelectorAll(".voice-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".voice-preview-btn")) return;
      onSelect(el.dataset.voice);
    });
  });

  container.querySelectorAll(".voice-preview-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      playVoicePreview(btn.dataset.preview, btn);
    });
  });
}

async function playVoicePreview(voice, btn) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  document.querySelectorAll(".voice-preview-btn.playing").forEach((b) => b.classList.remove("playing"));

  btn.classList.add("playing");
  btn.textContent = "...";
  try {
    const resp = await fetch(`/api/voice/preview?voice=${voice}`);
    if (!resp.ok) throw new Error("preview failed");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    previewAudio = new Audio(url);
    previewAudio.addEventListener("ended", () => { btn.classList.remove("playing"); btn.innerHTML = "&#9654;"; });
    await previewAudio.play();
  } catch {
    btn.classList.remove("playing");
  }
  btn.innerHTML = "&#9654;";
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
        clientVoice: selectedClientVoice,
        receiverVoice: selectedReceiverVoice,
      }),
    });

    currentSession = payload.session;
    autoStartedSessionId = null;
    qrImage.src = payload.qrDataUrl;
    qrImage.classList.remove("hidden");
    qrPlaceholder.classList.add("hidden");
    inviteUrlInput.value = payload.inviteUrl;
    contactHint.textContent = `Активно · до ${new Date(currentSession.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    callStatus.textContent = "У вас пока нет текущей сессии";
    callTimer.classList.add("hidden");
    callSubstatus.textContent = "Покажите QR-код собеседнику.";
    clientEndSwipe.classList.add("hidden");

    connectSocket();
    renderSessionState();
    setTab(0);
  } catch (error) {
    qrPlaceholder.textContent = error.message || "Не удалось создать QR";
    contactHint.textContent = "Попробуйте снова";
  }
}

function connectSocket() {
  if (!currentSession) return;
  if (ws) { ws.close(); ws = null; }

  ws = connectSignalSocket({
    sessionId: currentSession.id,
    role: "client",
    onBinary: (arrayBuffer) => {
      // Translated audio from server → playback
      mediaHandle?.handleBinaryAudio(arrayBuffer);
    },
    onMessage: async (msg) => {
      console.log("ws msg:", msg.type, msg);
      if (msg.type === "session.updated") {
        currentSession = msg.session;
        renderSessionState();
        if (["accepted", "connecting", "active"].includes(currentSession.status)) {
          setTab(1);
          if (autoStartedSessionId !== currentSession.id) {
            autoStartedSessionId = currentSession.id;
            await startConversation();
          }
        }
        if (["expired", "failed", "cancelled"].includes(currentSession.status)) {
          markQrExpired();
        }
      }

      if (msg.type === "session.ended") {
        const finalDuration = callTimer.textContent || "00:00";
        currentSession = msg.session;
        await teardownMedia();
        callStatus.textContent = "Разговор завершён";
        callTimer.textContent = finalDuration;
        callTimer.classList.remove("hidden");
        callSubstatus.textContent = "";
        clientEndSwipe.classList.add("hidden");
        markQrExpired();
        setTab(1);
      }
    },
  });
}

function renderSessionState() {
  if (!currentSession) return;

  const mapping = {
    created: "Готово",
    qr_displayed: "QR показан",
    opened: "Ссылка открыта",
    ringing: "Идёт вызов",
    accepted: "Ответ получен",
    connecting: "Соединение",
    active: "Разговор активен",
    ended: "Завершён",
    expired: "QR истёк",
    failed: "Ошибка",
  };

  const items = [
    ["Сессия", mapping[currentSession.status] || currentSession.status],
    ["Модель", MODEL_LABELS[currentSession.model]],
    ["Backend", backendStatus.textContent],
    ["Собеседник", currentSession.receiverState.wsConnected ? "На линии" : "Ожидание"],
    ["Язык", currentSession.receiverLanguageHint || currentSession.receiverState.languageHint || "Авто"],
  ];

  statusGrid.innerHTML = items
    .map(([l, v]) => `<div class="tech-row"><span>${l}</span><strong>${v}</strong></div>`)
    .join("");

  if (currentSession.status === "ringing") {
    callStatus.textContent = "Идёт вызов";
    callSubstatus.textContent = "Ждём ответ собеседника.";
    callTimer.classList.add("hidden");
    clientEndSwipe.classList.add("hidden");
  }
  if (currentSession.status === "accepted") {
    callStatus.textContent = "Ответ получен";
    callSubstatus.textContent = "Подключаем перевод.";
  }
  if (currentSession.status === "connecting") {
    callStatus.textContent = "Подключение";
    callSubstatus.textContent = "Настраиваем аудио.";
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
  if (!currentSession || mediaHandle) return;
  callStatus.textContent = "Подключение";
  callSubstatus.textContent = "Запрашиваем микрофон.";

  try {
    await ensureMic();
    callSubstatus.textContent = "Микрофон получен. Подключаем перевод.";

    const bootstrap = await bootstrapRealtime({
      sessionId: currentSession.id,
      role: "client",
      speakerLanguageHint: languageHint(),
    });

    if (!bootstrap.ready) {
      throw new Error("Сервер не смог создать relay.");
    }

    callSubstatus.textContent = "Запускаем аудио-стриминг.";

    mediaHandle = await connectMediaStream(ws, micStream);
    ws?.send(JSON.stringify({ type: "participant.state", patch: { micGranted: true, realtimeConnected: true } }));
    startTimer();
    callStatus.textContent = "Разговор";
    callSubstatus.textContent = "Перевод идёт.";
    callTimer.classList.remove("hidden");
    clientEndSwipe.classList.remove("hidden");
  } catch (error) {
    callStatus.textContent = "Ошибка";
    callSubstatus.textContent = error.message || "Не удалось подключиться.";
    console.error("startConversation error:", error);
  }
}

async function ensureMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  const finalDuration = callTimer.textContent || "00:00";

  if (currentSession) {
    await fetchJson("/api/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId: currentSession.id, reason }),
    }).catch(() => {});
  }
  await teardownMedia();
  if (!options.silent) {
    callStatus.textContent = "Разговор завершён";
    callTimer.textContent = finalDuration;
    callTimer.classList.remove("hidden");
    callSubstatus.textContent = "";
    clientEndSwipe.classList.add("hidden");
    markQrExpired();
    setTab(1);
  }
}

async function teardownMedia() {
  stopTimer();
  mediaHandle?.teardown();
  mediaHandle = null;
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}
