import Foundation
import SwiftUI
import UIKit
import CryptoKit

@MainActor @Observable final class AppStore {
    let engine: CoreEngine
    let files: FileStore
    let inboxDirectory: URL?
    struct Draft: Codable { var input: CheckInput; var photos: [String] }
    let hosted: HostedAIConnection
    let chatGPT = ChatGPTConnection()
    var switchingChatGPT = false
    var disconnectingHosted = false
    var hiddenReplies: Set<String> = []
    var settings: Settings
    var history: [SavedCheck]
    var jobs: [CheckJob]
    var draft: CheckInput
    var draftPhotos: [String]
    var selectedTab: String
    var selectedResult: SavedCheck?
    var error: String?
    var packs: [PackInfo] = []
    var catalog: [PackDescriptor] = []
    var packBusy = false
    private var tasks: [String: Task<Void, Never>] = [:]
    private var packTask: Task<Void, Never>?
    private var backgroundID: UIBackgroundTaskIdentifier = .invalid

    init(root: URL? = nil, inboxDirectory: URL? = nil) throws {
        self.inboxDirectory = inboxDirectory ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.vegsnap.ios")
        files = try FileStore(root: root)
        engine = try CoreEngine()
        hosted = try HostedAIConnection(configuration: ServiceConfiguration.load("hosted-ai"))
        let loadedSettings: Settings = try files.read("settings.json") ?? Settings()
        settings = loadedSettings
        history = try files.read("history.json") ?? []
        jobs = try files.read("queue.json") ?? []
        let saved: Draft? = try files.read("draft.json")
        draft = saved?.input ?? CheckInput(category: loadedSettings.defaultCategory, locale: language)
        draftPhotos = saved?.photos ?? []
        selectedTab = loadedSettings.startTab == "last" ? loadedSettings.lastTab : loadedSettings.startTab
        // Interrupted work requires an explicit retry, so relaunch never silently resends photos.
        for i in jobs.indices where !["failed", "cancelled"].contains(jobs[i].status) { jobs[i].status = "interrupted" }
        engine.progress = { [weak self] id, stage in self?.setStatus(id, stage) }
        hiddenReplies = try files.read("hidden-replies.json") ?? []
        chatGPT.loadStatus()
        try reloadPacks()
    }
    var locale: String { settings.language == "system" ? language : settings.language }
    func report(_ error: Error) { if !(error is CancellationError) { self.error = error.localizedDescription } }
    func saveSettings() { do { try files.save(settings, "settings.json") } catch { report(error) } }
    func saveDraft() {
        do { try files.save(Draft(input: draft, photos: draftPhotos), "draft.json") } catch { report(error) }
    }
    func addPhoto(_ data: Data) throws {
        guard draftPhotos.count < 3 else { throw AppError(L("Use at most three photos.")) }
        let clean = try PhotoProcessor.sanitize(data)
        let name = UUID().uuidString + ".jpg"
        try files.saveData(clean, name); draftPhotos.append(name); saveDraft()
    }
    func removePhoto(_ name: String) { draftPhotos.removeAll { $0 == name }; saveDraft(); cleanPhotos() }
    func clearDraft() { draft = CheckInput(category: settings.defaultCategory, locale: locale); draftPhotos = []; saveDraft(); cleanPhotos(); consumeInbox() }
    func enqueue(input supplied: CheckInput? = nil, photos suppliedPhotos: [String]? = nil) {
        do {
            guard (settings.connection != "chatgpt" || !switchingChatGPT) && (settings.connection != "hosted" || !disconnectingHosted) else { return }
            var input = supplied ?? draft; input.locale = locale
            let photos = suppliedPhotos ?? draftPhotos
            guard input.hasContent || !photos.isEmpty else { return }
            guard input.text.utf16.count <= 30_000, input.name.utf16.count <= 300, input.brand.utf16.count <= 300 else { throw AppError(L("Text exceeds the input limit.")) }
            if !input.barcode.isEmpty {
                let code: String? = try engine.call("barcode", input.barcode)
                guard let code else { throw AppError(L("Check the barcode digits and checksum.")) }; input.barcode = code
            }
            input.images = nil
            let job = CheckJob(input: input, photos: photos, settings: settings, accountID: settings.connection == "chatgpt" ? chatGPT.selectedAccount : nil)
            jobs.append(job); try files.save(jobs, "queue.json")
            if supplied == nil { clearDraft() }
            schedule()
        } catch { report(error) }
    }
    func schedule() {
        for job in jobs where job.status == "queued" && tasks.count < settings.parallelChecks && !(switchingChatGPT && job.settings.connection == "chatgpt") {
            setStatus(job.id, "evaluating")
            tasks[job.id] = Task { [weak self] in await self?.run(job) }
        }
    }
    private func run(_ job: CheckJob) async {
        defer { tasks.removeValue(forKey: job.id); schedule(); endBackgroundIfIdle(); if job.settings.connection == "hosted" && !settings.offline { hosted.refresh() } }
        do {
            var input = job.input
            let photos = try job.photos.map { try Data(contentsOf: files.url($0)) }
            var config = job.settings
            config.offline = config.offline || settings.offline
            guard config.connection != "chatgpt" || job.accountID == chatGPT.selectedAccount else { throw AppError(L("The account changed. Start a new check.")) }
            config.aiEnabled = connectionReady(config)
            if config.connection == "chatgpt" { config.model = config.chatGPTModel }
            if config.connection == "hosted" { config.model = hosted.configuration.model ?? "" }
            if config.connection != "hosted" && config.vision { config.vision = try engine.acceptsImages(config.model, metadata: config.connection == "chatgpt" ? chatGPT.modelMetadata[config.model] : nil) }
            if config.vision { input.images = photos.map { "data:image/jpeg;base64," + $0.base64EncodedString() } }
            // A photograph-only check must reach the decision engine even with AI vision disabled.
            if input.images == nil && !photos.isEmpty && !input.hasContent { input.name = L("Photo check"); config.aiEnabled = false }
            let token: String
            if config.aiEnabled && !config.offline && !config.model.isEmpty {
                if config.connection == "chatgpt" { token = ""; config.baseUrl = "https://api.openai.com/v1" }
                else if config.connection == "hosted" { token = hosted.token }
                else { token = try Keychain.read(config.baseUrl) }
            } else { token = "" }
            var result = try await engine.check(id: job.id, input: input, settings: config, token: token)
            if !photos.isEmpty && !result.usedAI && result.outcome == .uncertain {
                do {
                    setStatus(job.id, "ocr")
                    var text = ""
                    for photo in photos {
                        try Task.checkCancellation()
                        let recognized = try await PhotoProcessor.recognize(photo, languages: config.ocrLanguages)
                        text += recognized.text + "\n"
                        if input.barcode.isEmpty, let barcode = recognized.barcode, let normalized: String = try engine.call("barcode", barcode) {
                            input.barcode = normalized
                            var local = config; local.aiEnabled = false
                            let additional = try await engine.check(id: job.id, input: input, settings: local, token: "")
                            struct Merge: Encodable { var original: CheckResult; var additional: CheckResult }
                            result = try engine.call("merge", Merge(original: result, additional: additional))
                        }
                    }
                    struct OCR: Encodable { var result: CheckResult; var input: CheckInput; var text: String }
                    result = try engine.call("mergeOCR", OCR(result: result, input: job.input, text: text))
                } catch is CancellationError { throw CancellationError() }
                catch {
                    try Task.checkCancellation()
                    result.warnings.append(L("Local text recognition also failed; earlier evidence has been kept."))
                }
            }
            try Task.checkCancellation()
            let name = (result.identity.name ?? job.input.name).trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { result.title = name }
            else if !job.input.text.isEmpty { result.title = String(job.input.text.prefix(80)) }
            let saved = SavedCheck(id: result.id, result: result, input: job.input, photos: job.photos)
            history.insert(saved, at: 0)
            try files.save(history, "history.json")
            jobs.removeAll { $0.id == job.id }; try files.save(jobs, "queue.json")
            if selectedTab == "check" && selectedResult == nil { selectedResult = saved }
        } catch is CancellationError { setStatus(job.id, "cancelled") }
        catch { setStatus(job.id, "failed", error: error.localizedDescription) }
    }
    func setStatus(_ id: String, _ status: String, error: String? = nil) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        jobs[index].status = status; jobs[index].error = error
        do { try files.save(jobs, "queue.json") } catch { report(error) }
    }
    func cancel(_ id: String) { if let task = tasks[id] { task.cancel() } else { setStatus(id, "cancelled") } }
    func retry(_ id: String) {
        guard tasks[id] == nil, !switchingChatGPT, !disconnectingHosted, let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        jobs[index].settings = settings; jobs[index].accountID = settings.connection == "chatgpt" ? chatGPT.selectedAccount : nil
        setStatus(id, "queued"); schedule()
    }
    func removeJob(_ id: String) { cancel(id); jobs.removeAll { $0.id == id }; do { try files.save(jobs, "queue.json") } catch { report(error) }; cleanPhotos() }
    func delete(_ ids: Set<String>) {
        let next = history.filter { !ids.contains($0.id) }
        do { try files.save(next, "history.json"); history = next; cleanPhotos() } catch { report(error) }
    }
    func cleanPhotos() {
        let keep = Set(draftPhotos + history.flatMap(\.photos) + jobs.flatMap(\.photos))
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: files.root.path) else { return }
        for name in names where name.hasSuffix(".jpg") && !keep.contains(name) { try? files.remove(name) }
    }
    func importHistory(_ data: Data) throws {
        let imported = try HistoryTransfer.parse(data)
        var next = history
        for result in imported where !next.contains(where: { $0.id == result.id }) { next.append(SavedCheck(id: result.id, result: result, input: nil, photos: [])) }
        next.sort { $0.result.checkedAt > $1.result.checkedAt }
        try files.save(next, "history.json"); history = next
    }
    func exportHistory() throws -> Data { try HistoryDocument(results: history.map(\.result)).jsonData() }
    func enterBackground() {
        guard !tasks.isEmpty, backgroundID == .invalid else { return }
        backgroundID = UIApplication.shared.beginBackgroundTask(withName: "Finish product checks") { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.stopNetworkWork()
                self.endBackground()
            }
        }
    }
    private func endBackgroundIfIdle() { if tasks.isEmpty { endBackground() } }
    private func endBackground() { if backgroundID != .invalid { UIApplication.shared.endBackgroundTask(backgroundID); backgroundID = .invalid } }

    func connectionReady(_ config: Settings) -> Bool {
        guard !config.offline else { return false }
        switch config.connection {
        case "hosted": return hosted.ready
        case "chatgpt": return chatGPT.connected && !config.chatGPTModel.isEmpty && !switchingChatGPT
        case "api":
            struct Provider: Encodable { var baseUrl: String; var model: String }
            guard !config.model.isEmpty, (try? engine.call("provider", Provider(baseUrl: config.baseUrl, model: config.model), as: Bool.self)) == true else { return false }
            return !((try? Keychain.read(config.baseUrl)) ?? "").isEmpty || ["localhost", "127.0.0.1", "[::1]", "::1"].contains(URL(string: config.baseUrl)?.host ?? "")
        default: return false
        }
    }
    func stopConnection(_ connection: String) async {
        let ids = jobs.filter { $0.settings.connection == connection }.map(\.id)
        let running = ids.compactMap { tasks[$0] }
        for id in ids { cancel(id) }
        for task in running { await task.value }
    }
    func changeChatGPT(_ action: () async throws -> Void) async {
        guard !switchingChatGPT else { return }; switchingChatGPT = true
        defer { switchingChatGPT = false; chatGPT.loadStatus(); schedule() }
        await stopConnection("chatgpt")
        await ChatGPTConnection.finishRefreshing()
        do { try await action() } catch { report(error) }
    }
    func connectChatGPT(clientID: String? = nil, newAccount: Bool = false) async {
        guard !settings.offline else { return }
        await changeChatGPT {
            try await chatGPT.signIn(clientID: clientID, newAccount: newAccount)
            do {
                let models = try await chatGPT.models()
                settings.chatGPTModel = ChatGPTConnection.preferredModel(current: settings.chatGPTModel, available: models)
                saveSettings()
            } catch { report(error) }
        }
    }
    func disconnectHosted() async {
        guard !disconnectingHosted else { return }; disconnectingHosted = true
        defer { disconnectingHosted = false }
        hosted.cancel(); await stopConnection("hosted")
        do { try hosted.disconnect(offline: settings.offline) } catch { report(error) }
    }
    func hideReply(_ id: String) {
        var next = hiddenReplies; next.insert(id)
        do { try files.save(next, "hidden-replies.json"); hiddenReplies = next } catch { report(error) }
    }
    func restoreReplies() {
        do { try files.save(Set<String>(), "hidden-replies.json"); hiddenReplies = [] } catch { report(error) }
    }

    func reloadPacks() throws {
        let names: [String] = try files.read("packs.json") ?? []
        let raw = try names.map { String(decoding: try Data(contentsOf: files.url($0)), as: UTF8.self) }
        _ = try engine.callRaw("snapshots", json: "[" + raw.joined(separator: ",") + "]")
        packs = try engine.call("packs", "")
    }
    func importPack(_ data: Data) throws {
        guard data.count <= 10_000_000 else { throw AppError(L("Offline packs must be smaller than 10 MB.")) }
        let validated = try engine.callRaw("snapshot", json: String(decoding: data, as: UTF8.self))
        struct Header: Decodable { var region: String; var generatedAt: String }
        let header = try JSONDecoder().decode(Header.self, from: Data(validated.utf8))
        let name = "pack-" + Keychain.account(header.region.lowercased()) + ".json"
        var names: [String] = try files.read("packs.json") ?? []
        guard names.contains(name) || names.count < 12 else { throw AppError(L("Remove an offline pack before adding another.")) }
        if let old: Header = try files.read(name), old.generatedAt > header.generatedAt { throw AppError(L("The installed pack is newer.")) }
        try files.saveData(Data(validated.utf8), name)
        if !names.contains(name) { names.append(name) }; try files.save(names, "packs.json"); try reloadPacks()
    }
    func removePack(_ region: String) {
        do {
            let name = "pack-" + Keychain.account(region.lowercased()) + ".json"
            let names: [String] = try files.read("packs.json") ?? []
            try files.save(names.filter { $0 != name }, "packs.json"); try files.remove(name); try reloadPacks()
        } catch { report(error) }
    }
    func refreshCatalog() {
        guard !settings.offline, !packBusy, let url = safeURL(settings.catalogURL) else { return }
        packBusy = true
        packTask = Task {
            defer { packBusy = false }
            do {
                let data = try await Network.get(url, limit: 256_000, redirects: true)
                let doc = try JSONDecoder().decode(PackCatalog.self, from: data)
                guard doc.schemaVersion == 1, doc.packs.count <= 100, Set(doc.packs.map(\.id)).count == doc.packs.count,
                      doc.packs.allSatisfy({ safeURL($0.url) != nil && (1...10_000_000).contains($0.bytes) && (0...10_000).contains($0.products) && $0.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil && HistoryTransfer.parseDate($0.generatedAt) != nil }) else { throw AppError(L("Invalid regional pack catalog.")) }
                catalog = doc.packs
            } catch { report(error) }
        }
    }
    func downloadPack(_ pack: PackDescriptor) {
        guard !settings.offline, !packBusy, let url = safeURL(pack.url) else { return }; packBusy = true
        packTask = Task {
            defer { packBusy = false }
            do {
                let data = try await Network.get(url, limit: pack.bytes, redirects: true)
                guard data.count == pack.bytes, SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == pack.sha256 else { throw AppError(L("Pack checksum mismatch.")) }
                struct Header: Decodable { var region: String; var generatedAt: String; var products: [Product]; struct Product: Decodable {} }
                let header = try JSONDecoder().decode(Header.self, from: data)
                guard header.region == pack.region, header.generatedAt == pack.generatedAt, header.products.count == pack.products else { throw AppError(L("Invalid regional pack catalog.")) }
                try Task.checkCancellation(); try importPack(data)
            } catch { report(error) }
        }
    }
    func cancelPack() { packTask?.cancel() }
    func stopNetworkWork() {
        for task in tasks.values { task.cancel() }
        for index in jobs.indices where jobs[index].status == "queued" { jobs[index].status = "interrupted" }
        cancelPack(); hosted.cancel(); chatGPT.cancel()
        do { try files.save(jobs, "queue.json") } catch { report(error) }
    }
}
