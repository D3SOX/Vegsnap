import SwiftUI

struct ResultView: View {
    var store: AppStore; var saved: SavedCheck
    @State private var community = CommunityRepliesState()
    @State private var communityRefresh = 0
    var currentSaved: SavedCheck { store.history.first(where: { $0.id == saved.id }) ?? saved }
    var result: CheckResult { community.displayResult(currentSaved, engine: store.engine, locale: store.locale, hidden: store.hiddenReplies) }
    @State private var market = ""
    @State private var findingFilter = "all"
    @State private var query = ""
    @State private var message: ManufacturerMessage?
    @State private var messageLanguage = language
    @State private var photo: String?
    var body: some View {
        let saved = currentSaved
        let result = self.result
        let findings = result.findings.filter { (findingFilter == "all" || $0.status == findingFilter) && (query.isEmpty || ($0.term + " " + ($0.displayTerm ?? "")).localizedCaseInsensitiveContains(query)) }
        List {
            Section {
                VStack(alignment: .leading, spacing: 14) {
                    Label(result.outcomeLabel, systemImage: result.outcomeIcon).font(.title2.bold()).foregroundStyle(result.outcome.color).accessibilityIdentifier("resultOutcome")
                    Text(result.title).font(.title3.weight(.semibold))
                    Text(result.summary)
                    if let brand = result.identity.brand, !brand.isEmpty { Text(brand).foregroundStyle(.secondary) }
                    if let barcode = result.identity.barcode, !barcode.isEmpty { Label(barcode, systemImage: "barcode").font(.footnote).textSelection(.enabled) }
                }.padding(.vertical, 8)
            } footer: { Text(L("Product evidence and company concerns are assessed separately. This result is not an allergy assessment.")) }
            if result.outcome == .notVegan {
                Section { NavigationLink(L("Vegan alternatives")) { AlternativesView(store: store, initialQuery: store.engine.alternativeQuery(result), initialCategory: result.category, productMarket: result.identity.market, excludeBarcode: result.identity.barcode) } }
            }
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
            Section {
                if let source = saved.result.identity.marketSource {
                    Text(L(["packaging": "Detected from packaging (AI — check the label)", "database": "Detected from database", "manual": "Selected manually", "fallback": "Fallback country"][source] ?? "Fallback country")).font(.footnote).foregroundStyle(.secondary)
                }
                TextField(L("Product country (e.g. SE)"), text: $market).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .onChange(of: market) { _, value in market = String(value.uppercased().filter { $0.isASCII && $0.isLetter }.prefix(2)) }
                Button(L("Save country")) { do { try store.updateProductMarket(saved.id, market: market) } catch { store.report(error) } }
                    .disabled(!ProductCountry.isValid(market))
            } header: { Text(L("Product country")) } footer: { Text(L("Saving a correction refreshes community replies. Check again to refresh the original analysis.")) }
            CommunitySection(store: store, state: community, onRefresh: { communityRefresh += 1 })
            Section {
                Button(L("Check again"), systemImage: "arrow.clockwise") {
                    if store.enqueue(input: saved.input ?? result.retryInput, photos: saved.photos) {
                        store.selectedResult = nil
                        store.selectedTab = "check"
                    }
                }
                ShareLink(item: result.title + "\n" + result.outcomeLabel + "\n\n" + result.summary) { Label(L("Share result"), systemImage: "square.and.arrow.up") }
            }
        }.navigationTitle(L("Result")).navigationBarTitleDisplayMode(.inline)
            .onAppear { market = saved.result.identity.market }
            .onChange(of: saved.result.identity.market) { _, value in market = value }
            .task(id: CommunityRequestKey(id: saved.id, identity: saved.result.identity, offline: store.settings.offline, refresh: communityRefresh, locale: store.locale)) {
                await community.load(saved.result, engine: store.engine, locale: store.locale, offline: store.settings.offline)
            }
            .task(id: try? result.communityCacheKey()) {
                do { try store.cacheCommunityResult(saved, result: result) } catch { store.report(error) }
            }
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
struct CommunitySection: View {
    var store: AppStore; var state: CommunityRepliesState; var onRefresh: () -> Void
    var replies: [CommunityReply] { (state.page?.replies ?? []) + (state.page?.candidates ?? []) }
    var body: some View {
        Section {
            Text(L("Reviewed replies are fetched automatically using only the product name, brand, barcode and country. Whole-product confirmations can update this verdict; check the date and coverage.")).font(.footnote).foregroundStyle(.secondary)
            Button(action: onRefresh) { Label(L("Refresh manufacturer replies"), systemImage: "arrow.clockwise") }.disabled(state.loading || store.settings.offline)
            if state.loading { ProgressView() }
            if state.page != nil && replies.isEmpty { Text(L("No matching replies found.")) }
            if let failure = state.failure { Text(failure).foregroundStyle(.secondary) }
            ForEach(replies.filter { !store.hiddenReplies.contains($0.id) }) { reply in DisclosureGroup(reply.productName + " · " + reply.brand) {
                if reply.match == "candidate" {
                    Text(L("This range may cover your product. Confirm the variant and country before using it.")).font(.footnote).foregroundStyle(.secondary)
                    Button(L("This range covers my product")) { state.confirmed.insert(reply.id) }.disabled(state.confirmed.contains(reply.id))
                }
                if let coverage = reply.coverage {
                    if let range = coverage.range { LabeledContent(L("Product range"), value: range.name) }
                    LabeledContent(L("Covered countries"), value: coverage.markets.joined(separator: ", "))
                    ForEach(Array(coverage.products.enumerated()), id: \.offset) { _, product in Text(product.productName + " · " + product.brand + (product.variant.isEmpty ? "" : " · " + product.variant)).font(.footnote) }
                }
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
                    if let url = state.links?.evidenceURL(for: reply.id) { Link(L("Download reviewed evidence"), destination: url).disabled(store.settings.offline) }
                } else { Text(L("Evidence reviewed privately.")).font(.footnote).foregroundStyle(.secondary) }
                if let url = safeURL(reply.sourceUrl) { Link(L("Source"), destination: url).disabled(store.settings.offline) }
            } }
            if !store.hiddenReplies.isEmpty { Text(L("Hidden replies stay hidden on this device.")).font(.footnote) }
            if state.page?.more == true {
                Text(L("More replies exist. The original verdict is kept because this lookup is incomplete.")).font(.footnote).foregroundStyle(.secondary)
                if let url = safeURL(state.links?.replies) { Link(L("View all replies"), destination: url).disabled(store.settings.offline) }
            }
            if let url = safeURL(state.links?.submit) { Link(L("Contribute a redacted reply"), destination: url).disabled(store.settings.offline) }
        } header: { Text(L("Community manufacturer replies")) }
    }
}
