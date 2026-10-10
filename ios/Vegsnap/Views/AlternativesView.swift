import SwiftUI

struct AlternativeQuery: Encodable {
    var query: String; var store: String; var category: Category; var market: String; var locale: String; var excludeBarcode: String?
}
struct VeganAlternative: Codable, Identifiable {
    var id: String; var name: String; var brand: String; var url: String; var barcode: String?
    var source: String; var evidence: String; var storeMatch: Bool; var stores: [String]; var storeUrl: String?; var marketListed: Bool
}
struct AlternativesView: View {
    var store: AppStore
    var productMarket: String?
    var excludeBarcode: String?
    @State private var query: String
    @State private var retailer = ""
    @State private var category: Category
    @State private var items: [VeganAlternative] = []
    @State private var busy = false
    @State private var aiStage = false
    @State private var searched = false
    @State private var failure: String?
    @State private var task: Task<Void, Never>?
    init(store: AppStore, initialQuery: String = "", initialCategory: Category = .food, productMarket: String? = nil, excludeBarcode: String? = nil) {
        self.store = store; self.productMarket = productMarket; self.excludeBarcode = excludeBarcode
        _query = State(initialValue: String(initialQuery.prefix(200))); _category = State(initialValue: initialCategory)
    }
    var market: String { productMarket ?? store.settings.defaultCountry }
    var body: some View {
        Form {
            Section {
                TextField(L("Product or product type"), text: $query).submitLabel(.search).onSubmit { search() }.disabled(busy)
                    .onChange(of: query) { _, value in query = String(value.prefix(200)) }.accessibilityIdentifier("alternativeQuery")
                TextField(L("Store name (optional)"), text: $retailer).disabled(busy)
                    .onChange(of: retailer) { _, value in retailer = String(value.prefix(100)) }.accessibilityIdentifier("alternativeStore")
                Picker(L("Category"), selection: $category) { ForEach(Category.allCases) { Text($0.label).tag($0) } }.disabled(busy)
                LabeledContent(L("Product country"), value: market)
                Button(L("Find alternatives")) { search() }.disabled(busy || store.settings.offline || query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                    .accessibilityIdentifier("findAlternatives")
            } footer: { Text(L("Search a product type, e.g. chocolate or yogurt. Add a store to prioritize products listed there.")) }
            if store.settings.offline { Text(L("Alternative search needs an internet connection. Turn off offline mode to search.")) }
            if busy { Section { ProgressView(L(aiStage ? "AI is researching alternatives…" : "Searching public records…")); Button(L("Cancel")) { cancel() } } }
            if let failure { Section { Text(failure).foregroundStyle(.secondary) } }
            if searched && !busy && failure == nil && items.isEmpty { Section { Text(L("No supported alternatives found. Try a broader product type or another store.")) } }
            ForEach(items) { item in
                Section {
                    Text(item.name).font(.headline)
                    if !item.brand.isEmpty { Text(item.brand) }
                    Text(item.storeMatch ? String(format: L("Listed at %@ — likely available"), item.stores.joined(separator: ", ")) : L("Store availability unknown"))
                    Text(item.source == "AI" ? L("AI research — review the source") : item.source + " · ODbL-1.0 · " + L("Vegan according to database label")).font(.footnote).foregroundStyle(.secondary)
                    if !item.marketListed { Text(L("Product country unconfirmed")).font(.footnote).foregroundStyle(.secondary) }
                    if item.source == "AI" { Text(item.evidence) }
                    if let url = safeURL(item.storeUrl ?? item.url) { Link(L("Open product source"), destination: url) }
                    if let storeUrl = item.storeUrl, storeUrl != item.url, let url = safeURL(item.url) { Link(L("Vegan evidence"), destination: url) }
                }
            }
            Section { Text(L("Community records can be outdated. Check the current package and your branch’s stock. AI research uses your connected provider and allowance; providers without web search keep public results.")).font(.footnote).foregroundStyle(.secondary) }
        }.navigationTitle(L("Vegan alternatives"))
            .onDisappear { cancel() }
            .onChange(of: store.settings.offline) { _, _ in reset() }
            .onChange(of: market) { _, _ in reset() }
            .onChange(of: store.settings.connection) { _, _ in reset() }
            .onChange(of: store.settings.model) { _, _ in reset() }
            .onChange(of: store.settings.chatGPTModel) { _, _ in reset() }
            .onChange(of: store.settings.baseUrl) { _, _ in reset() }
    }
    private func cancel() { task?.cancel(); task = nil; busy = false }
    private func reset() { cancel(); items = []; searched = false; failure = nil }
    private func search() {
        guard !busy, !store.settings.offline, query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else { return }
        cancel(); busy = true; searched = true; failure = nil; items = []; aiStage = false
        let input = AlternativeQuery(query: query.trimmingCharacters(in: .whitespacesAndNewlines), store: retailer.trimmingCharacters(in: .whitespacesAndNewlines), category: category, market: market, locale: store.locale, excludeBarcode: excludeBarcode)
        task = Task { @MainActor in
            var publicItems: [VeganAlternative] = []
            do {
                do {
                    struct Arguments: Encodable { var input: AlternativeQuery; var storeOnly: Bool }
                    for storeOnly in input.store.isEmpty ? [false] : [true, false] {
                        do {
                            let urlString: String = try store.engine.call("alternativeUrl", Arguments(input: input, storeOnly: storeOnly))
                            guard let url = URL(string: urlString) else { throw AppError(L("Invalid service URL")) }
                            let data = try await BrowseService.shared.alternativeDocument(url)
                            try Task.checkCancellation()
                            let json = "{\"input\":" + (try input.jsonString()) + ",\"document\":" + String(decoding: data, as: UTF8.self) + "}"
                            let parsed = try store.engine.callRaw("publicAlternatives", json: json)
                            publicItems += try JSONDecoder().decode([VeganAlternative].self, from: Data(parsed.utf8))
                        } catch is CancellationError { throw CancellationError() }
                        catch { if !storeOnly && publicItems.isEmpty { throw error } }
                    }
                    items = try ranked(publicItems, input)
                } catch is CancellationError { throw CancellationError() }
                catch { failure = L("Product search failed. Check your connection and try again.") }
                if store.connectionReady(store.settings) {
                    aiStage = true
                    do {
                        var config = store.settings
                        let token: String
                        if config.connection == "chatgpt" { config.baseUrl = "https://api.openai.com/v1"; config.model = config.chatGPTModel; token = "" }
                        else if config.connection == "hosted" { token = store.hosted.token }
                        else { token = try Keychain.read(config.baseUrl) }
                        let researched = try await store.engine.researchAlternatives(input, settings: config, token: token)
                        try Task.checkCancellation()
                        items = try ranked(publicItems + researched, input)
                    } catch is CancellationError { throw CancellationError() }
                    catch { failure = L("AI research unavailable. Public matches have been kept.") }
                }
                try Task.checkCancellation(); busy = false
            } catch { /* Cancelled views must not publish stale results. */ }
        }
    }
    private func ranked(_ values: [VeganAlternative], _ input: AlternativeQuery) throws -> [VeganAlternative] {
        struct Arguments: Encodable { var items: [VeganAlternative]; var input: AlternativeQuery }
        return try store.engine.call("rankAlternatives", Arguments(items: values, input: input))
    }
}
