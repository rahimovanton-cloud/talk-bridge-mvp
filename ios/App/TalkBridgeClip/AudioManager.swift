import AVFoundation

protocol AudioManagerDelegate: AnyObject {
    func didCapturePCM(_ data: Data)
}

class AudioManager {
    weak var delegate: AudioManagerDelegate?

    private let engine = AVAudioEngine()
    private let targetRate: Double = 24000
    private let chunkSamples = 480 // 20ms at 24kHz
    private var captureBuffer = [Float]()

    // Playback ring buffer
    private var playbackBuffer = [Float]()
    private let playbackLock = NSLock()
    private var playerNode: AVAudioPlayerNode?
    private var isPlaying = false

    func setupSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, options: [])
        try session.overrideOutputAudioPort(.none) // earpiece
        try session.setActive(true)
        print("[audio] session active, route: \(session.currentRoute.outputs.map { $0.portType.rawValue })")
    }

    func startCapture() throws {
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        let sampleRate = inputFormat.sampleRate
        let ratio = sampleRate / targetRate

        print("[audio] capture: inputRate=\(sampleRate), ratio=\(ratio)")

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            let channelData = buffer.floatChannelData?[0]
            let frameCount = Int(buffer.frameLength)
            guard let samples = channelData, frameCount > 0 else { return }

            // Accumulate samples
            self.captureBuffer.append(contentsOf: UnsafeBufferPointer(start: samples, count: frameCount))

            // Emit 20ms chunks at 24kHz
            let samplesNeeded = Int(ceil(Double(self.chunkSamples) * ratio))
            while self.captureBuffer.count >= samplesNeeded {
                let chunk = Array(self.captureBuffer.prefix(samplesNeeded))
                self.captureBuffer.removeFirst(samplesNeeded)

                // Linear-interpolation resample to 24kHz Int16
                var resampled = [Int16](repeating: 0, count: self.chunkSamples)
                for i in 0..<self.chunkSamples {
                    let srcIdx = Double(i) * ratio
                    let idx = Int(srcIdx)
                    let frac = Float(srcIdx - Double(idx))
                    let a = idx < chunk.count ? chunk[idx] : 0
                    let b = min(idx + 1, chunk.count - 1) < chunk.count ? chunk[min(idx + 1, chunk.count - 1)] : 0
                    let val = a + frac * (b - a)
                    resampled[i] = Int16(max(-32768, min(32767, val * 32767)))
                }

                // Convert to Data and send
                let data = resampled.withUnsafeBytes { rawBuf in
                    Data(rawBuf)
                }
                self.delegate?.didCapturePCM(data)
            }
        }

        try engine.start()
        print("[audio] engine started")
    }

    /// Receive translated PCM16 24kHz from server, play through earpiece
    func playPCM(_ data: Data) {
        guard data.count >= 2 else { return }

        let sampleRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        let sourceRate: Double = 24000
        let ratio = sampleRate / sourceRate

        // Decode Int16 to Float32
        let int16Count = data.count / 2
        let int16 = data.withUnsafeBytes { ptr in
            Array(UnsafeBufferPointer(start: ptr.baseAddress!.assumingMemoryBound(to: Int16.self), count: int16Count))
        }

        // Resample to device rate
        let outputLen = Int(ceil(Double(int16.count) * ratio))
        var floats = [Float](repeating: 0, count: outputLen)
        for j in 0..<outputLen {
            let srcIdx = Double(j) / ratio
            let idx = Int(srcIdx)
            let frac = Float(srcIdx - Double(idx))
            let a = idx < int16.count ? Float(int16[idx]) / 32768.0 : 0
            let b = min(idx + 1, int16.count - 1) < int16.count ? Float(int16[min(idx + 1, int16.count - 1)]) / 32768.0 : 0
            floats[j] = (a + frac * (b - a)) * 0.3 // volume 30%
        }

        // Create AVAudioPCMBuffer and schedule playback
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { return }
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(outputLen)) else { return }
        pcmBuffer.frameLength = AVAudioFrameCount(outputLen)
        if let channelData = pcmBuffer.floatChannelData?[0] {
            for i in 0..<outputLen {
                channelData[i] = floats[i]
            }
        }

        if playerNode == nil {
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            playerNode = node
        }

        if !isPlaying {
            playerNode?.play()
            isPlaying = true
        }
        playerNode?.scheduleBuffer(pcmBuffer)
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        playerNode?.stop()
        engine.stop()
        isPlaying = false
        captureBuffer.removeAll()
        print("[audio] stopped")
    }
}
