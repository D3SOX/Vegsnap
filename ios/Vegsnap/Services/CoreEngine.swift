import Foundation
import JavaScriptCore

/// Confined to the main actor: JavaScriptCore objects never cross queues.
@MainActor final class CoreEngine {
    static func packagingLanguage(_ value: String) -> String {
        let normalized = value.folding(options: [.caseInsensitive, .widthInsensitive], locale: Locale(identifier: "en")).trimmingCharacters(in: .whitespacesAndNewlines)
        return Locale.LanguageCode.isoLanguageCodes.first { code in
            let identifier = code.identifier
            return [identifier, code.identifier(.alpha3), Locale(identifier: "en").localizedString(forLanguageCode: identifier),
                    Locale(identifier: identifier).localizedString(forLanguageCode: identifier)]
                .compactMap { $0 }.contains { $0.lowercased() == normalized }
        }?.identifier ?? "en"
    }
    private let context: JSContext
    private var requests: [String: Task<Void, Never>] = [:]
    private var pending: [String: CheckedContinuation<CheckResult, Error>] = [:]
    private var alternativePending: [String: CheckedContinuation<[VeganAlternative], Error>] = [:]
    var progress: ((String, String) -> Void)?
    private var exception: String?
    init(bundle: Bundle = .main) throws {
        guard let context = JSContext() else { throw AppError("Unable to initialize the evaluation engine.") }
        self.context = context
        context.exceptionHandler = { [weak self] _, value in self?.exception = value?.toString() }
        let uuid: @convention(block) () -> String = { UUID().uuidString }
        let byteCount: @convention(block) (String) -> Int = { $0.utf8.count }
        let url: @convention(block) (String, String) -> String = { value, base in
            guard let url = URL(string: value, relativeTo: base.isEmpty ? nil : URL(string: base))?.absoluteURL,
                  let c = URLComponents(url: url, resolvingAgainstBaseURL: true), let scheme = c.scheme, let host = c.host else { return "null" }
            let hostname = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
            let port = c.port.map { ":\($0)" } ?? ""
            var parts: [String: String] = [:]
            parts["href"] = url.absoluteString
            parts["origin"] = "\(scheme)://\(hostname)\(port)"
            parts["protocol"] = scheme + ":"
            parts["hostname"] = hostname
            parts["pathname"] = c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath
            parts["username"] = c.user ?? ""
            parts["password"] = c.password ?? ""
            parts["search"] = c.percentEncodedQuery.map { "?" + $0 } ?? ""
            parts["hash"] = c.percentEncodedFragment.map { "#" + $0 } ?? ""
            return (try? parts.jsonString()) ?? "null"
        }
        let timer: @convention(block) (Double, JSValue) -> Void = { milliseconds, callback in
            DispatchQueue.main.asyncAfter(deadline: .now() + milliseconds / 1000) { callback.call(withArguments: []) }
        }
        let fetch: @convention(block) (String, String, String, JSValue) -> Void = { [weak self] id, url, options, callback in
            guard let self else { return }
            self.requests[id] = Task { [weak self] in
                defer { self?.requests.removeValue(forKey: id) }
                do {
                    struct Options: Decodable { var method: String; var headers: [String: String]; var body: String?; var chatGPT: Bool? }
                    let config = try JSONDecoder().decode(Options.self, from: Data(options.utf8))
                    guard let endpoint = URL(string: url), endpoint.user == nil, endpoint.password == nil,
                          endpoint.scheme == "https" || endpoint.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(endpoint.host ?? "") else { throw AppError("Invalid service URL") }
                    var request = URLRequest(url: endpoint); request.httpMethod = config.method; request.httpBody = config.body.map { Data($0.utf8) }
                    config.headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
                    if config.chatGPT == true { request.setValue("Bearer " + (try await ChatGPTConnection.accessToken()), forHTTPHeaderField: "Authorization") }
                    let (data, response) = try await Network.read(request)
                    callback.call(withArguments: [response.statusCode, String(decoding: config.chatGPT == true && response.statusCode == 200 ? try ChatGPTConnection.completedResponse(data) : data, as: UTF8.self), ""])
                } catch { callback.call(withArguments: [0, "", L("The request failed. Check your connection and provider settings.")]) }
            }
        }
        let cancel: @convention(block) (String) -> Void = { [weak self] id in self?.requests[id]?.cancel() }
        let complete: @convention(block) (String, String, String) -> Void = { [weak self] id, value, error in
            if let continuation = self?.alternativePending.removeValue(forKey: id) {
                do {
                    guard error.isEmpty else { throw AppError(error) }
                    continuation.resume(returning: try JSONDecoder().decode([VeganAlternative].self, from: Data(value.utf8)))
                } catch { continuation.resume(throwing: error) }
                return
            }
            guard let continuation = self?.pending.removeValue(forKey: id) else { return }
            do {
                guard error.isEmpty else { throw AppError(error) }
                continuation.resume(returning: try JSONDecoder().decode(CheckResult.self, from: Data(value.utf8)))
            } catch { continuation.resume(throwing: error) }
        }
        let progress: @convention(block) (String, String) -> Void = { [weak self] id, stage in self?.progress?(id, stage) }
        let language: @convention(block) (String) -> String = { Self.packagingLanguage($0) }
        context.setObject(language, forKeyedSubscript: "nativeLanguage" as NSString)
        context.setObject(uuid, forKeyedSubscript: "nativeUUID" as NSString)
        context.setObject(byteCount, forKeyedSubscript: "nativeByteCount" as NSString)
        context.setObject(url, forKeyedSubscript: "nativeURL" as NSString)
        context.setObject(timer, forKeyedSubscript: "nativeTimer" as NSString)
        context.setObject(fetch, forKeyedSubscript: "nativeFetch" as NSString)
        context.setObject(cancel, forKeyedSubscript: "nativeCancelFetch" as NSString)
        context.setObject(complete, forKeyedSubscript: "nativeComplete" as NSString)
        context.setObject(progress, forKeyedSubscript: "nativeProgress" as NSString)
        for name in ["runtime", "core"] {
            guard let path = bundle.url(forResource: name, withExtension: "js", subdirectory: "Generated") ?? bundle.url(forResource: name, withExtension: "js") else { throw AppError("Run bun ios/prepare.ts before building.") }
            context.evaluateScript(try String(contentsOf: path, encoding: .utf8))
            if let exception { throw AppError(exception) }
        }
    }
    func call<T: Decodable, A: Encodable>(_ operation: String, _ args: A, as type: T.Type = T.self) throws -> T {
        exception = nil
        let value = context.objectForKeyedSubscript("VegsnapCore")?.invokeMethod("call", withArguments: [operation, try args.jsonString()])
        if let exception { throw AppError(exception) }
        guard let text = value?.toString() else { throw AppError("Evaluation returned no result.") }
        return try JSONDecoder().decode(T.self, from: Data(text.utf8))
    }
    func callRaw(_ operation: String, json: String) throws -> String {
        exception = nil
        let value = context.objectForKeyedSubscript("VegsnapCore")?.invokeMethod("call", withArguments: [operation, json])
        if let exception { throw AppError(exception) }
        guard let text = value?.toString() else { throw AppError("Evaluation returned no result.") }
        return text
    }
    func acceptsImages(_ model: String, metadata: String? = nil) throws -> Bool {
        let json = "{\"model\":" + (try model.jsonString()) + ",\"metadata\":" + (metadata ?? "null") + "}"
        return try callRaw("acceptsImages", json: json) == "true"
    }
    func check(id: String, input: CheckInput, settings: Settings, token: String) async throws -> CheckResult {
        struct Provider: Encodable { var baseUrl: String; var model: String; var token: String; var supportsVision: Bool }
        struct Arguments: Encodable { var input: CheckInput; var provider: Provider?; var offline: Bool; var aiEnabled: Bool; var chatGPT: Bool; var hostedToken: String? }
        let provider = settings.connection != "hosted" && settings.aiEnabled && !settings.offline && !settings.model.isEmpty ? Provider(baseUrl: settings.baseUrl, model: settings.model, token: token, supportsVision: settings.vision) : nil
        let json = try Arguments(input: input, provider: provider, offline: settings.offline, aiEnabled: settings.aiEnabled, chatGPT: settings.connection == "chatgpt", hostedToken: settings.connection == "hosted" && settings.aiEnabled && !settings.offline ? token : nil).jsonString()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                exception = nil
                context.objectForKeyedSubscript("VegsnapCore")?.invokeMethod("check", withArguments: [id, json])
                if let exception, let waiting = pending.removeValue(forKey: id) { waiting.resume(throwing: AppError(exception)) }
            }
        } onCancel: { Task { @MainActor in self.cancel(id) } }
    }
    func cancel(_ id: String) {
        context.objectForKeyedSubscript("VegsnapCore")?.invokeMethod("cancel", withArguments: [id])
        pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
        alternativePending.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
    func researchAlternatives(_ input: AlternativeQuery, settings: Settings, token: String) async throws -> [VeganAlternative] {
        struct Provider: Encodable { var baseUrl: String; var model: String; var token: String }
        struct Arguments: Encodable { var input: AlternativeQuery; var provider: Provider?; var hostedToken: String?; var chatGPT: Bool }
        let provider = settings.connection != "hosted" ? Provider(baseUrl: settings.baseUrl, model: settings.model, token: token) : nil
        let json = try Arguments(input: input, provider: provider, hostedToken: settings.connection == "hosted" ? token : nil, chatGPT: settings.connection == "chatgpt").jsonString()
        let id = UUID().uuidString
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                alternativePending[id] = continuation; exception = nil
                context.objectForKeyedSubscript("VegsnapCore")?.invokeMethod("alternatives", withArguments: [id, json])
                if let exception, let waiting = alternativePending.removeValue(forKey: id) { waiting.resume(throwing: AppError(exception)) }
            }
        } onCancel: { Task { @MainActor in self.cancel(id) } }
    }
    func alternativeQuery(_ result: CheckResult) -> String {
        struct Arguments: Encodable { var name: String; var brand: String; var animalTerms: [String] }
        return (try? call("alternativeQuery", Arguments(name: result.identity.name ?? "", brand: result.identity.brand ?? "", animalTerms: result.findings.filter { $0.status == "animal" }.map(\.term)), as: String.self)) ?? result.identity.name ?? ""
    }
}
