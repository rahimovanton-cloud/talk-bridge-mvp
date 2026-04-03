/**
 * AudioWorklet processors for Talk Bridge server relay.
 *
 * MicCaptureProcessor: mic (48kHz Float32) → resample to 24kHz Int16 → postMessage
 * PlaybackProcessor:   postMessage (24kHz Int16) → resample to device rate Float32 → speaker
 */

/* ── MicCaptureProcessor ── */
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    // We output 24kHz PCM in 20ms chunks = 480 samples
    this._targetRate = 24000;
    this._chunkSize = 480;
    this._framesProcessed = 0;
    this._chunksEmitted = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this._framesProcessed++;

    // Accumulate float samples
    const merged = new Float32Array(this._buffer.length + input.length);
    merged.set(this._buffer);
    merged.set(input, this._buffer.length);
    this._buffer = merged;

    // Resample and emit 20ms chunks at 24kHz
    const ratio = sampleRate / this._targetRate;
    const samplesNeeded = Math.ceil(this._chunkSize * ratio);

    while (this._buffer.length >= samplesNeeded) {
      const chunk = this._buffer.subarray(0, samplesNeeded);
      this._buffer = this._buffer.subarray(samplesNeeded);

      // Simple linear-interpolation resample
      const resampled = new Int16Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        const srcIdx = i * ratio;
        const idx = Math.floor(srcIdx);
        const frac = srcIdx - idx;
        const a = chunk[idx] ?? 0;
        const b = chunk[Math.min(idx + 1, chunk.length - 1)] ?? 0;
        const val = a + frac * (b - a);
        resampled[i] = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
      }

      this._chunksEmitted++;
      this.port.postMessage(resampled.buffer, [resampled.buffer]);
    }

    if (this._framesProcessed % 200 === 0) {
      this.port.postMessage({ type: "stats", framesProcessed: this._framesProcessed, chunksEmitted: this._chunksEmitted, bufferLen: this._buffer.length });
    }

    return true;
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);

/* ── PlaybackProcessor ── */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sourceRate = 24000;
    // Ring buffer: ~500ms at device sample rate (generous for jitter)
    this._ringSize = Math.ceil(sampleRate * 0.5);
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;
    this._readPos = 0;
    this._count = 0; // samples available
    this._chunksReceived = 0;
    this._framesOutput = 0;
    this._nonSilentFrames = 0;

    this.port.onmessage = (e) => {
      // Receive Int16 PCM at 24kHz, resample to device rate, push to ring
      const int16 = new Int16Array(e.data);
      this._chunksReceived++;
      const ratio = this._sourceRate / sampleRate;
      const outputLen = Math.ceil(int16.length / ratio);

      for (let i = 0; i < outputLen; i++) {
        const srcIdx = i * ratio;
        const idx = Math.floor(srcIdx);
        const frac = srcIdx - idx;
        const a = (int16[idx] ?? 0) / 32768;
        const b = (int16[Math.min(idx + 1, int16.length - 1)] ?? 0) / 32768;
        const val = a + frac * (b - a);

        this._ring[this._writePos] = val;
        this._writePos = (this._writePos + 1) % this._ringSize;
        if (this._count < this._ringSize) {
          this._count++;
        } else {
          // Overrun: advance read pointer
          this._readPos = (this._readPos + 1) % this._ringSize;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    this._framesOutput++;
    let hadSamples = false;
    for (let i = 0; i < output.length; i++) {
      if (this._count > 0) {
        output[i] = this._ring[this._readPos];
        this._readPos = (this._readPos + 1) % this._ringSize;
        this._count--;
        hadSamples = true;
      } else {
        output[i] = 0;
      }
    }
    if (hadSamples) this._nonSilentFrames++;

    if (this._framesOutput % 200 === 0) {
      this.port.postMessage({ type: "stats", chunksReceived: this._chunksReceived, framesOutput: this._framesOutput, nonSilentFrames: this._nonSilentFrames, ringCount: this._count });
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
