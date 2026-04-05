import SwiftUI
import AVFoundation

enum CallState: Equatable {
    case waitingForLink
    case loading
    case incoming
    case connecting
    case active
    case ended
    case error(String)

    static func == (lhs: CallState, rhs: CallState) -> Bool {
        switch (lhs, rhs) {
        case (.waitingForLink, .waitingForLink), (.loading, .loading), (.incoming, .incoming), (.connecting, .connecting),
             (.active, .active), (.ended, .ended):
            return true
        case (.error(let a), .error(let b)):
            return a == b
        default:
            return false
        }
    }
}

class CallManager: ObservableObject, WebSocketManagerDelegate, AudioManagerDelegate {
    @Published var state: CallState = .waitingForLink
    @Published var session: SessionData?
    @Published var elapsedSeconds: Int = 0

    private let wsManager = WebSocketManager()
    private let audioManager = AudioManager()
    private var timer: Timer?

    var languageHint: String {
        Locale.current.language.languageCode?.identifier ?? "en"
    }

    /// Extract token from a full URL or bare token string
    func loadFromURL(_ urlString: String) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        // Could be full URL like https://.../join/TOKEN or just TOKEN
        if let url = URL(string: trimmed), let last = url.pathComponents.last, last != "join", !last.isEmpty {
            loadInvite(token: last)
        } else if !trimmed.isEmpty {
            loadInvite(token: trimmed)
        }
    }

    func loadInvite(token: String) {
        state = .loading
        Task { @MainActor in
            do {
                let sess = try await APIClient.fetchInvite(token: token)
                self.session = sess
                self.state = .incoming
                self.wsManager.delegate = self
                self.wsManager.connect(sessionId: sess.id, role: "receiver")
            } catch {
                self.state = .error(error.localizedDescription)
            }
        }
    }

    func acceptCall() {
        guard let sess = session else { return }
        state = .connecting

        Task { @MainActor in
            do {
                // Accept on server
                let updated = try await APIClient.acceptSession(
                    sessionId: sess.id,
                    languageHint: languageHint
                )
                self.session = updated

                // Bootstrap realtime relay
                let ready = try await APIClient.bootstrapRealtime(
                    sessionId: sess.id,
                    role: "receiver",
                    languageHint: languageHint
                )
                guard ready else {
                    self.state = .error("Server failed to create relay")
                    return
                }

                // Setup native audio (earpiece)
                try self.audioManager.setupSession()
                self.audioManager.delegate = self
                try self.audioManager.startCapture()

                // Notify server
                self.wsManager.sendJSON([
                    "type": "participant.state",
                    "patch": ["micGranted": true, "realtimeConnected": true]
                ])

                self.state = .active
                self.startTimer()
            } catch {
                self.state = .error(error.localizedDescription)
            }
        }
    }

    func endCall() {
        guard let sess = session else { return }
        stopTimer()
        audioManager.stop()

        Task {
            try? await APIClient.endSession(sessionId: sess.id, reason: "ended_by_receiver")
        }

        wsManager.disconnect()
        state = .ended
    }

    // MARK: - Timer

    private func startTimer() {
        elapsedSeconds = 0
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.elapsedSeconds += 1
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    var formattedTime: String {
        let mm = String(format: "%02d", elapsedSeconds / 60)
        let ss = String(format: "%02d", elapsedSeconds % 60)
        return "\(mm):\(ss)"
    }

    // MARK: - WebSocketManagerDelegate

    func didReceiveJSON(_ json: [String: Any]) {
        let type = json["type"] as? String ?? ""

        if type == "session.updated" || type == "session.ended" {
            if let status = (json["session"] as? [String: Any])?["status"] as? String {
                if ["ended", "expired", "failed", "cancelled"].contains(status) {
                    DispatchQueue.main.async {
                        self.audioManager.stop()
                        self.stopTimer()
                        self.state = .ended
                    }
                }
            }
        }
    }

    func didReceiveBinary(_ data: Data) {
        // Translated PCM16 audio from server → play through earpiece
        audioManager.playPCM(data)
    }

    func didDisconnect(error: Error?) {
        DispatchQueue.main.async {
            if self.state == .active {
                self.audioManager.stop()
                self.stopTimer()
                self.state = .ended
            }
        }
    }

    // MARK: - AudioManagerDelegate

    func didCapturePCM(_ data: Data) {
        // Mic PCM16 24kHz → send as binary to server
        wsManager.sendBinary(data)
    }
}
