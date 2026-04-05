import Foundation

struct SessionData: Codable {
    let id: String
    let status: String
    let model: String
    let clientName: String
    let clientPhotoUrl: String?
    let clientLanguageHint: String?
    let receiverLanguageHint: String?
    let startedAt: String?
    let expiresAt: String?
}

struct InviteResponse: Codable {
    let session: SessionData
}

struct AcceptResponse: Codable {
    let session: SessionData
}

struct BootstrapResponse: Codable {
    let ready: Bool
}

enum APIError: Error, LocalizedError {
    case httpError(Int, String)
    case decodingError
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .httpError(_, let msg): return msg
        case .decodingError: return "Failed to decode response"
        case .networkError(let err): return err.localizedDescription
        }
    }
}

class APIClient {
    static let baseURL = "https://talk-bridge-mvp.onrender.com"

    static func fetchInvite(token: String) async throws -> SessionData {
        let url = URL(string: "\(baseURL)/api/invite/\(token)")!
        let (data, response) = try await URLSession.shared.data(from: url)
        try checkResponse(response, data: data)
        let decoded = try JSONDecoder().decode(InviteResponse.self, from: data)
        return decoded.session
    }

    static func acceptSession(sessionId: String, languageHint: String) async throws -> SessionData {
        let url = URL(string: "\(baseURL)/api/session/accept")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["sessionId": sessionId, "receiverLanguageHint": languageHint]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        let decoded = try JSONDecoder().decode(AcceptResponse.self, from: data)
        return decoded.session
    }

    static func bootstrapRealtime(sessionId: String, role: String, languageHint: String) async throws -> Bool {
        let url = URL(string: "\(baseURL)/api/realtime/bootstrap")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["sessionId": sessionId, "role": role, "speakerLanguageHint": languageHint]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        let decoded = try JSONDecoder().decode(BootstrapResponse.self, from: data)
        return decoded.ready
    }

    static func endSession(sessionId: String, reason: String) async throws {
        let url = URL(string: "\(baseURL)/api/session/end")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["sessionId": sessionId, "reason": reason]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
    }

    private static func checkResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if http.statusCode >= 400 {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
                ?? "Request failed (\(http.statusCode))"
            throw APIError.httpError(http.statusCode, msg)
        }
    }
}
