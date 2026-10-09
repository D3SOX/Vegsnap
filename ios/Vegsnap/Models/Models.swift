import Foundation
import SwiftUI

enum Category: String, Codable, CaseIterable, Identifiable {
    case other, food, drink, cosmetics, household, clothing, shoes
    var id: String { rawValue }
    var label: String { L(rawValue.capitalized) }
}
enum Outcome: String, Codable, CaseIterable {
    case vegan, notVegan = "not_vegan", uncertain, conflicting
    var label: String { L([.vegan: "Appears vegan", .notVegan: "Not vegan", .uncertain: "Uncertain", .conflicting: "Conflicting evidence"][self]!) }
    var icon: String { [.vegan: "leaf.fill", .notVegan: "xmark.circle.fill", .uncertain: "questionmark.circle.fill", .conflicting: "exclamationmark.triangle.fill"][self]! }
    var color: Color { [.vegan: Color("AccentColor"), .notVegan: .red, .uncertain: Color("WarningColor"), .conflicting: .purple][self]! }
}
struct CheckInput: Codable, Equatable {
    var text = ""
    var barcode = ""
    var name = ""
    var brand = ""
    var category: Category = .other
    var complete: Bool? = nil
    var market = "DE"
    var locale = "en"
    var sourceUrl: String? = nil
    var images: [String]? = nil
    var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !barcode.isEmpty || !name.isEmpty || !(images ?? []).isEmpty }
}
struct Identity: Codable {
    var name: String?; var brand: String?; var barcode: String?; var market: String; var match: String
}
struct Finding: Codable { var term: String; var displayTerm: String?; var displayLocale: String?; var status: String; var ruleId: String?; var explanation: String; var evidenceId: String }
struct Evidence: Codable, Identifiable { var id: String; var kind: String; var title: String; var excerpt: String; var url: String?; var retrievedAt: String; var sourceDate: String?; var license: String?; var claim: String?; var verification: String? }
struct CompanyConcern: Codable { var company: String; var category: String; var description: String; var sourceUrl: String; var reviewedAt: String; var status: String; var scope: String?; var matchedBrand: String?; var ownershipSourceUrl: String?; var ownershipReviewedAt: String? }
struct CompanyAssessment: Codable {
    struct Source: Codable { var url: String; var title: String; var quote: String }
    var brand: String; var company: String; var scope: String; var verdict: String; var summary: String; var categories: [String]; var sources: [Source]; var ownershipSourceUrl: String?; var assessedAt: String
}
struct ManufacturerContact: Codable { var email: String?; var url: String?; var sourceUrl: String; var productName: String; var brand: String }
struct AIError: Codable { var code: String; var message: String }
struct CheckResult: Codable, Identifiable {
    var schemaVersion: Int
    var id: String
    var outcome: Outcome
    var basis: String
    var title: String
    var summary: String
    var category: Category
    var identity: Identity
    var findings: [Finding]
    var evidence: [Evidence]
    var questions: [String]
    var warnings: [String]
    var crossContact: [String]
    var companyConcerns: [CompanyConcern]
    var checkedAt: String
    var usedAI: Bool
    var aiStatus: String?
    var aiError: AIError?
    var webSearchStatus: String?
    var manufacturerContact: ManufacturerContact?
    var companyAssessment: CompanyAssessment?
    var retryInput: CheckInput {
        CheckInput(text: evidence.filter { ["user_text", "ocr"].contains($0.kind) }.map(\.excerpt).joined(separator: "\n"), barcode: identity.barcode ?? "", name: identity.name ?? "", brand: identity.brand ?? "", category: category, complete: false, market: identity.market, locale: language)
    }
}
struct Settings: Codable, Equatable {
    var offline = false
    var aiEnabled = true
    var vision = true
    var baseUrl = "https://api.openai.com/v1"
    var model = ""
    var chatGPTModel = ""
    var connection = "hosted"
    var defaultCategory: Category = .other
    var parallelChecks = 3
    var startTab = "check"
    var lastTab = "check"
    var appearance = "system"
    var language = "system"
    var ocrLanguages = ["en-US", "de-DE"]
    var catalogURL = "https://github.com/D3SOX/vegsnap/releases/download/offline-data/catalog.json"
}
struct HistoryDocument: Codable { var schemaVersion = 1; var exportedAt = ISO8601DateFormatter().string(from: Date()); var results: [CheckResult] }
struct SavedCheck: Codable, Identifiable { var id: String; var result: CheckResult; var input: CheckInput?; var photos: [String] }
struct CheckJob: Codable, Identifiable {
    var id = UUID().uuidString
    var input: CheckInput
    var photos: [String]
    var settings = Settings()
    var accountID: String? = nil
    var status = "queued"
    var error: String? = nil
}
struct PackInfo: Codable, Identifiable { var region: String; var generatedAt: String; var count: Int; var id: String { region } }
struct PackDescriptor: Codable, Identifiable { var id: String; var region: String; var url: String; var bytes: Int; var sha256: String; var generatedAt: String; var products: Int }
struct PackCatalog: Codable { var schemaVersion: Int; var packs: [PackDescriptor] }
struct ManufacturerMessage: Codable { var subject: String; var body: String; var mailto: String? }
struct CommunityLinks: Codable {
    var submit: String; var replies: String
    func evidenceURL(for id: String) -> URL? {
        guard UUID(uuidString: id) != nil, let base = safeURL(replies), var url = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        url.path = "/api/evidence/" + id; url.query = nil; url.fragment = nil
        return url.url
    }
}

var language: String { Locale.preferredLanguages.first?.hasPrefix("de") == true ? "de" : "en" }
func L(_ key: String) -> String { NSLocalizedString(key, comment: "") }
struct AppError: LocalizedError { let message: String; init(_ message: String) { self.message = message }; var errorDescription: String? { message } }
func safeURL(_ value: String?) -> URL? {
    guard let value, let c = URLComponents(string: value), c.scheme == "https", c.host != nil, c.user == nil, c.password == nil else { return nil }
    return c.url
}
extension Encodable {
    func jsonData() throws -> Data { try JSONEncoder().encode(self) }
    func jsonString() throws -> String { String(decoding: try jsonData(), as: UTF8.self) }
}
