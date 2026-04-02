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

  pc.addEventListener("connectionstatechange", () => {
    console.log("OpenAI WebRTC state:", pc.connectionState);
    onState?.(pc.connectionState);
  });
  pc.addEventListener("track", (event) => {
    console.log("OpenAI track received:", event.track.kind);
    onTrack(event.track, event.streams[0]);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // OpenAI Realtime WebRTC endpoint
  const model = "gpt-4o-realtime-preview";
  const response = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("OpenAI WebRTC error:", response.status, errText);
    throw new Error(`OpenAI Realtime: ${response.status} ${errText.slice(0, 200)}`);
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
  // Append to DOM — required on iOS Safari for audio playback
  audio.style.display = "none";
  document.body.appendChild(audio);
  audio.play().catch((err) => console.warn("audio play blocked:", err));
  return audio;
}
