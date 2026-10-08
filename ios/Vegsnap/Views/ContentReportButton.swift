import SwiftUI

struct ContentReportButton: View {
    var store: AppStore
    var kind: String
    var contentID = ""
    var initialText = ""
    @State private var open = false
    @State private var text = ""
    @State private var reason = ""
    @State private var receipt: String?
    @State private var failure: String?
    @State private var sending = false
    @State private var task: Task<Void, Never>?
    @Environment(\.scenePhase) private var phase
    var title: String { L(kind == "ai" ? "Report AI content" : "Report this reply") }
    var body: some View {
        Button(title) { text = String(initialText.prefix(8000)); reason = ""; receipt = nil; failure = nil; open = true }.disabled(store.settings.offline)
            .sheet(isPresented: $open, onDismiss: { task?.cancel() }) {
                NavigationStack {
                    Form {
                        if let receipt { Text(L("Report sent. Reference:") + " " + receipt).textSelection(.enabled) }
                        else {
                            Text(L(kind == "ai" ? "Review and edit the excerpt before sending. Only this text and your reason are shared; photos and credentials are never included." : "Only this reply’s reference and your reason are sent to the moderators."))
                            if kind == "ai" { Section(L("Content to report")) { TextEditor(text: $text).frame(minHeight: 140).disabled(sending).accessibilityIdentifier("reportText") } }
                            Section(L("Reason")) { TextEditor(text: $reason).frame(minHeight: 100).disabled(sending).accessibilityIdentifier("reportReason") }
                            if store.settings.offline { Text(L("Turn off Offline mode to send a report.")) }
                            if let failure { Text(failure).foregroundStyle(.red) }
                            Button(L("Send report")) {
                                sending = true; failure = nil
                                task = Task {
                                    defer { sending = false }
                                    do { receipt = try await ContentReport(kind: kind, contentId: contentID, text: kind == "ai" ? text : "", reason: reason).submit() }
                                    catch is CancellationError {} catch { failure = error.localizedDescription }
                                }
                            }.disabled(sending || store.settings.offline || (try? ContentReport(kind: kind, contentId: contentID, text: kind == "ai" ? text : "", reason: reason).validatedData()) == nil)
                            if sending { ProgressView() }
                        }
                    }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L(receipt == nil ? "Cancel" : "Done")) { task?.cancel(); open = false } } }
                }
            }
            .onChange(of: store.settings.offline) { _, offline in if offline { task?.cancel() } }
            .onChange(of: phase) { _, phase in if phase == .background { task?.cancel() } }
            .onDisappear { task?.cancel() }
    }
}
