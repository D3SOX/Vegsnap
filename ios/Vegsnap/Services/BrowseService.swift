import Foundation

enum BrowseSource: String, CaseIterable, Identifiable {
    case food = "off", beauty = "obf", products = "opf", barnivore, wikidata
    var id: String { rawValue }
    var name: String { [.food: "Open Food Facts", .beauty: "Open Beauty Facts", .products: "Open Products Facts", .barnivore: "Barnivore", .wikidata: "Wikidata"][self]! }
    var origin: String { [.food: "https://world.openfoodfacts.org", .beauty: "https://world.openbeautyfacts.org", .products: "https://world.openproductsfacts.org", .barnivore: "https://www.barnivore.com", .wikidata: "https://www.wikidata.org"][self]! }
    var category: Category { self == .food ? .food : self == .beauty ? .cosmetics : self == .barnivore ? .drink : .other }
}
struct BrowseRecord: Identifiable {
    var id: String; var name: String; var brand = ""; var barcode = ""; var composition = ""; var description = ""; var labels = ""; var url: String; var snapshotDate = ""
}
struct OfflineBrowseProduct: Decodable {
    var code: String; var name: String; var name_de: String?; var name_en: String?
    var brands: String; var ingredients: String; var ingredients_de: String?; var ingredients_en: String?; var snapshotDate: String
    func record(source: BrowseSource, locale: String) -> BrowseRecord {
        func localized(_ base: String, _ german: String?, _ english: String?) -> String {
            [locale == "de" ? german : english, base, german, english].compactMap { $0 }.first { !$0.isEmpty } ?? ""
        }
        return BrowseRecord(id: code, name: localized(name, name_de, name_en), brand: brands, barcode: code,
                            composition: localized(ingredients, ingredients_de, ingredients_en),
                            url: source.origin + "/product/" + code, snapshotDate: snapshotDate)
    }
}
struct BrowsePage { var records: [BrowseRecord]; var next: Int? }
actor BrowseService {
    static let shared = BrowseService()
    private var alternativeCache: [String: (Date, Data)] = [:]
    private var cache: [String: (Date, BrowsePage)] = [:]
    private var lastStarted: Date = .distantPast
    private func pacedGet(_ url: URL) async throws -> Data {
        // Recheck after suspension: only requests that actually start consume a slot.
        while true {
            try Task.checkCancellation()
            let wait = 6.1 - Date().timeIntervalSince(lastStarted)
            if wait <= 0 { break }
            try await Task.sleep(for: .seconds(wait))
        }
        lastStarted = Date()
        return try await Network.get(url)
    }
    func alternativeDocument(_ url: URL) async throws -> Data {
        if let cached = alternativeCache[url.absoluteString], Date().timeIntervalSince(cached.0) < 300 { return cached.1 }
        let data = try await pacedGet(url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["products"] is [Any], json["error"] == nil, json["errors"] == nil else { throw AppError(L("The service returned an invalid response.")) }
        alternativeCache[url.absoluteString] = (Date(), data)
        if alternativeCache.count > 20, let oldest = alternativeCache.min(by: { $0.value.0 < $1.value.0 })?.key { alternativeCache.removeValue(forKey: oldest) }
        return data
    }
    func search(_ query: String, source: BrowseSource, cursor: Int, locale: String) async throws -> BrowsePage {
        guard (2...200).contains(query.trimmingCharacters(in: .whitespacesAndNewlines).count), (0...10000).contains(cursor) else { throw AppError(L("Enter 2–200 characters to search.")) }
        var components = URLComponents(string: source.origin)!
        var parameters: [String: String]
        switch source {
        case .barnivore: components.path = "/search"; parameters = ["q": query]
        case .wikidata: components.path = "/w/api.php"; parameters = ["action": "wbsearchentities", "format": "json", "search": query, "language": locale, "uselang": locale, "type": "item", "limit": "20", "continue": String(cursor)]
        default: components.path = "/cgi/search.pl"; parameters = ["search_terms": query, "search_simple": "1", "action": "process", "json": "1", "page": String(cursor + 1), "page_size": "20", "fields": "code,product_name,product_name_\(locale),brands,ingredients_text,ingredients_text_\(locale),countries,quantity,labels,last_modified_t", "lc": locale]
        }
        components.queryItems = parameters.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        let url = components.url!
        if let cached = cache[url.absoluteString], Date().timeIntervalSince(cached.0) < 300 { return cached.1 }
        let data = try await pacedGet(url)
        let page: BrowsePage
        if source == .barnivore { page = try Self.barnivore(String(decoding: data, as: UTF8.self)) }
        else {
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["error"] == nil else { throw AppError(L("The service returned an invalid response.")) }
            if source == .wikidata {
                guard let records = json["search"] as? [[String: Any]] else { throw AppError(L("The service returned an invalid response.")) }
                page = BrowsePage(records: records.compactMap { record in
                    guard let id = record["id"] as? String, id.range(of: "^Q[0-9]+$", options: .regularExpression) != nil else { return nil }
                    return BrowseRecord(id: id, name: record["label"] as? String ?? id, description: record["description"] as? String ?? "", url: source.origin + "/wiki/" + id)
                }, next: json["search-continue"] as? Int)
            } else {
                guard let products = json["products"] as? [[String: Any]] else { throw AppError(L("The service returned an invalid response.")) }
                page = BrowsePage(records: products.prefix(20).compactMap { record in
                    guard let code = record["code"] as? String, code.range(of: "^[0-9]{4,30}$", options: .regularExpression) != nil else { return nil }
                    func text(_ keys: String...) -> String? { keys.lazy.compactMap { record[$0] as? String }.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
                    return BrowseRecord(id: code, name: text("product_name_\(locale)", "product_name") ?? code, brand: record["brands"] as? String ?? "", barcode: code, composition: text("ingredients_text_\(locale)", "ingredients_text") ?? "", description: record["countries"] as? String ?? "", labels: record["labels"] as? String ?? "", url: source.origin + "/product/" + code)
                }, next: products.count >= 20 && cursor < 99 && (json["count"] as? Int ?? Int.max) > (cursor + 1) * 20 ? cursor + 1 : nil)
            }
        }
        cache[url.absoluteString] = (Date(), page)
        if cache.count > 20, let oldest = cache.min(by: { $0.value.0 < $1.value.0 })?.key { cache.removeValue(forKey: oldest) }
        return page
    }
    static func barnivore(_ html: String) throws -> BrowsePage {
        if html.contains("Yikes, no matches found!") && html.contains("id=\"search-form\"") { return BrowsePage(records: [], next: nil) }
        guard let body = captures("<ul[^>]*id=\"results\"[^>]*>([\\s\\S]*?)</ul>", html).first?.first else { throw AppError(L("Barnivore could not be read. Try again later.")) }
        let rows = captures("<a\\s+[^>]*href=\"(/products/[0-9]+-[a-zA-Z0-9-]+)\"[^>]*>([\\s\\S]*?)</a>", body).prefix(100).compactMap { row -> BrowseRecord? in
            func span(_ name: String) -> String { plain(captures("<span[^>]*class=\"\(name)\"[^>]*>([\\s\\S]*?)</span>", row[1]).first?.first ?? "") }
            let name = span("result-name"); guard !name.isEmpty else { return nil }
            let status = row[1].contains("badge-not-vegan") ? L("Not vegan according to Barnivore") : row[1].contains("badge-vegan") ? L("Vegan according to Barnivore") : L("Check the original record")
            let metadata = span("result-meta")
            let producer = metadata.components(separatedBy: " · ").first ?? ""
            return BrowseRecord(id: row[0], name: name, brand: producer, description: metadata, labels: status, url: "https://www.barnivore.com" + row[0])
        }
        guard !rows.isEmpty || html.contains("0 products found") else { throw AppError(L("Barnivore could not be read. Try again later.")) }
        return BrowsePage(records: rows, next: nil)
    }
    static func captures(_ pattern: String, _ text: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in (1..<match.numberOfRanges).map { ns.substring(with: match.range(at: $0)) } }
    }
    static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "<[^>]*>", with: " ", options: .regularExpression).replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&nbsp;", with: " ").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
