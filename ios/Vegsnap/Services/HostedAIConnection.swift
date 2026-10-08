import Foundation
import Security
import UIKit

struct ServiceConfiguration: Decodable {
    var baseUrl: String
    var model: String?
    static func load(_ name: String) throws -> Self {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "Generated") else { throw AppError("Run bun run ios:prepare before building.") }
        let config = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard safeURL(config.baseUrl) != nil else { throw AppError("Invalid service configuration.") }
        return config
    }
}
struct HostedAIStatus: Decodable {
    var state: String
    var remaining: Int
    var expiresAt: Double
    var enabled: Bool
    static func decode(_ data: Data) throws -> Self {
        let status = try JSONDecoder().decode(Self.self, from: data)
        guard ["pending", "connected"].contains(status.state), status.remaining >= 0, status.expiresAt.isFinite, status.expiresAt > 0 else { throw AppError(L("The service returned an invalid response.")) }
        return status
    }
}
@MainActor @Observable final class HostedAIConnection {
    let configuration: ServiceConfiguration
    private(set) var token: String
    private(set) var status: HostedAIStatus?
    private(set) var busy = false
    var error: String?
    private var task: Task<Void, Never>?
    private var generation = 0
    private var credentialKey: String { configuration.baseUrl + "/ios-access" }
    var ready: Bool { Self.validToken(token) && status?.state == "connected" && status?.enabled == true && (status?.expiresAt ?? 0) > Date().timeIntervalSince1970 * 1000 }
    init(configuration: ServiceConfiguration) throws {
        self.configuration = configuration
        token = try Keychain.read(configuration.baseUrl + "/ios-access")
    }
    static func validToken(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
    static func randomID() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw AppError("Secure random generation failed.") }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    func cancel() { generation += 1; task?.cancel(); task = nil; busy = false }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        let current = generation
        task = Task {
            defer { if current == generation { busy = false } }
            do { try await operation() } catch is CancellationError {} catch { if current == generation { self.error = error.localizedDescription } }
        }
    }
    func connect() {
        perform {
            var installation = try Keychain.read(self.configuration.baseUrl + "/ios-installation")
            if !Self.validToken(installation) { installation = try Self.randomID(); try Keychain.save(installation, for: self.configuration.baseUrl + "/ios-installation") }
            let token = Self.validToken(self.token) ? self.token : try Self.randomID()
            let (_, response) = try await self.request("/api/connect", method: "POST", token: token, body: ["installationId": installation])
            guard (200...201).contains(response.statusCode) else { throw AppError(L("Vegsnap AI is unavailable. Try again later.")) }
            try Task.checkCancellation()
            try Keychain.save(token, for: self.credentialKey); self.token = token
            try await self.updateStatus(token)
            if self.status?.state == "pending" {
                let url = URL(string: self.configuration.baseUrl + "/#token=" + token + "&client=ios")!
                await UIApplication.shared.open(url)
            }
        }
    }
    func refresh() { guard Self.validToken(token) else { return }; perform { try await self.updateStatus(self.token) } }
    private func updateStatus(_ token: String) async throws {
        let (data, response) = try await request("/api/session", method: "GET", token: token)
        try Task.checkCancellation()
        guard token == self.token else { return }
        if response.statusCode == 401 { status = nil; return }
        guard response.statusCode == 200 else { throw AppError(L("Vegsnap AI is unavailable. Try again later.")) }
        status = try HostedAIStatus.decode(data)
    }
    func disconnect(offline: Bool) throws {
        cancel(); let previous = token
        try Keychain.save("", for: credentialKey); token = ""; status = nil
        if !offline && Self.validToken(previous) { perform { _ = try await self.request("/api/session", method: "DELETE", token: previous) } }
    }
    private func request(_ path: String, method: String, token: String, body: [String: String]? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: URL(string: configuration.baseUrl + path)!)
        request.httpMethod = method; request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try body.jsonData(); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return try await Network.read(request, limit: 4096)
    }
}
