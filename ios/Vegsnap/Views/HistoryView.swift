import SwiftUI
import UniformTypeIdentifiers

struct JSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
struct HistoryView: View {
    @Bindable var store: AppStore
    @State private var query = ""
    @State private var filter: Outcome?
    @State private var importing = false
    @State private var exporting = false
    @State private var document = JSONDocument(data: Data())
    @State private var clear = false
    var filtered: [SavedCheck] { store.history.filter { (filter == nil || $0.result.outcome == filter) && (query.isEmpty || ($0.result.title + " " + ($0.result.identity.brand ?? "") + " " + ($0.result.identity.barcode ?? "")).localizedCaseInsensitiveContains(query)) } }
    var body: some View {
        List {
            if !store.jobs.isEmpty { Section(L("Queue")) { ForEach(store.jobs) { JobRow(store: store, job: $0) } } }
            Section {
                ForEach(filtered) { saved in
                    Button { store.selectedResult = saved } label: {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: saved.result.outcome.icon).foregroundStyle(saved.result.outcome.color).font(.title2).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(saved.result.title).font(.headline).foregroundStyle(.primary)
                                Text(saved.result.outcome.label).foregroundStyle(.secondary)
                                if let date = HistoryTransfer.parseDate(saved.result.checkedAt) { Text(date, style: .date).font(.caption).foregroundStyle(.secondary) }
                            }
                        }.padding(.vertical, 5)
                    }.buttonStyle(.plain).swipeActions { Button(L("Delete"), role: .destructive) { store.delete([saved.id]) } }
                }.onDelete { offsets in store.delete(Set(offsets.map { filtered[$0].id })) }
            }
            if filtered.isEmpty { ContentUnavailableView(query.isEmpty ? L("Your checks live here") : L("No matching checks"), systemImage: "clock", description: Text(L("Saved on this device. Search, revisit, or export your results."))) }
        }
        .navigationTitle(L("History")).searchable(text: $query, prompt: L("Search checks"))
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { EditButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker(L("Result"), selection: $filter) { Text(L("All results")).tag(Outcome?.none); ForEach(Outcome.allCases, id: \.self) { Text($0.label).tag(Optional($0)) } }
                    Button(L("Import history"), systemImage: "square.and.arrow.down") { importing = true }
                    Button(L("Export history"), systemImage: "square.and.arrow.up") { do { document = JSONDocument(data: try store.exportHistory()); exporting = true } catch { store.report(error) } }
                    Button(L("Delete all history"), systemImage: "trash", role: .destructive) { clear = true }.disabled(store.history.isEmpty)
                } label: { Image(systemName: "ellipsis.circle").accessibilityLabel(L("History actions")) }
            }
        }
        .confirmationDialog(L("Delete all history?"), isPresented: $clear, titleVisibility: .visible) { Button(L("Delete all history"), role: .destructive) { store.delete(Set(store.history.map(\.id))) } } message: { Text(L("This removes saved results and their photos from this device.")) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; try store.importHistory(readLimitedFile(url, limit: 5_000_000)) } catch { store.report(error) }
        }
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "vegsnap-history") { if case .failure(let error) = $0 { store.report(error) } }
    }
}
