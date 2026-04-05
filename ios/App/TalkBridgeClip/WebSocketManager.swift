import Foundation

protocol WebSocketManagerDelegate: AnyObject {
    func didReceiveJSON(_ json: [String: Any])
    func didReceiveBinary(_ data: Data)
    func didDisconnect(error: Error?)
}

class WebSocketManager: NSObject, URLSessionWebSocketDelegate {
    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession?
    weak var delegate: WebSocketManagerDelegate?

    func connect(sessionId: String, role: String) {
        let urlString = "wss://talk-bridge-mvp.onrender.com/api/session/signal?sessionId=\(sessionId)&role=\(role)"
        guard let url = URL(string: urlString) else { return }

        session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        webSocket = session?.webSocketTask(with: url)
        webSocket?.resume()
        receiveMessage()
    }

    func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(str)) { error in
            if let error = error {
                print("[ws] send error: \(error)")
            }
        }
    }

    func sendBinary(_ data: Data) {
        webSocket?.send(.data(data)) { error in
            if let error = error {
                print("[ws] binary send error: \(error)")
            }
        }
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self?.delegate?.didReceiveJSON(json)
                    }
                case .data(let data):
                    self?.delegate?.didReceiveBinary(data)
                @unknown default:
                    break
                }
                self?.receiveMessage() // continue listening
            case .failure(let error):
                self?.delegate?.didDisconnect(error: error)
            }
        }
    }

    // URLSessionWebSocketDelegate
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("[ws] connected")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("[ws] closed: \(closeCode)")
        delegate?.didDisconnect(error: nil)
    }
}
