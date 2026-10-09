import Foundation
import AuthenticationServices
import Network
import CryptoKit
import Security
import UIKit

private let issuer = "https://auth.openai.com"
private let resource = "https://api.openai.com/v1"
private let bootstrap = "dynamic_agent_client"

struct ChatGPTSession: Codable {
    var clientID: String; var subject: String; var email: String; var idToken: String
    var accessToken: String; var refreshToken: String; var scopes: [String]; var expiresAt: Double
}
struct OAuthTokens: Decodable {
    var access_token: String; var refresh_token: String?; var id_token: String?
    var expires_in: Int; var token_type: String; var scope: String?
    func validatedScopes(previous: [String] = []) throws -> [String] {
        let scopes = scope?.split(whereSeparator: \.isWhitespace).map(String.init) ?? previous
        guard token_type.lowercased() == "bearer", !access_token.isEmpty, (1...31_536_000).contains(expires_in), scopes.contains("chatgpt.tokens.use.direct") else { throw AppError(L("ChatGPT plan usage was not granted.")) }
        return scopes
    }
}
@MainActor @Observable final class ChatGPTConnection: NSObject, ASWebAuthenticationPresentationContextProviding {
    struct Account: Codable, Identifiable { var id: String; var email: String }
    var accounts: [Account] = []
    var modelMetadata: [String: String] = [:]
    var email = ""; var connected = false; var busy = false
    var selectedAccount: String?
    private var cancelled = false
    private static var sessionGeneration = 0
    private var browser: ASWebAuthenticationSession?
    private var listener: NWListener?
    private var callback: CheckedContinuation<URL, Error>?
    private var timeout: Task<Void, Never>?
    private static var refreshTask: Task<ChatGPTSession, Error>?
    private var expectedState = ""

