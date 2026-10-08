import SwiftUI
import Vision
import UniformTypeIdentifiers

struct SettingsView: View {
    @Bindable var store: AppStore
    @State private var token = ""
    @State private var models: [String] = []
    @State private var loadingModels = false
    @State private var modelTask: Task<Void, Never>?
    @State private var connectionNotice: String?
    @State private var importPack = false
    @State private var languages: [String] = []
    private var chatGPT: ChatGPTConnection { store.chatGPT }
    @State private var removeAccount: ChatGPTConnection.Account?
    @State private var revealAccounts = false
    private var selectedModel: Binding<String> { Binding(get: { store.settings.connection == "chatgpt" ? store.settings.chatGPTModel : store.settings.model }, set: { if store.settings.connection == "chatgpt" { store.settings.chatGPTModel = $0 } else { store.settings.model = $0 } }) }
    var body: some View {
        Form {
            Section {
                Toggle(L("Offline mode"), isOn: $store.settings.offline).accessibilityIdentifier("offlineMode")
            } header: { Text(L("Checking")) } footer: { Text(L("Offline mode prevents product, AI, and community requests. Local rules and text recognition remain available.")) }
            Section(L("AI connection")) {
                Picker(L("Connection"), selection: $store.settings.connection) { Text(L("Vegsnap AI (free)")).tag("hosted"); Text("ChatGPT").tag("chatgpt"); Text(L("API key or local model")).tag("api") }.accessibilityIdentifier("connectionPicker")
                if store.settings.connection == "hosted" {
                    Text(L("Free checks with a daily allowance. No ChatGPT subscription or API key required.")).font(.footnote)
                    Text(L("Selected text and photos pass through Cloudflare to OpenAI. Verification uses Cloudflare Turnstile.")).font(.footnote).foregroundStyle(.secondary)
                    if let status = store.hosted.status {
                        LabeledContent(L("Status"), value: L(status.state == "connected" ? "Connected" : "Verification pending"))
                        LabeledContent(L("Remaining checks"), value: String(status.remaining))
                        Text(Date(timeIntervalSince1970: status.expiresAt / 1000), style: .relative).font(.caption)
                        if !status.enabled { Text(L("Vegsnap AI is unavailable. Try again later.")) }
                    }
                    Button(L(store.hosted.ready ? "Refresh allowance" : "Connect to free AI")) { if store.hosted.ready { store.hosted.refresh() } else { store.hosted.connect() } }.disabled(store.hosted.busy || store.settings.offline)
                    if !store.hosted.token.isEmpty {
                        Button(L("Refresh connection")) { store.hosted.refresh() }.disabled(store.hosted.busy || store.settings.offline)
                        Button(L("Disconnect"), role: .destructive) { Task { await store.disconnectHosted() } }.disabled(store.disconnectingHosted)
                    }
                    if store.hosted.busy { ProgressView() }
                    if let error = store.hosted.error { Text(error).foregroundStyle(.secondary) }
                } else if store.settings.connection == "chatgpt" {
                    Text(L("Connect a ChatGPT Plus or Pro account. Your plan’s limits apply.")).font(.footnote).foregroundStyle(.secondary)
                    if chatGPT.connected { Label(L("Connected"), systemImage: "checkmark.circle") }
                    Toggle(L("Show account emails"), isOn: $revealAccounts)
                    if revealAccounts && !chatGPT.email.isEmpty { Text(chatGPT.email).textSelection(.enabled) }
                    Button(L(chatGPT.connected ? "Reconnect ChatGPT" : "Connect ChatGPT")) { Task { await store.connectChatGPT() } }.disabled(store.switchingChatGPT || store.settings.offline)
                    ForEach(Array(chatGPT.accounts.enumerated()), id: \.element.id) { index, account in
                        HStack {
                            Button(revealAccounts && !account.email.isEmpty ? account.email : L("Saved account") + " \(index + 1)") { Task { await store.connectChatGPT(clientID: account.id) } }.disabled(store.settings.offline || store.switchingChatGPT)
                            if chatGPT.selectedAccount == account.id { Image(systemName: "checkmark").accessibilityLabel(L("Connected")) }
                            Spacer()
                            Button(L("Remove"), role: .destructive) { removeAccount = account }.disabled(store.switchingChatGPT)
                        }.buttonStyle(.borderless)
                    }
                    Button(L("Connect another account")) { Task { await store.connectChatGPT(newAccount: true) } }.disabled(store.switchingChatGPT || store.settings.offline)
                    if chatGPT.connected { Button(L("Disconnect ChatGPT"), role: .destructive) { Task { await store.changeChatGPT { try chatGPT.disconnect() } } }.disabled(store.switchingChatGPT) }
                    if store.switchingChatGPT { ProgressView(L("Connecting…")); Button(L("Cancel")) { chatGPT.cancel() } }
                } else {
                    Menu(L("Provider presets")) {
                        Button("OpenAI") { changeEndpoint("https://api.openai.com/v1") }
                        Button("OpenRouter") { changeEndpoint("https://openrouter.ai/api/v1") }
                        Button("Gemini") { changeEndpoint("https://generativelanguage.googleapis.com/v1beta/openai") }
                        Button("Ollama") { changeEndpoint("http://127.0.0.1:11434/v1") }
                    }
                    TextField(L("API endpoint"), text: $store.settings.baseUrl).textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField(L("API key (stored in Keychain)"), text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button(L("Save API key")) { do { try Keychain.save(token, for: store.settings.baseUrl); connectionNotice = L("API key saved for this endpoint.") } catch { store.report(error) } }
                }
                if store.settings.connection != "hosted" {
                TextField(L("Model ID"), text: selectedModel).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(L("Load available models")) { modelTask = Task { await loadModels() } }.disabled(loadingModels || store.settings.offline || store.switchingChatGPT)
                if loadingModels { ProgressView() }
                if !models.isEmpty { Picker(L("Available models"), selection: selectedModel) { Text(L("Choose a model")).tag(""); ForEach(models, id: \.self) { Text($0).tag($0) } } }
                }
                Toggle(L("Allow photo analysis"), isOn: $store.settings.vision)
                if let connectionNotice { Text(connectionNotice).font(.footnote).foregroundStyle(.secondary) }
            }
            Section(L("Preferences")) {
                Picker(L("Default category"), selection: $store.settings.defaultCategory) { ForEach(Category.allCases) { Text($0.label).tag($0) } }
                Picker(L("Start screen"), selection: $store.settings.startTab) { Text(L("Check")).tag("check"); Text(L("Browse")).tag("browse"); Text(L("History")).tag("history"); Text(L("Last used")).tag("last") }
                Stepper(L("Parallel checks") + ": \(store.settings.parallelChecks)", value: $store.settings.parallelChecks, in: 1...10)
                Picker(L("Appearance"), selection: $store.settings.appearance) { Text(L("System")).tag("system"); Text(L("Light")).tag("light"); Text(L("Dark")).tag("dark") }
                if let url = URL(string: UIApplication.openSettingsURLString) { Link(L("App language and permissions"), destination: url) }
            }
            Section {
                ForEach(languages, id: \.self) { code in
                    Toggle(Locale.current.localizedString(forIdentifier: code) ?? code, isOn: Binding(get: { store.settings.ocrLanguages.contains(code) }, set: { enabled in
                        if enabled { store.settings.ocrLanguages.append(code) } else if store.settings.ocrLanguages.count > 1 { store.settings.ocrLanguages.removeAll { $0 == code } }
                    }))
                }
            } header: { Text(L("On-device text recognition")) } footer: { Text(L("Apple Vision recognizes labels locally. Language availability is managed by iOS; no separate model download is needed.")) }
            Section {
                ForEach(Array(store.packs.enumerated()), id: \.offset) { index, pack in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(pack.region).font(.headline)
                        Text("\(pack.count) " + L("products") + " · " + String(pack.generatedAt.prefix(10))).font(.caption).foregroundStyle(.secondary)
                        if index > 0 { Button(L("Remove pack"), role: .destructive) { store.removePack(pack.region) } }
                        else { Text(L("Bundled snapshot")).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                Button(L("Import offline pack")) { importPack = true }
                TextField(L("Regional catalog URL"), text: $store.settings.catalogURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(L("Refresh regional catalog")) { store.refreshCatalog() }.disabled(store.settings.offline || store.packBusy)
                if store.packBusy { ProgressView(L("Loading pack…")); Button(L("Cancel")) { store.cancelPack() } }
                ForEach(store.catalog) { pack in Button { store.downloadPack(pack) } label: { VStack(alignment: .leading) { Text(pack.region); Text("\(pack.products) " + L("products") + " · " + ByteCountFormatter.string(fromByteCount: Int64(pack.bytes), countStyle: .file)).font(.caption).foregroundStyle(.secondary) } }.disabled(store.settings.offline || store.packBusy) }
            } header: { Text(L("Offline product databases")) } footer: { Text(L("Partial snapshots can be outdated. Open Facts data: ODbL-1.0; individual contents: DBCL-1.0.")) }
            Section(L("Community manufacturer replies")) {
                Button(L("Restore hidden replies")) { store.restoreReplies() }.disabled(store.hiddenReplies.isEmpty)
            }
            Section(L("About Vegsnap")) {
                Link(L("Privacy policy"), destination: URL(string: "https://vegsnap.app/privacy.html")!)
                Link(L("Website"), destination: URL(string: "https://vegsnap.app")!)
                Link(L("Source code and issues"), destination: URL(string: "https://github.com/D3SOX/vegsnap")!)
                Text("AGPL-3.0-only").foregroundStyle(.secondary)
                Text(L("No account required. No ads. No telemetry.")).font(.footnote)
            }
        }.navigationTitle(L("Settings"))
            .onChange(of: store.settings) { _, _ in store.saveSettings() }
            .confirmationDialog(L("Remove saved account?"), isPresented: Binding(get: { removeAccount != nil }, set: { if !$0 { removeAccount = nil } }), titleVisibility: .visible) {
                Button(L("Remove"), role: .destructive) { if let account = removeAccount { Task { await store.changeChatGPT { try chatGPT.removeAccount(account.id) } }; removeAccount = nil } }
            } message: { Text(L("This removes the saved sign-in from this device. The active account will be disconnected if selected.")) }
            .onChange(of: store.settings.connection) { _, _ in modelTask?.cancel(); models = []; connectionNotice = nil }
            .onChange(of: store.settings.offline) { _, offline in if offline { modelTask?.cancel() } }
            .onChange(of: store.switchingChatGPT) { _, switching in if switching { modelTask?.cancel(); models = [] } }
            .onDisappear { modelTask?.cancel() }
            .onChange(of: store.settings.baseUrl) { _, endpoint in modelTask?.cancel(); token = (try? Keychain.read(endpoint)) ?? ""; models = []; connectionNotice = nil }
            .task { token = (try? Keychain.read(store.settings.baseUrl)) ?? ""; languages = (try? VNRecognizeTextRequest().supportedRecognitionLanguages()) ?? ["en-US", "de-DE"]; chatGPT.loadStatus() }
            .fileImporter(isPresented: $importPack, allowedContentTypes: [.json]) { result in do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; try store.importPack(readLimitedFile(url, limit: 10_000_000)) } catch { store.report(error) } }
    }
    private func changeEndpoint(_ endpoint: String) { store.settings.baseUrl = endpoint; store.settings.model = "" }
    private func loadModels() async {
        loadingModels = true; defer { loadingModels = false }
        do {
            if store.settings.connection == "chatgpt" {
                let available = try await chatGPT.models()
                try Task.checkCancellation()
                models = available; store.settings.chatGPTModel = ChatGPTConnection.preferredModel(current: store.settings.chatGPTModel, available: models); return
            }
            struct Config: Encodable { var baseUrl: String; var model = "validation" }
            let _: Bool = try store.engine.call("provider", Config(baseUrl: store.settings.baseUrl))
            guard let url = URL(string: store.settings.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/models") else { throw AppError(L("Could not load models. Check the saved key and endpoint.")) }
            var request = URLRequest(url: url)
            let saved = try Keychain.read(store.settings.baseUrl)
            if !saved.isEmpty { request.setValue("Bearer " + saved, forHTTPHeaderField: "Authorization") }
            let (data, response) = try await Network.read(request, limit: 1_000_000)
            guard response.statusCode == 200 else { throw AppError(L("Could not load models. Check the saved key and endpoint.")) }
            struct Model: Decodable { var id: String }; struct List: Decodable { var data: [Model] }
            try Task.checkCancellation()
            models = try JSONDecoder().decode(List.self, from: data).data.map(\.id).filter { $0.count <= 200 }.sorted()
        } catch { store.report(error) }
    }
}
