export const MODEL_LABELS = {
  mini: "gpt-realtime-mini",
  full: "gpt-realtime",
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

export function connectSignalSocket({ sessionId, role, onMessage }) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/api/session/signal?sessionId=${encodeURIComponent(sessionId)}&role=${role}`);
  ws.addEventListener("message", (event) => {
    onMessage(JSON.parse(event.data));
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

export function setErrorBanner(element, message) {
  element.textContent = message;
  element.classList.add("error");
}

export function clearErrorBanner(element, message) {
  element.textContent = message;
  element.classList.remove("error");
}

export async function bootstrapRealtime({ sessionId, role, speakerLanguageHint }) {
  const payload = await fetchJson("/api/realtime/bootstrap", {
    method: "POST",
    body: JSON.stringify({ sessionId, role, speakerLanguageHint }),
  });
  return payload.clientSecret;
}

export async function connectOpenAiRealtime({ token, micStream, onTrack, onEvent, onState }) {
  const pc = new RTCPeerConnection();
  const audioTrack = micStream.getAudioTracks()[0];
  if (audioTrack) {
    pc.addTrack(audioTrack, micStream);
  }

  const dc = pc.createDataChannel("oai-events");
  dc.addEventListener("message", (event) => {
    try {
      onEvent?.(JSON.parse(event.data));
    } catch {
      onEvent?.(event.data);
    }
  });

  pc.addEventListener("connectionstatechange", () => onState?.(pc.connectionState));
  pc.addEventListener("track", (event) => onTrack(event.track, event.streams[0]));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });

  if (!response.ok) {
    throw new Error(`OpenAI call failed: ${response.status}`);
  }

  const answerSdp = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return { pc, dc };
}

export function attachRemoteAudio(trackOrStream) {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = trackOrStream instanceof MediaStream ? trackOrStream : new MediaStream([trackOrStream]);
  audio.play().catch(() => {});
  return audio;
}