    func loadStatus() {
        if let session = try? Self.load() { connected = true; email = session.email; selectedAccount = session.clientID } else { connected = false; email = ""; selectedAccount = nil }
        if let raw = try? Keychain.read(issuer + "/accounts"), let saved = try? JSONDecoder().decode([Account].self, from: Data(raw.utf8)) { accounts = saved }
    }
    static func load() throws -> ChatGPTSession? {
        let value = try Keychain.read(issuer)
        return value.isEmpty ? nil : try JSONDecoder().decode(ChatGPTSession.self, from: Data(value.utf8))
    }
    func disconnect() throws { cancel(); guard Self.refreshTask == nil else { throw AppError(L("Wait for the active request to finish.")) }; Self.sessionGeneration += 1; try Keychain.save("", for: issuer); connected = false; email = ""; selectedAccount = nil; modelMetadata = [:] }
    static func finishRefreshing() async throws {
        // A cancelled waiter must not cancel the refresh shared by other requests.
        while refreshTask != nil { try await Task.sleep(for: .milliseconds(50)) }
        try Task.checkCancellation()
    }
    func removeAccount(_ id: String) throws {
        guard !busy else { return }
        if try Self.load()?.clientID == id { try disconnect() }
        let next = accounts.filter { $0.id != id }
        try Keychain.save(next.jsonString(), for: issuer + "/accounts")
        try Keychain.save("", for: issuer + "/subject/" + id)
        if try Keychain.read(issuer + "/registration") == id { try Keychain.save("", for: issuer + "/registration") }
        accounts = next; loadStatus()
    }
    static func preferredModel(current: String, available: [String]) -> String {
        if available.contains(current) { return current }
        return available.first(where: { $0 == "gpt-6-luna" }) ?? available.first ?? current
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func cancel() {
        cancelled = true
        callback?.resume(throwing: CancellationError()); callback = nil
        listener?.cancel(); listener = nil; browser?.cancel(); browser = nil; timeout?.cancel(); timeout = nil
    }
    func signIn(clientID: String? = nil, newAccount: Bool = false) async throws {
        guard !busy else { return }; busy = true; cancelled = false
        defer { cancel(); busy = false }
        let verifier = try Self.random(); let nonce = try Self.random(); expectedState = try Self.random()
        loadStatus()
        guard clientID == nil || accounts.contains(where: { $0.id == clientID }), !(newAccount && clientID != nil) else { throw AppError(L("Select a saved account or connect another account.")) }
        let storedRegistration = try Keychain.read(issuer + "/registration")
        let registration = newAccount ? "" : clientID ?? storedRegistration
        let returning = registration.isEmpty ? nil : registration
        let oldSubject = try Keychain.read(issuer + "/subject/" + registration)
        var host = try Keychain.read(issuer + "/host")
        if host.isEmpty { host = "urn:uuid:" + UUID().uuidString.lowercased(); try Keychain.save(host, for: issuer + "/host") }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters); self.listener = listener
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { state in
                Task { @MainActor in
                    guard !resumed else { return }
                    if case .ready = state, let port = listener.port { resumed = true; continuation.resume(returning: port.rawValue) }
                    if case .failed(let error) = state { resumed = true; continuation.resume(throwing: error) }
                    if case .cancelled = state { resumed = true; continuation.resume(throwing: CancellationError()) }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in Task { @MainActor in self?.receive(connection) } }
            listener.start(queue: .main)
        }
        try Task.checkCancellation()
        let redirect = "http://127.0.0.1:\(port)/auth/callback"
        var url = URLComponents(string: issuer + "/api/accounts/authorize")!
        var fields = ["client_id": returning ?? bootstrap, "ext_agent_host_id": host, "response_type": "code", "redirect_uri": redirect, "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", "resource": resource, "state": expectedState, "nonce": nonce, "code_challenge_method": "S256", "code_challenge": Data(SHA256.hash(data: Data(verifier.utf8))).base64URL]
        if returning == nil { fields["agent_name_hint"] = "Vegsnap" }
        if let returning {
            if let account = accounts.first(where: { $0.id == returning }), !account.email.isEmpty { fields["login_hint"] = account.email }
            if let active = try Self.load(), active.clientID == returning { fields["id_token_hint"] = active.idToken }
        }
        url.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        let returned: URL = try await withCheckedThrowingContinuation { continuation in
            callback = continuation
            browser = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "vegsnap-ios") { [weak self] _, error in
                Task { @MainActor in if error != nil { self?.callback?.resume(throwing: CancellationError()); self?.callback = nil } }
            }
            browser?.presentationContextProvider = self
            guard browser?.start() == true else { callback = nil; continuation.resume(throwing: AppError(L("Could not open sign-in."))); return }
            timeout = Task { [weak self] in do { try await Task.sleep(for: .seconds(180)); self?.cancel() } catch {} }
        }
        listener.cancel(); self.listener = nil
        browser?.cancel(); browser = nil
        let response = try Self.validateCallback(returned, state: expectedState, returning: returning)
        while UIApplication.shared.applicationState != .active {
            guard !cancelled else { throw CancellationError() }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard !cancelled else { throw CancellationError() }
        let tokens = try await Self.exchange(["grant_type": "authorization_code", "client_id": response.clientID, "code": response.code, "code_verifier": verifier, "redirect_uri": redirect, "resource": resource])
        let scopes = try tokens.validatedScopes()
        guard let id = tokens.id_token, let refresh = tokens.refresh_token, !refresh.isEmpty else { throw AppError(L("Sign-in did not return a complete session.")) }
        let identity = try await Self.identity(id, clientID: response.clientID, nonce: nonce)
        guard oldSubject.isEmpty || oldSubject == identity.subject else { throw AppError(L("The ChatGPT account changed. Reconnect the original account.")) }
        let session = ChatGPTSession(clientID: response.clientID, subject: identity.subject, email: identity.email, idToken: id, accessToken: tokens.access_token, refreshToken: refresh, scopes: scopes, expiresAt: Date().timeIntervalSince1970 + Double(tokens.expires_in))
        guard !cancelled else { throw CancellationError() }
        Self.sessionGeneration += 1
        modelMetadata = [:]
        try Keychain.save(response.clientID, for: issuer + "/registration")
        if !accounts.contains(where: { $0.id == response.clientID }) { accounts.append(Account(id: response.clientID, email: "")) }
        try Keychain.save(identity.subject, for: issuer + "/subject/" + response.clientID)
        try Keychain.save(session.jsonString(), for: issuer)
        if let index = accounts.firstIndex(where: { $0.id == response.clientID }) { accounts[index].email = identity.email; try Keychain.save(accounts.jsonString(), for: issuer + "/accounts") }
        loadStatus()
    }
    private func receive(_ connection: NWConnection, accumulated: Data = Data()) {
        if accumulated.isEmpty { connection.start(queue: .main) }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384 - accumulated.count) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                var buffer = accumulated; buffer.append(data ?? Data())
                let text = String(decoding: buffer, as: UTF8.self)
                guard text.contains("\r\n\r\n") else {
                    if complete || error != nil || buffer.count >= 16_384 { connection.cancel() } else { self.receive(connection, accumulated: buffer) }; return
                }
                let parts = text.components(separatedBy: "\r\n")[0].split(separator: " ")
                guard parts.count == 3, parts[0] == "GET", let url = URL(string: "http://127.0.0.1" + parts[1]),
                      url.path == "/auth/callback", let components = URLComponents(url: url, resolvingAgainstBaseURL: false), components.queryItems?.first(where: { $0.name == "state" })?.value == self.expectedState else { connection.cancel(); return }
                let html = "<!doctype html><meta name=viewport content='width=device-width'><title>Vegsnap</title><p>Return to Vegsnap to finish connecting.</p><a href='vegsnap-ios://auth/complete'>Return to Vegsnap</a>"
                let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n" + html
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                self.callback?.resume(returning: url); self.callback = nil
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if connection.state != .cancelled { connection.cancel() } }
    }
    static func validateCallback(_ url: URL, state: String, returning: String?) throws -> (code: String, clientID: String) {
        guard url.path == "/auth/callback", url.fragment == nil, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              Set(items.map(\.name)).count == items.count else { throw AppError("Invalid sign-in callback.") }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard values["state"] == state, values["error"] == nil, let code = values["code"], !code.isEmpty,
              let client = values["client_id"] ?? returning, client != bootstrap, !client.isEmpty, client.count <= 200,
              returning == nil || returning == client else { throw AppError(L("Sign-in was declined or did not match this request.")) }
        return (code, client)
    }
    private static func exchange(_ fields: [String: String]) async throws -> OAuthTokens {
        var request = URLRequest(url: URL(string: issuer + "/api/accounts/oauth/token")!); request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        request.httpBody = Data(fields.map { ($0.key.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") + "=" + ($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") }.joined(separator: "&").utf8)
        let (data, response) = try await Network.read(request, limit: 1_000_000)
        guard response.statusCode == 200 else { throw AppError(L("ChatGPT could not authorize this session. Try signing in again.")) }
        return try JSONDecoder().decode(OAuthTokens.self, from: data)
    }
    static func accessToken() async throws -> String {
        guard let session = try load() else { throw AppError(L("Connect ChatGPT in Settings.")) }
        if session.expiresAt > Date().timeIntervalSince1970 + 60 { return session.accessToken }
        if let refreshTask { try await finishRefreshing(); return try await refreshTask.value.accessToken }
        let generation = sessionGeneration
        let task = Task { @MainActor in
            defer { refreshTask = nil }
            let tokens = try await exchange(["grant_type": "refresh_token", "client_id": session.clientID, "refresh_token": session.refreshToken, "resource": resource])
            var next = session; next.scopes = try tokens.validatedScopes(previous: session.scopes)
            if let id = tokens.id_token {
                let identity = try await identity(id, clientID: session.clientID, nonce: nil)
                guard identity.subject == session.subject else { throw AppError(L("The ChatGPT account changed. Reconnect the original account.")) }
                next.idToken = id; next.email = identity.email
            }
            next.accessToken = tokens.access_token; next.expiresAt = Date().timeIntervalSince1970 + Double(tokens.expires_in)
            if let refresh = tokens.refresh_token, !refresh.isEmpty { next.refreshToken = refresh }
            guard generation == sessionGeneration else { throw CancellationError() }
            try Keychain.save(next.jsonString(), for: issuer)
            return next
        }
        refreshTask = task
        try await finishRefreshing()
        return try await task.value.accessToken
    }
    func models() async throws -> [String] {
        var request = URLRequest(url: URL(string: resource + "/models")!); request.setValue("Bearer " + (try await Self.accessToken()), forHTTPHeaderField: "Authorization")
        let (data, response) = try await Network.read(request, limit: 1_000_000)
        guard response.statusCode == 200 else { throw AppError(L("Could not load ChatGPT models.")) }
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any], let entries = payload["models"] as? [[String: Any]], entries.count <= 1000 else { throw AppError(L("The service returned an invalid response.")) }
        var ids: [String] = []; var metadata: [String: String] = [:]
        for entry in entries where entry["visibility"] as? String == "list" {
            guard let id = entry["slug"] as? String, !id.isEmpty, id.count <= 200 else { continue }
            ids.append(id); metadata[id] = String(decoding: try JSONSerialization.data(withJSONObject: entry), as: UTF8.self)
        }
        try Task.checkCancellation()
        modelMetadata = metadata
        return ids
    }
    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw AppError("Secure random generation failed.") }
        return Data(bytes).base64URL
    }
    static func identity(_ token: String, clientID: String, nonce: String?) async throws -> (subject: String, email: String) {
        let keys = try await Network.get(URL(string: issuer + "/.well-known/jwks.json")!, limit: 1_000_000)
        return try verifyIdentity(token, clientID: clientID, nonce: nonce, jwks: keys)
    }
    static func verifyIdentity(_ token: String, clientID: String, nonce: String?, jwks: Data, now: Double = Date().timeIntervalSince1970) throws -> (subject: String, email: String) {
        let parts = token.split(separator: ".").map(String.init)
        guard token.count <= 32_000, parts.count == 3, let headerData = Data(base64URL: parts[0]), let claimsData = Data(base64URL: parts[1]), let signature = Data(base64URL: parts[2]),
              let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any], let claims = try JSONSerialization.jsonObject(with: claimsData) as? [String: Any],
              let keyset = try JSONSerialization.jsonObject(with: jwks) as? [String: Any], let keys = keyset["keys"] as? [[String: Any]],
              let kid = header["kid"] as? String, let alg = header["alg"] as? String, ["RS256", "ES256"].contains(alg),
              let key = keys.first(where: { $0["kid"] as? String == kid }), key["use"] == nil || key["use"] as? String == "sig", key["alg"] == nil || key["alg"] as? String == alg else { throw AppError("Invalid identity signature metadata.") }
        let message = Data((parts[0] + "." + parts[1]).utf8)
        let valid: Bool
        if alg == "ES256", key["kty"] as? String == "EC", key["crv"] as? String == "P-256", let x = key["x"] as? String, let y = key["y"] as? String, let xd = Data(base64URL: x), let yd = Data(base64URL: y) {
            let publicKey = try P256.Signing.PublicKey(x963Representation: Data([4]) + xd + yd)
            valid = publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signature), for: message)
        } else if alg == "RS256", key["kty"] as? String == "RSA", let n = key["n"] as? String, let e = key["e"] as? String, let modulus = Data(base64URL: n), let exponent = Data(base64URL: e) {
            func der(_ tag: UInt8, _ bytes: Data) -> Data {
                let count = bytes.count
                let length: [UInt8] = count < 128 ? [UInt8(count)] : count < 256 ? [0x81, UInt8(count)] : [0x82, UInt8(count >> 8), UInt8(count & 255)]
                return Data([tag] + length) + bytes
            }
            func integer(_ data: Data) -> Data { der(2, data.first.map { $0 >= 128 } == true ? Data([0]) + data : data) }
            let encoded = der(0x30, integer(modulus) + integer(exponent))
            guard let publicKey = SecKeyCreateWithData(encoded as CFData, [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary, nil) else { throw AppError("Invalid identity key.") }
            valid = SecKeyVerifySignature(publicKey, .rsaSignatureMessagePKCS1v15SHA256, message as CFData, signature as CFData, nil)
        } else { throw AppError("Identity key algorithm mismatch.") }
        let audience = (claims["aud"] as? [String]) ?? (claims["aud"] as? String).map { [$0] } ?? []
        guard valid, claims["iss"] as? String == issuer, audience.contains(clientID), audience.count <= 1 || claims["azp"] as? String == clientID,
              let exp = claims["exp"] as? Double, exp > now - 30, let issued = claims["iat"] as? Double, issued <= now + 30,
              (claims["nbf"] as? Double ?? 0) <= now + 30, let subject = claims["sub"] as? String, !subject.isEmpty,
              nonce == nil || claims["nonce"] as? String == nonce else { throw AppError("Identity claims did not match this sign-in.") }
        return (subject, claims["email"] as? String ?? "")
    }
    /// Accept only a successful terminal event; deltas alone are never evidence.
    static func completedResponse(_ data: Data) throws -> Data {
        let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
        var items: [[String: Any]] = []
        for event in text.components(separatedBy: "\n\n") {
            let value = event.split(separator: "\n").filter { $0.hasPrefix("data:") }.map { String($0.dropFirst(5)).trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
            if value.isEmpty || value == "[DONE]" { continue }
            guard let json = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { continue }
            let type = json["type"] as? String ?? ""
            if ["error", "response.failed", "response.incomplete"].contains(type) || json["error"] != nil { throw AppError(L("ChatGPT did not complete this check.")) }
            if type == "response.output_item.done", let item = json["item"] as? [String: Any] { items.append(item) }
            if type == "response.completed", var response = json["response"] as? [String: Any], response["status"] as? String == "completed" {
                let final = response["output"] as? [[String: Any]] ?? []
                let finalIDs = Set(final.compactMap { $0["id"] as? String })
                response["output"] = final + items.filter { item in (item["id"] as? String).map { !finalIDs.contains($0) } ?? final.isEmpty }
                return try JSONSerialization.data(withJSONObject: response)
            }
        }
        throw AppError(L("ChatGPT did not complete this check."))
    }
}
extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL: String) { let base = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"); self.init(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4)) }
}
