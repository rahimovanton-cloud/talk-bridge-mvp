export const MODEL_LABELS = {
  mini: "gpt-4o-mini-realtime-preview",
  full: "gpt-4o-realtime-preview",
};

export function languageHint() {
  return (navigator.language || "en").split("-")[0];
}

export function formatDuration(startedAt) {
  if (!startedAt) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function connectSignalSocket({ sessionId, role, onMessage, onBinary }) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/api/session/signal?sessionId=${encodeURIComponent(sessionId)}&role=${role}`);
  ws.binaryType = "arraybuffer";

  // Queue messages so async handlers finish before next message is processed.
  let queue = Promise.resolve();
  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      // Binary frame = translated PCM audio from server
      onBinary?.(event.data);
      return;
    }
    queue = queue.then(() => onMessage(JSON.parse(event.data))).catch((err) => console.error("ws handler error:", err));
  });
  return ws;
}

export async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Request failed");
  }
  return payload;
}

export async function bootstrapRealtime({ sessionId, role, speakerLanguageHint }) {
  const payload = await fetchJson("/api/realtime/bootstrap", {
    method: "POST",
    body: JSON.stringify({ sessionId, role, speakerLanguageHint }),
  });
  console.log("bootstrap response:", JSON.stringify(payload).slice(0, 300));
  return { ready: payload.ready };
}

/**
 * Pre-create an AudioContext during a user gesture (click/touch/swipe).
 * Call this synchronously inside a gesture handler, BEFORE any await.
 * Returns the AudioContext so it can be passed to connectMediaStream().
 */
export function createAudioContextNow() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  console.log(`[audio] createAudioContextNow: state=${ctx.state}, sampleRate=${ctx.sampleRate}`);
  return ctx;
}

/**
 * Connect mic audio stream to server via WebSocket binary frames,
 * and play back translated audio received from server.
 *
 * @param {WebSocket} ws
 * @param {MediaStream} micStream
 * @param {AudioContext} [audioCtx] - optional pre-created AudioContext (from user gesture)
 * Returns { teardown, handleBinaryAudio }.
 */
export async function connectMediaStream(ws, micStream, audioCtx) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  }

  // Resume context (iOS requires user gesture)
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  console.log(`[audio] connectMediaStream: audioCtx.state=${audioCtx.state}, sampleRate=${audioCtx.sampleRate}`);

  // Load AudioWorklet
  await audioCtx.audioWorklet.addModule("/audio-processor.js");

  // ── Mic capture: mic → AudioWorklet → WS binary ──
  const micSource = audioCtx.createMediaStreamSource(micStream);
  const captureNode = new AudioWorkletNode(audioCtx, "mic-capture-processor");

  let micChunksSent = 0;
  captureNode.port.onmessage = (e) => {
    if (e.data && e.data.type === "stats") {
      console.log("[MicCapture stats]", e.data);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(e.data); // ArrayBuffer of Int16 PCM 24kHz
      micChunksSent++;
      if (micChunksSent % 50 === 0) {
        console.log(`mic: sent ${micChunksSent} chunks via WS`);
      }
    }
  };

  micSource.connect(captureNode);
  // captureNode does NOT connect to destination (no local playback of mic)

  // ── Playback: WS binary → AudioBufferSourceNode → speaker ──
  // Listens directly on the WS for binary frames — no external wiring needed.
  let playbackChunksReceived = 0;
  let nextPlayTime = 0;
  const SOURCE_RATE = 24000;

  function handleBinaryAudio(arrayBuffer) {
    playbackChunksReceived++;
    if (playbackChunksReceived <= 3 || playbackChunksReceived % 50 === 0) {
      console.log(`playback: chunk #${playbackChunksReceived}, ${arrayBuffer.byteLength} bytes, ctxState=${audioCtx.state}, currentTime=${audioCtx.currentTime.toFixed(3)}`);
      // Report to server for remote debugging
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "debug.playback",
            chunks: playbackChunksReceived,
            bytes: arrayBuffer.byteLength,
            ctxState: audioCtx.state,
            ctxTime: audioCtx.currentTime,
            sampleRate: audioCtx.sampleRate,
          }));
        }
      } catch {}
    }

    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    // Convert Int16 PCM 24kHz → Float32
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Create AudioBuffer at source rate (24kHz) — browser handles resampling
    const buffer = audioCtx.createBuffer(1, float32.length, SOURCE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);

    // Schedule seamless playback
    const now = audioCtx.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.02; // small lead-in to avoid click
    }
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
  }

  // Listen for binary frames directly on the WS
  const binaryListener = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryAudio(event.data);
    }
  };
  ws.addEventListener("message", binaryListener);

  function teardown() {
    ws.removeEventListener("message", binaryListener);
    try { micSource.disconnect(); } catch {}
    try { captureNode.disconnect(); } catch {}
    try { audioCtx.close(); } catch {}
  }

  return { teardown };
}
