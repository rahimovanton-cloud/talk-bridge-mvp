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
 * Connect mic audio stream to server via WebSocket binary frames,
 * and play back translated audio received from server.
 *
 * Returns a teardown function.
 */
export async function connectMediaStream(ws, micStream) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

  // Resume context (iOS requires user gesture)
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

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

  // ── Playback: WS binary → AudioWorklet → speaker ──
  const playbackNode = new AudioWorkletNode(audioCtx, "playback-processor", {
    outputChannelCount: [1],
  });
  playbackNode.connect(audioCtx.destination);

  // Listen for stats from playback processor
  let playbackChunksReceived = 0;
  playbackNode.port.onmessage = (e) => {
    if (e.data && e.data.type === "stats") {
      console.log("[Playback stats]", e.data);
    }
  };

  // Handler for binary audio from server
  function handleBinaryAudio(arrayBuffer) {
    playbackChunksReceived++;
    if (playbackChunksReceived % 50 === 0) {
      console.log(`playback: received ${playbackChunksReceived} chunks from WS`);
    }
    playbackNode.port.postMessage(arrayBuffer, [arrayBuffer]);
  }

  function teardown() {
    try { micSource.disconnect(); } catch {}
    try { captureNode.disconnect(); } catch {}
    try { playbackNode.disconnect(); } catch {}
    try { audioCtx.close(); } catch {}
  }

  return { teardown, handleBinaryAudio };
}
