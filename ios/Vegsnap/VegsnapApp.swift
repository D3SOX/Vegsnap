import SwiftUI

@main struct VegsnapApp: App {
    @State private var store: AppStore?
    @State private var startupError: String?
    var body: some Scene {
        WindowGroup {
            Group {
                if let store { RootView(store: store) }
                else if let startupError { ContentUnavailableView(L("Could not open Vegsnap"), systemImage: "exclamationmark.triangle", description: Text(startupError)) }
                else { ProgressView().task {
                    do {
                        #if DEBUG
                        let testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
                        let root = testing ? FileManager.default.temporaryDirectory.appendingPathComponent("VegsnapUITests") : nil
                        if testing && ProcessInfo.processInfo.arguments.contains("--reset") { if let root { try? FileManager.default.removeItem(at: root) }; UserDefaults.standard.set(false, forKey: "onboarded") }
                        store = try AppStore(root: root)
                        if testing { store?.settings.offline = true }
                        #else
                        store = try AppStore()
                        #endif
                    } catch { startupError = error.localizedDescription }
                } }
            }
        }
    }
}
struct RootView: View {
    @Bindable var store: AppStore
    @Environment(\.scenePhase) private var phase
    @AppStorage("onboarded") private var onboarded = false
    var body: some View {
        TabView(selection: $store.selectedTab) {
            NavigationStack { CheckView(store: store) }.tabItem { Label(L("Check"), systemImage: "viewfinder") }.tag("check")
            NavigationStack { BrowseView(store: store) }.tabItem { Label(L("Browse"), systemImage: "magnifyingglass") }.tag("browse")
            NavigationStack { HistoryView(store: store) }.tabItem { Label(L("History"), systemImage: "clock") }.tag("history")
            NavigationStack { SettingsView(store: store) }.tabItem { Label(L("Settings"), systemImage: "gearshape") }.tag("settings")
        }
        .tint(Color("AccentColor"))
        .preferredColorScheme(store.settings.appearance == "dark" ? .dark : store.settings.appearance == "light" ? .light : nil)
        .sheet(item: $store.selectedResult) { saved in NavigationStack { ResultView(store: store, saved: saved).toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { store.selectedResult = nil } } } } }
        .sheet(isPresented: Binding(get: { !onboarded }, set: { onboarded = !$0 })) { OnboardingView(store: store) { onboarded = true }.interactiveDismissDisabled() }
        .alert(L("Something needs attention"), isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) { Button(L("OK")) { store.error = nil } } message: { Text(store.error ?? "") }
        .onChange(of: store.selectedTab) { _, value in store.settings.lastTab = value; store.saveSettings() }
        .onChange(of: phase) { _, phase in
            store.saveDraft()
            if phase == .background { store.enterBackground() }
            if phase == .active { store.consumeInbox(); if !store.settings.offline { store.hosted.refresh() } }
        }
        .onOpenURL { url in
            if url.absoluteString == "vegsnap-ios://ai/complete", !store.settings.offline { store.hosted.refresh() }
            if url.isFileURL {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                do { try store.importHistory(readLimitedFile(url, limit: HistoryTransfer.byteLimit)); store.selectedTab = "history" } catch { store.report(error) }
            }
        }
        .task { store.consumeInbox(); if !store.settings.offline { store.hosted.refresh() } }
        .onChange(of: store.settings.offline) { _, offline in if offline { store.stopNetworkWork() } else { store.hosted.refresh() } }
        .onChange(of: store.settings.connection) { _, connection in store.hosted.cancel(); if connection == "hosted" && !store.settings.offline { store.hosted.refresh() } }
    }
}
struct OnboardingView: View {
    @Bindable var store: AppStore
    @State private var connectionSettings = false
    var done: () -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    Image(systemName: "leaf.circle.fill").font(.system(size: 72)).foregroundStyle(.green).accessibilityHidden(true)
                    Text(L("A closer look at what’s inside.")).font(.largeTitle.bold())
                    Text(L("Check ingredients, materials, and product evidence with Vegsnap.")).font(.title3).foregroundStyle(.secondary)
                    Label(L("Photograph a label, scan a barcode, or paste ingredients."), systemImage: "camera")
                    Label(L("Local rules and offline text recognition work without an account."), systemImage: "iphone")
                    Label(L("History stays on this device. No ads or telemetry."), systemImage: "lock.shield")
                    Text(L("Optional AI sends selected text and photos to your chosen provider when you start a check. Results explain uncertainty and are not certification or allergy advice.")).font(.footnote).foregroundStyle(.secondary)
                    Picker(L("AI connection"), selection: $store.settings.connection) {
                        Text(L("Vegsnap AI (free)")).tag("hosted"); Text("ChatGPT").tag("chatgpt"); Text(L("API key or local model")).tag("api")
                    }
                    Button(L("Connection settings")) { connectionSettings = true }
                    Button(action: { store.saveSettings(); done() }) { Text(L("Get started")).frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.borderedProminent).accessibilityIdentifier("getStarted")
                }.padding(28).frame(maxWidth: 600)
            }.navigationTitle("Vegsnap").navigationBarTitleDisplayMode(.inline)
                .sheet(isPresented: $connectionSettings) { NavigationStack { SettingsView(store: store).toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { connectionSettings = false } } } } }
        }
    }
}
