import Foundation
import Observation

struct CommunityProduct: Codable { var productName: String; var brand: String; var barcode: String; var variant: String }
struct CommunityCoverage: Codable {
    struct Range: Codable { var name: String; var wholeBrand: Bool; var brandAliases: [String]; var namePrefixes: [String] }
    var type: String; var markets: [String]; var products: [CommunityProduct]; var range: Range?
}
struct CommunityReply: Codable, Identifiable {
    var id: String; var productName: String; var brand: String; var barcode: String; var market: String; var variant: String
    var question: String; var reply: String; var repliedOn: String; var claim: String; var scope: String; var sourceUrl: String
    var reviewedAt: String; var evidencePublic: Bool; var match: String?; var coverage: CommunityCoverage?
}
struct CommunityReplyPage: Codable { var replies: [CommunityReply]; var candidates: [CommunityReply]; var more: Bool }
struct CommunityRequestKey: Equatable { var id: String; var identity: Identity; var offline: Bool; var refresh: Int; var locale: String }

@MainActor @Observable final class CommunityRepliesState {
    var page: CommunityReplyPage?
    var links: CommunityLinks?
    var loading = false
    var failure: String?
    var confirmed: Set<String> = []
    private var retrievedAt = ISO8601DateFormatter().string(from: Date())
    private var identity: Identity?
    private var requestID = UUID()

    func displayResult(_ original: CheckResult, engine: CoreEngine, locale: String, hidden: Set<String>) -> CheckResult {
        guard identity == original.identity, let page else { return original }
        struct Arguments: Encodable { var result: CheckResult; var page: CommunityReplyPage; var locale: String; var hidden: Set<String>; var confirmed: Set<String>; var retrievedAt: String }
        return (try? engine.call("communityVerdict", Arguments(result: original, page: page, locale: locale, hidden: hidden, confirmed: confirmed, retrievedAt: retrievedAt))) ?? original
    }

    func displayResult(_ saved: SavedCheck, engine: CoreEngine, locale: String, hidden: Set<String>) -> CheckResult {
        let blocked = saved.communityOriginal != nil && saved.result.evidence.contains { evidence in
            evidence.id.hasPrefix("community-") && hidden.contains(String(evidence.id.dropFirst("community-".count)))
        }
        let cached = blocked ? saved.originalAnalysis : saved.result
        guard identity == saved.result.identity, let page, !page.more else { return cached }
        return displayResult(saved.originalAnalysis, engine: engine, locale: locale, hidden: hidden)
    }

    func load(_ original: CheckResult, engine: CoreEngine, locale: String, offline: Bool) async {
        let request = UUID(); requestID = request
        identity = original.identity; page = nil; confirmed = []; failure = nil; loading = false
        struct Arguments: Encodable { var result: CheckResult; var locale: String }
        links = try? engine.call("community", Arguments(result: original, locale: locale))
        guard !offline, let links, var url = URLComponents(string: links.replies) else { return }
        loading = true
        defer { if requestID == request { loading = false } }
        do {
            let query: String = try engine.call("communityLookup", original.identity)
            url.path = "/api/replies"; url.fragment = nil; url.percentEncodedQuery = query
            guard let target = url.url else { throw AppError(L("A product name and brand, or a barcode, are needed.")) }
            let data = try await Network.get(target, limit: 4_000_000)
            try Task.checkCancellation()
            guard requestID == request else { return }
            let loaded: CommunityReplyPage = try engine.call("communityReplies", String(decoding: data, as: UTF8.self))
            retrievedAt = ISO8601DateFormatter().string(from: Date())
            page = loaded
        } catch { if !Task.isCancelled, requestID == request { failure = error.localizedDescription } }
    }
}
