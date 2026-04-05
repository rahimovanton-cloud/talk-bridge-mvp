/**
 * Route audio to earpiece (native Capacitor only, no-op in browser).
 */
export function setEarpiece() {
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioRoute) {
    return window.Capacitor.Plugins.AudioRoute.setEarpiece();
  }
  return Promise.resolve();
}

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
      if (onBinary) onBinary(event.data);
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
      ...((options && options.headers) || {}),
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

  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  console.log("[audio] connectMediaStream: state=" + audioCtx.state + " rate=" + audioCtx.sampleRate);

  // Playback volume — тихо, чтобы чужой микрофон не ловил наш динамик
  var playbackGain = audioCtx.createGain();
  playbackGain.gain.value = 0.3;
  playbackGain.connect(audioCtx.destination);

  var micSource = audioCtx.createMediaStreamSource(micStream);
  var captureCleanup;
  var micChunksSent = 0;
  var TARGET_RATE = 24000;
  var CHUNK_SAMPLES = 480; // 20ms at 24kHz

  function sendPcm(int16buf) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(int16buf);
      micChunksSent++;
      if (micChunksSent % 50 === 0) {
        console.log("mic: sent " + micChunksSent + " chunks");
      }
    }
  }

  // ── Mic capture: AudioWorklet if available, ScriptProcessor fallback ──
  if (audioCtx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    await audioCtx.audioWorklet.addModule("/audio-processor.js");
    var captureNode = new AudioWorkletNode(audioCtx, "mic-capture-processor");
    captureNode.port.onmessage = function(e) {
      if (e.data && e.data.type === "stats") return;
      sendPcm(e.data);
    };
    micSource.connect(captureNode);
    captureCleanup = function() {
      try { micSource.disconnect(); } catch(ex) {}
      try { captureNode.disconnect(); } catch(ex) {}
    };
  } else {
    // ScriptProcessorNode fallback (deprecated but works on old iOS)
    console.log("[audio] using ScriptProcessor fallback");
    var bufSize = 4096;
    var scriptNode = audioCtx.createScriptProcessor(bufSize, 1, 1);
    var captureBuffer = new Float32Array(0);
    var ratio = audioCtx.sampleRate / TARGET_RATE;

    scriptNode.onaudioprocess = function(e) {
      var input = e.inputBuffer.getChannelData(0);
      // silence output so mic doesn't echo
      var output = e.outputBuffer.getChannelData(0);
      for (var k = 0; k < output.length; k++) output[k] = 0;

      // accumulate
      var merged = new Float32Array(captureBuffer.length + input.length);
      merged.set(captureBuffer);
      merged.set(input, captureBuffer.length);
      captureBuffer = merged;

      var samplesNeeded = Math.ceil(CHUNK_SAMPLES * ratio);
      while (captureBuffer.length >= samplesNeeded) {
        var chunk = captureBuffer.subarray(0, samplesNeeded);
        captureBuffer = captureBuffer.subarray(samplesNeeded);
        // linear resample to 24kHz Int16
        var resampled = new Int16Array(CHUNK_SAMPLES);
        for (var i = 0; i < CHUNK_SAMPLES; i++) {
          var srcIdx = i * ratio;
          var idx = Math.floor(srcIdx);
          var frac = srcIdx - idx;
          var a = chunk[idx] || 0;
          var b = chunk[Math.min(idx + 1, chunk.length - 1)] || 0;
          var val = a + frac * (b - a);
          resampled[i] = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
        }
        sendPcm(resampled.buffer);
      }
    };

    micSource.connect(scriptNode);
    scriptNode.connect(audioCtx.destination); // must connect to destination to keep it alive
    captureCleanup = function() {
      try { micSource.disconnect(); } catch(ex) {}
      try { scriptNode.disconnect(); } catch(ex) {}
    };
  }

  // ── Playback: WS binary → AudioBufferSourceNode → speaker ──
  var playbackChunksReceived = 0;
  var nextPlayTime = 0;
  var SOURCE_RATE = 24000;

  function handleBinaryAudio(arrayBuffer) {
    playbackChunksReceived++;
    if (playbackChunksReceived <= 3 || playbackChunksReceived % 50 === 0) {
      console.log("playback: #" + playbackChunksReceived + " " + arrayBuffer.byteLength + "B");
    }

    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(function(){});
    }

    var int16 = new Int16Array(arrayBuffer);
    var float32 = new Float32Array(int16.length);
    for (var i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    var ratio = audioCtx.sampleRate / SOURCE_RATE;
    var samples = float32;
    if (ratio !== 1) {
      var resampledLen = Math.round(float32.length * ratio);
      var resampled = new Float32Array(resampledLen);
      for (var j = 0; j < resampledLen; j++) {
        var srcIdx = j / ratio;
        var idx = Math.floor(srcIdx);
        var frac = srcIdx - idx;
        var a = float32[idx] || 0;
        var b = float32[Math.min(idx + 1, float32.length - 1)] || 0;
        resampled[j] = a + frac * (b - a);
      }
      samples = resampled;
    }

    var buffer = audioCtx.createBuffer(1, samples.length, audioCtx.sampleRate);
    buffer.getChannelData(0).set(samples);

    var source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackGain);

    var now = audioCtx.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.02;
    }
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
  }

  var binaryListener = function(event) {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryAudio(event.data);
    }
  };
  ws.addEventListener("message", binaryListener);

  function teardown() {
    ws.removeEventListener("message", binaryListener);
    if (captureCleanup) captureCleanup();
    try { audioCtx.close(); } catch(ex) {}
  }

  return { teardown: teardown };
}
