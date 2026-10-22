import SwiftUI

struct ContentReportButton: View {
    var store: AppStore
    var kind: String
    var contentID = ""
    var initialText = ""
    var result: CheckResult?
    @State private var open = false
    @State private var details: ResultReport?
    @State private var text = ""
    @State private var reason = ""
    @State private var receipt: String?
    @State private var failure: String?
    @State private var sending = false
    @State private var task: Task<Void, Never>?
    @Environment(\.scenePhase) private var phase
    var title: String { kind == "result" ? L("Report wrong result") : L(kind == "ai" ? "Report AI content" : "Report this reply") }
    private var draft: ContentReport { ContentReport(kind: kind, contentId: contentID, text: kind == "ai" ? text : "", reason: reason, result: details) }
    var body: some View {
        Button(title) {
            cancelReport(); text = ContentReport.excerpt(initialText); reason = ""; receipt = nil; failure = nil; details = nil
            if kind == "result", let result { do { details = try ResultReport.build(result, engine: store.engine, locale: store.locale) } catch { failure = error.localizedDescription } }
            open = true
        }.disabled(store.settings.offline)
            .sheet(isPresented: $open, onDismiss: { cancelReport() }) {
                NavigationStack {
                    Form {
                        if let receipt { Text(L("Report sent. Reference:") + " " + receipt).textSelection(.enabled) }
                        else {
                            Text(kind == "result" ? L("Only this result’s verdict, the listed ingredient terms with their status and rule IDs, the product name and brand, the app language, platform and version, and your reason are sent to Vegsnap’s moderation service on Cloudflare. Photos, saved history and credentials are never included. Reports are private and expire after 30 days.") : L(kind == "ai" ? "Review and edit the excerpt before sending. Only this text and your reason are shared; photos and credentials are never included." : "Only this reply’s reference and your reason are sent to the moderators."))
                            if kind == "ai" { Section(L("Content to report")) { TextEditor(text: $text).frame(minHeight: 140).disabled(sending).accessibilityIdentifier("reportText") } }
                            Section(kind == "result" ? L("What is wrong with this result?") : L("Reason")) { TextEditor(text: $reason).frame(minHeight: 100).disabled(sending).accessibilityIdentifier("reportReason") }
                            if store.settings.offline { Text(L("Turn off Offline mode to send a report.")) }
                            if let failure { Text(failure).foregroundStyle(.red) }
                            Button(L("Send report")) {
                                sending = true; failure = nil
                                task = Task {
                                    defer { if !Task.isCancelled { sending = false } }
                                    do {
                                        let result = try await draft.submit()
                                        try Task.checkCancellation(); receipt = result
                                    }
                                    catch {
                                        guard !Task.isCancelled, !(error is CancellationError) else { return }
                                        failure = error.localizedDescription
                                    }
                                }
                            }.disabled(sending || store.settings.offline || (try? draft.validatedData()) == nil)
                            if sending { ProgressView() }
                        }
                    }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L(receipt == nil ? "Cancel" : "Done")) { cancelReport(); open = false } } }
                }
            }
            .onChange(of: store.settings.offline) { _, offline in if offline { cancelReport() } }
            .onChange(of: phase) { _, phase in if phase == .background { cancelReport() } }
            .onDisappear { cancelReport() }
    }
    private func cancelReport() { task?.cancel(); sending = false }
}
