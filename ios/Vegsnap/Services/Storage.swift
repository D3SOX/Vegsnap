import Foundation
import Security
import CryptoKit

struct FileStore {
    #if DEBUG
    static var rejectWrite: ((URL) -> Bool)?
    #endif
    let root: URL
    init(root: URL? = nil) throws {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Vegsnap", isDirectory: true)
        try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        var url = self.root
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    func url(_ name: String) -> URL { root.appendingPathComponent(name) }
    func read<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T? {
        let path = url(name)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: path))
    }
    func save<T: Encodable>(_ value: T, _ name: String) throws { try saveData(value.jsonData(), name) }
    func saveData(_ data: Data, _ name: String) throws {
        #if DEBUG
        if Self.rejectWrite?(url(name)) == true { throw CocoaError(.fileWriteOutOfSpace) }
        #endif
        try data.write(to: url(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func remove(_ name: String) throws { if FileManager.default.fileExists(atPath: url(name).path) { try FileManager.default.removeItem(at: url(name)) } }
}
enum Keychain {
    #if DEBUG
    static var testService: String?
    #endif
    static var service: String {
        #if DEBUG
        if let testService { return testService }
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") { return "app.vegsnap.ios.ui-tests" }
        #endif
        return "app.vegsnap.ios"
    }
    static func account(_ endpoint: String) -> String { SHA256.hash(data: Data(endpoint.utf8)).map { String(format: "%02x", $0) }.joined() }
    static func read(_ endpoint: String) throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(endpoint), kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data else { throw AppError(L("Could not read credentials from Keychain.")) }
        return String(decoding: data, as: UTF8.self)
    }
    static func save(_ token: String, for endpoint: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(endpoint)]
        if token.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw AppError(L("Could not remove credentials.")) }; return
        }
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) == errSecSuccess else { throw AppError(L("Could not save credentials.")) }
        } else if status != errSecSuccess { throw AppError(L("Could not save credentials.")) }
    }
}
enum HistoryTransfer {
    static func parse(_ data: Data) throws -> [CheckResult] {
        guard data.count <= 5_000_000 else { throw AppError(L("History files must be smaller than 5 MB.")) }
        let document = try JSONDecoder().decode(HistoryDocument.self, from: data)
        guard document.schemaVersion == 1, document.results.count <= 1000 else { throw AppError(L("Unsupported history file.")) }
        return try document.results.map { result in
            guard result.schemaVersion == 1, (1...100).contains(result.id.count), result.title.count <= 500, result.summary.count <= 30_000,
                  ["certified", "manufacturer", "research", "composition", "packaging", "insufficient"].contains(result.basis),
                  parseDate(result.checkedAt) != nil,
                  result.findings.count <= 1000, result.evidence.count <= 1000, result.companyConcerns.count <= 1000,
                  [result.warnings, result.questions, result.crossContact].allSatisfy({ $0.count <= 100 && $0.allSatisfy { $0.count <= 30_000 } }),
                  result.findings.allSatisfy({ ["animal", "plant", "ambiguous", "unknown"].contains($0.status) && $0.term.count <= 300 && $0.explanation.count <= 30_000 }) else { throw AppError(L("Invalid history result.")) }
            var clean = result
            clean.aiError = nil // Never display untrusted provider error copy from a transfer.
            clean.manufacturerContact = nil // Contact must be re-established against source evidence.
            if clean.companyAssessment != nil { clean.warnings.append(L("Imported company assessment: sources and quotations have not been verified on this device.")) }
            return clean
        }
    }
    static func parseDate(_ value: String) -> Date? {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

func readLimitedFile(_ url: URL, limit: Int) throws -> Data {
    let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
    var data = Data()
    while let chunk = try file.read(upToCount: min(64 * 1024, limit + 1 - data.count)), !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= limit else { throw AppError(L("Response exceeds the size limit.")) }
    }
    return data
}
