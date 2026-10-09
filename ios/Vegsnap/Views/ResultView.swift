import SwiftUI

struct ResultView: View {
    var store: AppStore; var saved: SavedCheck
    var result: CheckResult { saved.result }
    @State private var findingFilter = "all"
    @State private var query = ""
    @State private var message: ManufacturerMessage?
    @State private var messageLanguage = language
    @State private var photo: String?
    var findings: [Finding] { result.findings.filter { (findingFilter == "all" || $0.status == findingFilter) && (query.isEmpty || ($0.term + " " + ($0.displayTerm ?? "")).localizedCaseInsensitiveContains(query)) } }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 14) {
                    Label(result.outcome.label, systemImage: result.outcome.icon).font(.title2.bold()).foregroundStyle(result.outcome.color).accessibilityIdentifier("resultOutcome")
                    Text(result.title).font(.title3.weight(.semibold))
                    Text(result.summary)
                    if let brand = result.identity.brand, !brand.isEmpty { Text(brand).foregroundStyle(.secondary) }
                    if let barcode = result.identity.barcode, !barcode.isEmpty { Label(barcode, systemImage: "barcode").font(.footnote).textSelection(.enabled) }
                }.padding(.vertical, 8)
            } footer: { Text(L("Product evidence and company concerns are assessed separately. This result is not an allergy assessment.")) }
            if !saved.photos.isEmpty {
                Section(L("Photos")) { ScrollView(.horizontal) { HStack { ForEach(saved.photos, id: \.self) { name in
                    Button { photo = name } label: { if let image = UIImage(contentsOfFile: store.files.url(name).path) { Image(uiImage: image).resizable().scaledToFill().frame(width: 100, height: 120).clipped().clipShape(RoundedRectangle(cornerRadius: 10)) } }.buttonStyle(.borderless).accessibilityLabel(L("Review photo"))
                } } } }
            }
            if !result.questions.isEmpty { Section(L("What would clarify this?")) { ForEach(result.questions, id: \.self) { Text($0) } } }
            Section(L("Ingredients and materials")) {
                if !result.findings.isEmpty {
                    Picker(L("Show"), selection: $findingFilter) { Text(L("All ingredients")).tag("all"); Text(L("Animal-derived")).tag("animal"); Text(L("Plant or mineral")).tag("plant"); Text(L("Ambiguous")).tag("ambiguous"); Text(L("Unknown")).tag("unknown") }
                    TextField(L("Find an ingredient"), text: $query)
                    ForEach(Array(findings.enumerated()), id: \.offset) { _, finding in
                        DisclosureGroup {
                            Text(finding.explanation).textSelection(.enabled)
                            if let evidence = result.evidence.first(where: { $0.id == finding.evidenceId }) { Text(evidence.title).font(.footnote).foregroundStyle(.secondary) }
                            if let display = finding.displayTerm, display != finding.term { Text(L("Original label") + ": " + finding.term).font(.footnote).foregroundStyle(.secondary) }
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 3) { Text(finding.displayTerm ?? finding.term).foregroundStyle(.primary); Text(L(["plant": "Plant or mineral", "animal": "Animal-derived", "ambiguous": "Ambiguous", "unknown": "Unknown"][finding.status] ?? "Unknown")).font(.caption).foregroundStyle(.secondary) }
                            } icon: { Image(systemName: finding.status == "animal" ? "xmark.circle" : finding.status == "plant" ? "leaf" : "questionmark.circle").foregroundStyle(finding.status == "animal" ? .red : finding.status == "plant" ? Color("AccentColor") : Color("WarningColor")) }
                        }
                    }
                } else { Text(L("No complete composition was available.")).foregroundStyle(.secondary) }
            }
            if !result.crossContact.isEmpty { Section(L("Cross-contact — separate from ingredients")) { ForEach(result.crossContact, id: \.self) { Text($0) } } }
            Section(L("Evidence and sources")) {
                ForEach(result.evidence) { evidence in
                    DisclosureGroup(evidence.title) {
                        Text(evidence.excerpt).textSelection(.enabled)
                        if let url = safeURL(evidence.url) { Link(L("Open source"), destination: url) }
                        Text(L("Retrieved") + ": " + String(evidence.retrievedAt.prefix(10))).font(.caption).foregroundStyle(.secondary)
                        if let date = evidence.sourceDate { Text(L("Source date") + ": " + String(date.prefix(10))).font(.caption).foregroundStyle(.secondary) }
                        if let license = evidence.license { Text(license).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                LabeledContent(L("Basis"), value: L(result.basis.capitalized))
                LabeledContent(L("AI"), value: L(["not_needed": "Not needed", "disabled": "Disabled", "offline": "Offline", "unconfigured": "Not configured", "vision_disabled": "Vision disabled", "failed": "Failed", "text": "Text analysis", "images": "Photo analysis"][result.aiStatus ?? ""] ?? "Not used"))
                if result.aiStatus == "failed" { Text(L("AI could not finish. The available local evidence has been kept. Check your connection, model, and allowance before retrying.")).foregroundStyle(.secondary) }
                if result.webSearchStatus == "searched" { Label(L("Web sources consulted"), systemImage: "globe") }
            }
            if !result.warnings.isEmpty { Section(L("Limits and warnings")) { ForEach(Array(result.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.footnote) } } }
            Section(L("Company concerns")) {
                if result.companyConcerns.isEmpty { Text(L("No reviewed record matched. This is not an ethical endorsement.")).foregroundStyle(.secondary) }
                ForEach(Array(result.companyConcerns.enumerated()), id: \.offset) { _, concern in
                    DisclosureGroup(concern.company) {
                        Text(concern.description)
                        LabeledContent(L("Status"), value: L(concern.status.capitalized))
                        Text(L("Reviewed") + ": " + String(concern.reviewedAt.prefix(10))).font(.caption)
                        if let url = safeURL(concern.sourceUrl) { Link(L("Source"), destination: url) }
                        if let url = safeURL(concern.ownershipSourceUrl) { Link(L("Parent-company ownership source"), destination: url) }
                    }
                }
                if let assessment = result.companyAssessment {
                    DisclosureGroup(L("AI company assessment") + " · " + assessment.company) {
                        Text(assessment.summary)
                        Text(L("AI interpretation of cited sources; separate from reviewed records and the product result.")).font(.footnote).foregroundStyle(.secondary)
                        ForEach(Array(assessment.sources.enumerated()), id: \.offset) { _, source in
                            if let url = safeURL(source.url) { Link(source.title.isEmpty ? url.host ?? L("Source") : source.title, destination: url) }
                            Text(source.quote).font(.footnote)
                        }
                    }
                }
            }
            if [.uncertain, .conflicting].contains(result.outcome) {
                Section(L("Ask the manufacturer")) {
                    Picker(L("Message language"), selection: $messageLanguage) { Text("English").tag("en"); Text("Deutsch").tag("de"); Text("Svenska").tag("sv") }
                    Button(L("Prepare a question")) {
                        struct Arguments: Encodable { var result: CheckResult; var locale: String }
                        do { message = try store.engine.call("message", Arguments(result: result, locale: messageLanguage)) } catch { store.report(error) }
                    }
                    if let contact = result.manufacturerContact, let url = safeURL(contact.sourceUrl) { Link(L("Review contact source"), destination: url) }
                    Text(L("Review the draft and recipient before sending. Nothing is sent automatically.")).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if result.usedAI || result.companyAssessment != nil {
                Section { ContentReportButton(store: store, kind: "ai", initialText: ([result.summary, result.companyAssessment?.summary ?? ""] + result.evidence.filter { ["ai_extraction", "manufacturer", "certification"].contains($0.kind) }.map(\.excerpt)).joined(separator: "\n\n")) }
            }
            CommunitySection(store: store, result: result)
            Section {
                Button(L("Check again"), systemImage: "arrow.clockwise") {
                    if store.enqueue(input: saved.input ?? result.retryInput, photos: saved.photos) {
                        store.selectedResult = nil
                        store.selectedTab = "check"
                    }
                }
                ShareLink(item: result.title + "\n" + result.outcome.label + "\n\n" + result.summary) { Label(L("Share result"), systemImage: "square.and.arrow.up") }
            }
        }.navigationTitle(L("Result")).navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) { if let message { MessageView(message: message) } }
            .sheet(isPresented: Binding(get: { photo != nil }, set: { if !$0 { photo = nil } })) { if let photo { PhotoReview(store: store, name: photo) } }
    }
}
struct MessageView: View {
    var message: ManufacturerMessage
    @State private var bodyText = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { Form { Section { Text(message.subject).font(.headline); TextEditor(text: $bodyText).frame(minHeight: 300) }; Section { ShareLink(item: message.subject + "\n\n" + bodyText) { Label(L("Share draft"), systemImage: "square.and.arrow.up") }; if let mailto = message.mailto, var components = URLComponents(string: mailto) { let _ = components.queryItems = [URLQueryItem(name: "subject", value: message.subject), URLQueryItem(name: "body", value: bodyText)]; if let url = components.url { Link(L("Open in Mail"), destination: url) } } } }.navigationTitle(L("Manufacturer question")).toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { dismiss() } } }.onAppear { bodyText = message.body } }
    }
}
struct CommunityReply: Decodable, Identifiable {
    var id: String; var productName: String; var brand: String; var market: String; var variant: String; var question: String; var reply: String; var repliedOn: String; var claim: String; var scope: String; var sourceUrl: String; var reviewedAt: String; var evidencePublic: Bool
}
struct CommunitySection: View {
    var store: AppStore; var result: CheckResult
    @State private var replies: [CommunityReply] = []
    @State private var loading = false
    @State private var loaded = false
    @State private var more = false
    @State private var failure: String?
    @State private var links: CommunityLinks?
    @State private var loadTask: Task<Void, Never>?
    var body: some View {
        Section {
            Text(L("Manufacturer replies are community evidence. Check the product, market, date, and scope; they do not change this verdict.")).font(.footnote).foregroundStyle(.secondary)
            Button { loadTask = Task { await load() } } label: { Label(L("Find manufacturer replies"), systemImage: "bubble.left.and.text.bubble.right") }.disabled(loading || store.settings.offline)
            if loading { ProgressView() }
            if loaded && replies.isEmpty { Text(L("No matching replies found.")) }
            if let failure { Text(failure).foregroundStyle(.secondary) }
            ForEach(replies.filter { !store.hiddenReplies.contains($0.id) }) { reply in DisclosureGroup(reply.productName + " · " + reply.brand) {
                if !reply.variant.isEmpty { LabeledContent(L("Variant"), value: reply.variant) }
                Text(L("Question")).font(.caption).foregroundStyle(.secondary)
                Text(reply.question).textSelection(.enabled)
                Text(L("Reply")).font(.caption).foregroundStyle(.secondary)
                Text(reply.reply).textSelection(.enabled)
                ContentReportButton(store: store, kind: "community", contentID: reply.id)
                Button(L("Hide this reply"), role: .destructive) { store.hideReply(reply.id) }
                LabeledContent(L("Market"), value: reply.market)
                LabeledContent(L("Reply date"), value: reply.repliedOn)
                LabeledContent(L("Claim"), value: L(["vegan": "Manufacturer says vegan", "not_vegan": "Manufacturer says not vegan", "inconclusive": "Inconclusive"][reply.claim] ?? "Inconclusive"))
                LabeledContent(L("Scope"), value: L(["whole_product": "Whole product", "ingredients": "Ingredients", "processing": "Processing"][reply.scope] ?? "Unknown"))
                Text(L("Reviewed") + ": " + reply.reviewedAt.prefix(10))
                if reply.evidencePublic {
                    if let url = links?.evidenceURL(for: reply.id) { Link(L("Download reviewed evidence"), destination: url).disabled(store.settings.offline) }
                } else { Text(L("Evidence reviewed privately.")).font(.footnote).foregroundStyle(.secondary) }
                if let url = safeURL(reply.sourceUrl) { Link(L("Source"), destination: url) }
            } }
            if !store.hiddenReplies.isEmpty { Text(L("Hidden replies stay hidden on this device.")).font(.footnote) }
            if more, let links, let url = safeURL(links.replies) { Link(L("View all replies"), destination: url).disabled(store.settings.offline) }
            if let links, let url = safeURL(links.submit) { Link(L("Contribute a redacted reply"), destination: url).disabled(store.settings.offline) }
        } header: { Text(L("Community manufacturer replies")) }
        .task {
            struct Arguments: Encodable { var result: CheckResult; var locale: String }
            links = try? store.engine.call("community", Arguments(result: result, locale: store.locale))
        }
        .onDisappear { loadTask?.cancel() }
        .onChange(of: store.settings.offline) { _, offline in if offline { loadTask?.cancel() } }
    }
    private func load() async {
        guard !store.settings.offline, let links, var url = URLComponents(string: links.replies) else { return }
        loading = true; failure = nil; defer { loading = false }
        url.path = "/api/replies"; url.fragment = nil
        var items = [URLQueryItem(name: "market", value: result.identity.market)]
        if let code = result.identity.barcode, !code.isEmpty { items.append(URLQueryItem(name: "barcode", value: code)) }
        else {
            guard let name = result.identity.name, !name.isEmpty, let brand = result.identity.brand, !brand.isEmpty else { failure = L("A product name and brand, or a barcode, are needed."); return }
            items += [URLQueryItem(name: "name", value: name), URLQueryItem(name: "brand", value: brand)]
        }
        url.queryItems = items
        do {
            struct Page: Decodable { var replies: [CommunityReply]; var more: Bool }
            let data = try await Network.get(url.url!, limit: 4_000_000)
            let page = try JSONDecoder().decode(Page.self, from: data)
            guard page.replies.count <= 50, page.replies.allSatisfy({ UUID(uuidString: $0.id) != nil && $0.productName.count <= 300 && $0.brand.count <= 300 && $0.reply.count <= 8000 && $0.question.count <= 4000 && ["vegan", "not_vegan", "inconclusive"].contains($0.claim) && ["whole_product", "ingredients", "processing"].contains($0.scope) && HistoryTransfer.parseDate($0.reviewedAt) != nil }) else { throw AppError(L("The service returned an invalid response.")) }
            try Task.checkCancellation()
            replies = page.replies; more = page.more; loaded = true
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
}
