import SwiftUI

struct BrowseView: View {
    var store: AppStore
    @State private var source: BrowseSource = .food
    @State private var query = ""
    @State private var records: [BrowseRecord] = []
    @State private var next: Int?
    @State private var searched = false
    @State private var busy = false
    @State private var failure: String?
    @State private var searchTask: Task<Void, Never>?
    @State private var service = BrowseService()
    var body: some View {
        List {
            Section {
                Picker(L("Source"), selection: $source) { ForEach(BrowseSource.allCases) { Text($0.name).tag($0) } }
                TextField(L("Product or company"), text: $query).submitLabel(.search).onSubmit { search() }.accessibilityIdentifier("browseQuery")
                Button { search() } label: { Label(L("Search"), systemImage: "magnifyingglass") }.disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 || busy)
            } footer: { Text(store.settings.offline ? L("Searching the partial offline snapshot. Missing records do not establish a product’s vegan status.") : L("Searches use public databases, never AI. Review the original source and market.")) }
            if busy { ProgressView(L("Searching…")); Button(L("Cancel")) { searchTask?.cancel() } }
            if let failure { Section { Text(failure).foregroundStyle(.secondary); Button(L("Retry")) { search() } } }
            if searched && records.isEmpty && !busy && failure == nil { ContentUnavailableView.search(text: query) }
            ForEach(records) { record in
                NavigationLink { BrowseDetail(store: store, record: record, source: source) } label: {
                    VStack(alignment: .leading, spacing: 5) { Text(record.name).font(.headline); if !record.brand.isEmpty { Text(record.brand).foregroundStyle(.secondary) }; if !record.labels.isEmpty { Text(record.labels).font(.caption).foregroundStyle(.secondary) } }
                }
            }
            if let next, !busy { Button(L("Load more")) { search(cursor: next) } }
            if !searched { ContentUnavailableView(L("Explore product records"), systemImage: "books.vertical", description: Text(L("Search food, cosmetics, products, beverages, and companies."))) }
        }.navigationTitle(L("Browse"))
            .onChange(of: source) { _, _ in searchTask?.cancel(); records = []; next = nil; searched = false; failure = nil }
            .onDisappear { searchTask?.cancel() }
    }
    private func search(cursor: Int = 0) {
        searchTask?.cancel(); busy = true; failure = nil; searched = true
        if cursor == 0 { records = [] }
        let submittedSource = source; let submittedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask = Task {
            defer { busy = false }
            do {
                let page: BrowsePage
                if store.settings.offline {
                    guard [.food, .beauty, .products].contains(submittedSource) else { throw AppError(L("This source requires an internet connection.")) }
                    struct Arguments: Encodable { var source: String; var query: String; var offset: Int }
                    struct Product: Decodable { var code: String; var name: String; var name_de: String?; var brands: String; var ingredients: String; var ingredients_de: String?; var snapshotDate: String }
                    let products: [Product] = try store.engine.call("offlineSearch", Arguments(source: submittedSource.rawValue, query: submittedQuery, offset: cursor))
                    page = BrowsePage(records: products.map { BrowseRecord(id: $0.code, name: store.locale == "de" ? $0.name_de ?? $0.name : $0.name, brand: $0.brands, barcode: $0.code, composition: store.locale == "de" ? $0.ingredients_de ?? $0.ingredients : $0.ingredients, url: submittedSource.origin + "/product/" + $0.code, snapshotDate: $0.snapshotDate) }, next: products.count == 20 ? cursor + 20 : nil)
                } else { page = try await service.search(submittedQuery, source: submittedSource, cursor: cursor, locale: store.locale) }
                try Task.checkCancellation()
                records += page.records.filter { new in !records.contains { $0.id == new.id } }; next = page.next
            } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
}
struct BrowseDetail: View {
    var store: AppStore; var record: BrowseRecord; var source: BrowseSource
    var body: some View {
        List {
            Section { Text(record.name).font(.title2.bold()); if !record.brand.isEmpty { Text(record.brand) }; if !record.description.isEmpty { Text(record.description) } }
            if !record.composition.isEmpty { Section(L("Ingredients or materials")) { Text(record.composition).textSelection(.enabled) } }
            if !record.labels.isEmpty { Section(L("Source claims — unverified")) { Text(record.labels) } }
            Section(L("Source")) {
                if let url = safeURL(record.url) { Link(source.name, destination: url) }
                Text(source == .wikidata ? "CC0" : source == .barnivore ? L("Barnivore terms") : "ODbL-1.0 · DBCL-1.0").font(.footnote).foregroundStyle(.secondary)
                if !record.snapshotDate.isEmpty { Text(L("Offline snapshot") + ": " + String(record.snapshotDate.prefix(10))) }
            }
            if !record.barcode.isEmpty {
                Section { Button(L("Check this product")) {
                    store.enqueue(input: CheckInput(barcode: record.barcode, name: record.name, brand: record.brand, category: source.category, complete: false, locale: store.locale), photos: [])
                    store.selectedTab = "check"
                } }
            }
        }.navigationTitle(L("Product record")).navigationBarTitleDisplayMode(.inline)
    }
}
