import XCTest
import CryptoKit
import UIKit
import Security
@testable import Vegsnap

@MainActor final class CoreTests: XCTestCase {
    var engine: CoreEngine!
    override func setUp() async throws { Keychain.testService = "app.vegsnap.ios.tests." + UUID().uuidString; engine = try CoreEngine() }
    override func tearDown() async throws {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: Keychain.service] as CFDictionary)
        Keychain.testService = nil; Network.testProtocolClasses = nil; FileStore.rejectWrite = nil
    }
    func analyze(_ text: String, category: Vegsnap.Category = .food, complete: Bool? = true, name: String = "", locale: String = "en") throws -> CheckResult {
        try engine.call("analyze", CheckInput(text: text, name: name, category: category, complete: complete, locale: locale))
    }
    func testKnownAnimalAndPlantComposition() throws {
        XCTAssertEqual(try analyze("Ingredients: oats, honey, salt").outcome, .notVegan)
        XCTAssertEqual(try analyze("Ingredients: oats, water, salt").outcome, .vegan)
        XCTAssertEqual(try analyze("Ingredients: oats, water, salt", complete: false).outcome, .uncertain)
    }
    func testCrossContactIsNotAnIngredient() throws {
        let result = try analyze("Ingredients: oats, water, salt. May contain milk.")
        XCTAssertEqual(result.outcome, .vegan); XCTAssertEqual(result.crossContact.count, 1)
    }
    func testMaterialsAndProcessingRequireEvidence() throws {
        XCTAssertEqual(try analyze("Materials: cotton, rubber", category: .shoes).outcome, .uncertain)
        XCTAssertEqual(try analyze("Ingredients: grapes, water", category: .drink, name: "Wine").outcome, .uncertain)
        XCTAssertEqual(try analyze("Materials: leather, rubber", category: .shoes).outcome, .notVegan)
    }
    func testUnknownAndAmbiguousRemainUncertain() throws {
        XCTAssertEqual(try analyze("Ingredients: water, E471").outcome, .uncertain)
        XCTAssertEqual(try analyze("Ingredients: water, novel mystery extract").outcome, .uncertain)
    }
    func testGermanAndSoyRegression() throws {
        XCTAssertEqual(try analyze("Zutaten: Haferflocken, Honig, Salz", locale: "de").outcome, .notVegan)
        let result = try analyze("Ingredients: soy lecithin, water")
        XCTAssertNotEqual(result.outcome, .notVegan)
    }
    func testBarcodeAndProviderValidation() throws {
        let valid: String? = try engine.call("barcode", "4006381333931"); XCTAssertEqual(valid, "4006381333931")
        let invalid: String? = try engine.call("barcode", "4006381333932"); XCTAssertNil(invalid)
        struct Config: Encodable { var baseUrl: String; var model = "model" }
        XCTAssertThrowsError(try engine.call("provider", Config(baseUrl: "https://secret@example.org/v1"), as: Bool.self))
        XCTAssertThrowsError(try engine.call("provider", Config(baseUrl: "http://example.org/v1"), as: Bool.self))
        XCTAssertTrue(try engine.call("provider", Config(baseUrl: "http://127.0.0.1:11434/v1"), as: Bool.self))
    }
    func testAsyncOfflineCheckAndBundledSnapshot() async throws {
        var settings = Settings(); settings.offline = true
        let result = try await engine.check(id: UUID().uuidString, input: CheckInput(text: "Ingredients: honey", category: .food), settings: settings, token: "")
        XCTAssertEqual(result.outcome, .notVegan)
        let packs: [PackInfo] = try engine.call("packs", "")
        XCTAssertFalse(packs.isEmpty); XCTAssertGreaterThan(packs[0].count, 0)
    }
    func testOCRCannotPromoteIncompleteLabel() throws {
        let original = try analyze("", complete: false)
        struct Args: Encodable { var result: CheckResult; var input: CheckInput; var text: String }
        let result: CheckResult = try engine.call("mergeOCR", Args(result: original, input: CheckInput(category: .food), text: "Ingredients: oats, water, salt"))
        XCTAssertEqual(result.outcome, .uncertain)
        XCTAssertTrue(result.evidence.contains { $0.kind == "ocr" })
        let negative: CheckResult = try engine.call("mergeOCR", Args(result: original, input: CheckInput(category: .food), text: "Ingredients: oats, honey"))
        XCTAssertEqual(negative.outcome, .notVegan)
    }
    func testHistoryRoundTripAndRejectInvalidVersion() throws {
        let result = try analyze("Ingredients: oats, honey")
        let data = try HistoryDocument(results: [result]).jsonData()
        XCTAssertEqual(try HistoryTransfer.parse(data).first?.outcome, .notVegan)
        var document = HistoryDocument(results: [result]); document.schemaVersion = 2
        XCTAssertThrowsError(try HistoryTransfer.parse(document.jsonData()))
        XCTAssertThrowsError(try HistoryTransfer.parse(Data(repeating: 32, count: 5_000_001)))
    }
    func testExportRejectsUnrestorableHistoryWithoutChangingIt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        let result = try analyze("Ingredients: oats, honey")
        store.history = (0..<HistoryTransfer.resultLimit).map { index in
            var copy = result; copy.id = "export-\(index)"
            return SavedCheck(id: copy.id, result: copy, input: nil, photos: [])
        }
        XCTAssertEqual(try HistoryTransfer.parse(store.exportHistory()).count, HistoryTransfer.resultLimit)
        store.history.append(SavedCheck(id: "extra", result: result, input: nil, photos: []))
        XCTAssertThrowsError(try store.exportHistory())
        XCTAssertEqual(store.history.count, HistoryTransfer.resultLimit + 1)
        var large = result; large.summary = String(repeating: "x", count: 30_000)
        store.history = (0..<200).map { index in
            var copy = large; copy.id = "large-\(index)"
            return SavedCheck(id: copy.id, result: copy, input: nil, photos: [])
        }
        XCTAssertGreaterThan(try HistoryDocument(results: store.history.map(\.result)).jsonData().count, HistoryTransfer.byteLimit)
        XCTAssertThrowsError(try store.exportHistory())
        XCTAssertEqual(store.history.count, 200)
    }
    func testConsumedShareIsQuarantinedWhenDeletionFails() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let inbox = root.appendingPathComponent("inbox")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root.appendingPathComponent("app"), inboxDirectory: inbox)
        let entry = inbox.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
        try InboxPayload.encode(text: "first share", photos: []).write(to: entry.appendingPathComponent("input.json"))
        store.consumeInbox(fileManager: RejectInboxRemoval())
        XCTAssertEqual(store.draft.text, "first share")
        XCTAssertFalse(FileManager.default.fileExists(atPath: entry.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: entry.appendingPathExtension("consumed").path))
        let restored = try AppStore(root: root.appendingPathComponent("app"), inboxDirectory: inbox)
        restored.clearDraft()
        XCTAssertFalse(restored.draft.hasContent)
        let next = inbox.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true)
        try InboxPayload.encode(text: "second share", photos: []).write(to: next.appendingPathComponent("input.json"))
        restored.consumeInbox()
        XCTAssertEqual(restored.draft.text, "second share")
    }
    func testPackUpdatesCompareInstantsAcrossUTCOffsets() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        func pack(_ date: String) -> Data {
            Data("""
            {"schemaVersion":1,"region":"timestamp-fixture","generatedAt":"\(date)","sources":[{"id":"off","url":"https://world.openfoodfacts.org","license":"ODbL-1.0","retrievedAt":"2026-10-09T00:00:00Z"}],"products":[]}
            """.utf8)
        }
        try store.importPack(pack("2026-10-09T12:00:00+02:00"))
        try store.importPack(pack("2026-10-09T11:00:00Z"))
        XCTAssertEqual(store.packs.first { $0.region == "timestamp-fixture" }?.generatedAt, "2026-10-09T11:00:00Z")
        XCTAssertThrowsError(try store.importPack(pack("2026-10-09T12:00:00+02:00")))
        try store.importPack(pack("2026-10-09T13:00:00+02:00")) // Same instant is allowed.
        try store.importPack(pack("2026-10-09T11:00:00.500Z"))
        XCTAssertThrowsError(try store.importPack(pack("2026-10-09T11:00:00Z")))
        let restored = try AppStore(root: root)
        XCTAssertEqual(restored.packs.first { $0.region == "timestamp-fixture" }?.generatedAt, "2026-10-09T11:00:00.500Z")
    }
    func testImportedHistorySortsChronologically() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        let base = try analyze("Ingredients: oats")
        let dates = ["2026-10-09T13:00:00+02:00", "2026-10-09T12:00:00Z", "2026-10-09T11:00:00.500Z"]
        let results = dates.enumerated().map { index, date in
            var result = base; result.id = "date-\(index)"; result.checkedAt = date; return result
        }
        try store.importHistory(HistoryDocument(results: results).jsonData())
        XCTAssertEqual(store.history.map(\.id), ["date-1", "date-2", "date-0"])
        XCTAssertEqual(try AppStore(root: root).history.map(\.id), ["date-1", "date-2", "date-0"])
    }
    func testOnlineBrowseFallsBackFromBlankLocalizedFields() async throws {
        Network.testProtocolClasses = [FixtureProtocol.self]
        let page = try await BrowseService().search("localized-fixture", source: .food, cursor: 0, locale: "de")
        let record = try XCTUnwrap(page.records.first)
        XCTAssertEqual(record.name, "Base product")
        XCTAssertEqual(record.composition, "Ingredients: oats")
    }
    func testCancelledPackRequestsDoNotPublishErrors() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root); StalledNetworkProtocol.started = nil }
        Network.testProtocolClasses = [StalledNetworkProtocol.self]
        let store = try AppStore(root: root); store.settings.offline = false
        store.settings.catalogURL = "https://fixture.invalid/catalog.json"
        for download in [false, true] {
            let started = expectation(description: "Pack request started")
            StalledNetworkProtocol.started = started
            if download {
                store.downloadPack(PackDescriptor(id: "fixture", region: "fixture", url: "https://fixture.invalid/pack.json", bytes: 1000, sha256: String(repeating: "0", count: 64), generatedAt: "2026-10-09T00:00:00Z", products: 0))
            } else { store.refreshCatalog() }
            await fulfillment(of: [started], timeout: 3)
            store.cancelPack()
            for _ in 0..<100 { if !store.packBusy { break }; try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertFalse(store.packBusy); XCTAssertNil(store.error)
        }
        XCTAssertTrue(store.catalog.isEmpty)
    }
    func testCancellationStopsVisionRecognition() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 1600)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 1200, height: 1600))
            for row in 0..<40 {
                ("Ingredients: oats, water, honey, salt" as NSString).draw(at: CGPoint(x: 20, y: row * 40), withAttributes: [.font: UIFont.systemFont(ofSize: 28), .foregroundColor: UIColor.black])
            }
        }
        let data = try XCTUnwrap(image.pngData())
        let task = Task { try await PhotoProcessor.recognize(data, languages: ["en-US"]) }
        try await Task.sleep(for: .milliseconds(10))
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled OCR returned a result") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
    func testEnqueueReportsAcceptanceOnlyAfterSaving() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { FileStore.rejectWrite = nil; try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root); store.settings.offline = true
        let input = CheckInput(name: "Example drink", category: .drink)
        store.settings.connection = "chatgpt"; store.switchingChatGPT = true
        XCTAssertFalse(store.enqueue(input: input))
        store.switchingChatGPT = false; store.settings.connection = "hosted"; store.disconnectingHosted = true
        XCTAssertFalse(store.enqueue(input: input))
        store.disconnectingHosted = false
        FileStore.rejectWrite = { $0.lastPathComponent == "queue.json" }
        XCTAssertFalse(store.enqueue(input: input)); XCTAssertTrue(store.jobs.isEmpty)
        FileStore.rejectWrite = nil
        XCTAssertTrue(store.enqueue(input: input))
        XCTAssertEqual(store.jobs.count, 1)
        for _ in 0..<100 { if store.jobs.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(store.history.count, 1)
    }
    func testDraftQueueAndDeletionPersistence() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root); store.settings.offline = true
        store.draft = CheckInput(text: "Ingredients: oats, honey", category: .food); store.saveDraft()
        XCTAssertEqual(try AppStore(root: root).draft.text, store.draft.text)
        store.enqueue()
        for _ in 0..<100 { if !store.history.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(store.history.count, 1); XCTAssertTrue(store.jobs.isEmpty)
        let restored = try AppStore(root: root); XCTAssertEqual(restored.history.count, 1)
        restored.delete(Set(restored.history.map(\.id)))
        XCTAssertTrue(try AppStore(root: root).history.isEmpty)
    }
    func testInterruptedQueueDoesNotAutomaticallyResend() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = try FileStore(root: root)
        try files.save([CheckJob(input: CheckInput(text: "pending"), photos: [], status: "ai")], "queue.json")
        let store = try AppStore(root: root)
        XCTAssertEqual(store.jobs.first?.status, "interrupted"); XCTAssertTrue(store.history.isEmpty)
        store.jobs.append(CheckJob(input: CheckInput(text: "waiting"), photos: []))
        store.stopNetworkWork(); store.schedule()
        XCTAssertTrue(store.jobs.allSatisfy { $0.status == "interrupted" })
        XCTAssertTrue(try AppStore(root: root).jobs.allSatisfy { $0.status == "interrupted" })
    }
    func testPhotoSanitizationAndVisionOCR() async throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1300, height: 400), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 1300, height: 400))
            ("Ingredients: oats, honey, salt" as NSString).draw(at: CGPoint(x: 40, y: 100), withAttributes: [.font: UIFont.systemFont(ofSize: 56), .foregroundColor: UIColor.black])
        }
        let clean = try PhotoProcessor.sanitize(XCTUnwrap(image.pngData()))
        XCTAssertLessThan(clean.count, 3_000_000)
        let recognized = try await PhotoProcessor.recognize(clean, languages: ["en-US"])
        XCTAssertTrue(recognized.text.lowercased().contains("honey"))
    }
    func testOCRFailurePreservesEarlierEvidence() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        store.settings.offline = true; store.settings.vision = false
        try store.files.saveData(Data("corrupted photo".utf8), "invalid.jpg")
        store.enqueue(input: CheckInput(text: "Ingredients: water, mystery", category: .food), photos: ["invalid.jpg"])
        for _ in 0..<500 {
            if !store.history.isEmpty || store.jobs.contains(where: { $0.status == "failed" }) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let result = try XCTUnwrap(store.history.first?.result)
        XCTAssertEqual(result.outcome, .uncertain)
        XCTAssertTrue(result.evidence.contains { $0.kind == "user_text" && $0.excerpt.contains("mystery") })
        XCTAssertTrue(result.warnings.contains(L("Local text recognition also failed; earlier evidence has been kept.")))
        XCTAssertTrue(store.jobs.isEmpty)
    }
    func testFailedSharedPhotoIsQuarantinedWithoutPartialDraft() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let inbox = root.appendingPathComponent("inbox")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root.appendingPathComponent("app"), inboxDirectory: inbox)
        let entry = inbox.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        }
        try XCTUnwrap(image.pngData()).write(to: entry.appendingPathComponent("good.png"))
        try Data("invalid image".utf8).write(to: entry.appendingPathComponent("bad.png"))
        try Data(#"{"text":"failed share","photos":["good.png","bad.png"]}"#.utf8).write(to: entry.appendingPathComponent("input.json"))
        store.consumeInbox()
        XCTAssertFalse(store.draft.hasContent); XCTAssertTrue(store.draftPhotos.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: entry.appendingPathExtension("failed").path))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("app").path).contains { $0.hasSuffix(".jpg") })
        let next = inbox.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true)
        try Data(#"{"text":"next share","photos":[]}"#.utf8).write(to: next.appendingPathComponent("input.json"))
        store.consumeInbox()
        XCTAssertEqual(store.draft.text, "next share")
        XCTAssertEqual(try AppStore(root: root.appendingPathComponent("app"), inboxDirectory: inbox).draft.text, "next share")
    }
    func testSubmittingAndClearingDraftAdvanceSharedInbox() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let inbox = root.appendingPathComponent("inbox")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root.appendingPathComponent("app"), inboxDirectory: inbox)
        store.settings.offline = true
        store.draft = CheckInput(text: "Ingredients: oats, honey", category: .food)
        func queueShare(_ text: String) throws {
            let entry = inbox.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: ["text": text, "photos": []]).write(to: entry.appendingPathComponent("input.json"))
        }
        try queueShare("second share")
        store.consumeInbox()
        XCTAssertEqual(store.draft.text, "Ingredients: oats, honey")
        store.enqueue()
        XCTAssertEqual(store.draft.text, "second share")
        try queueShare("third share")
        store.clearDraft()
        XCTAssertEqual(store.draft.text, "third share")
        for _ in 0..<500 {
            if !store.history.isEmpty { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(store.history.first?.result.outcome, .notVegan)
        XCTAssertTrue(store.jobs.isEmpty)
    }
    func testIPv6LoopbackProviderReachesNativeNetworkBridge() async throws {
        Network.testProtocolClasses = [FixtureProtocol.self]
        var settings = Settings(); settings.connection = "api"; settings.baseUrl = "http://[::1]:11434/v1"; settings.model = "fixture"
        let result = try await engine.check(id: UUID().uuidString, input: CheckInput(text: "Ingredients: water, mystery", category: .food, complete: true), settings: settings, token: "fixture-key")
        XCTAssertTrue(result.usedAI); XCTAssertEqual(result.aiStatus, "text")
    }
    func testSharedTextFitsUTF16AndEncodedInboxLimits() throws {
        for text in [String(repeating: "😀", count: 30_000), String(repeating: "\u{0001}", count: 30_000), String(repeating: "界", count: 30_000)] {
            let data = try InboxPayload.encode(text: text, photos: ["photo.image"])
            let payload = try JSONDecoder().decode(InboxPayload.self, from: data)
            XCTAssertLessThanOrEqual(data.count, InboxPayload.byteLimit)
            XCTAssertLessThanOrEqual(payload.text.utf16.count, InboxPayload.textLimit)
            XCTAssertFalse(payload.text.isEmpty)
            XCTAssertTrue(text.hasPrefix(payload.text))
            XCTAssertEqual(payload.photos, ["photo.image"])
        }
    }
    func testDetailedPhotoRotationStaysWithinProviderLimit() throws {
        let width = 1800; let height = 1600
        var seed: UInt32 = 42
        let pixels = (0..<(width * height * 4)).map { index -> UInt8 in
            if index % 4 == 3 { return 255 }
            seed = 1664525 &* seed &+ 1013904223
            return UInt8(truncatingIfNeeded: seed >> 24)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let cgImage = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let input = try PhotoProcessor.sanitize(XCTUnwrap(UIImage(cgImage: cgImage).pngData()))
        let rotated = try PhotoProcessor.rotate(input)
        XCTAssertLessThanOrEqual(("data:image/jpeg;base64," + rotated.base64EncodedString()).count, 4_000_000)
        let image = try XCTUnwrap(UIImage(data: rotated))
        XCTAssertEqual(image.size.width, CGFloat(height)); XCTAssertEqual(image.size.height, CGFloat(width))
    }
    func testCompletionWriteFailuresKeepRecoverableState() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        let result = try analyze("Ingredients: honey")
        let job = CheckJob(input: CheckInput(text: "Ingredients: honey"), photos: [])
        XCTAssertNotEqual(job.id, result.id)
        store.jobs = [job]; try store.files.save(store.jobs, "queue.json")
        let saved = SavedCheck(id: result.id, result: result, input: job.input, photos: [])
        try FileManager.default.createDirectory(at: store.files.url("history.json"), withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.complete(saved, jobID: job.id))
        XCTAssertTrue(store.history.isEmpty); XCTAssertEqual(store.jobs.count, 1)
        try FileManager.default.removeItem(at: store.files.url("history.json"))
        try FileManager.default.removeItem(at: store.files.url("queue.json"))
        try FileManager.default.createDirectory(at: store.files.url("queue.json"), withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.complete(saved, jobID: job.id))
        XCTAssertEqual(store.history.count, 1); XCTAssertEqual(store.jobs.count, 1)
        XCTAssertEqual(store.history.first?.id, job.id)
        XCTAssertEqual(store.history.first?.result.id, job.id)
        try FileManager.default.removeItem(at: store.files.url("queue.json"))
        try store.files.save([job], "queue.json")
        let restored = try AppStore(root: root)
        XCTAssertEqual(restored.history.count, 1); XCTAssertTrue(restored.jobs.isEmpty)
        store.retry(job.id)
        XCTAssertTrue(store.jobs.isEmpty); XCTAssertEqual(store.history.count, 1)
        let persisted: [CheckJob] = try XCTUnwrap(store.files.read("queue.json"))
        XCTAssertTrue(persisted.isEmpty)
    }
    func testCancelledSearchesDoNotReserveFutureRateLimitSlots() async throws {
        Network.testProtocolClasses = [FixtureProtocol.self]
        let service = BrowseService()
        _ = try await service.search("first", source: .food, cursor: 0, locale: "en")
        let start = Date()
        for query in ["cancel one", "cancel two"] {
            let task = Task { try await service.search(query, source: .food, cursor: 0, locale: "en") }
            try await Task.sleep(for: .milliseconds(50))
            task.cancel()
            do { _ = try await task.value; XCTFail("Cancelled search completed") } catch is CancellationError {}
        }
        _ = try await service.search("final", source: .food, cursor: 0, locale: "en")
        XCTAssertLessThan(Date().timeIntervalSince(start), 10)
    }
    func testReportExcerptRespectsUTF16WithoutSplittingCharacters() throws {
        for character in ["😀", "👩🏽‍💻", "e\u{301}", "a"] {
            let input = String(repeating: character, count: 8001)
            let excerpt = ContentReport.excerpt(input)
            XCTAssertLessThanOrEqual(excerpt.utf16.count, 8000)
            XCTAssertGreaterThan(excerpt.utf16.count + character.utf16.count, 8000)
            XCTAssertTrue(input.hasPrefix(excerpt))
            XCTAssertNoThrow(try ContentReport(kind: "ai", text: excerpt, reason: "Incorrect").validatedData())
        }
    }
    func testFailedJobRemovalPreservesPhotosAndRetryableQueue() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        let job = CheckJob(input: CheckInput(text: "pending"), photos: ["kept.jpg"], status: "failed")
        store.jobs = [job]
        let photo = Data("saved photo fixture".utf8)
        try store.files.saveData(photo, "kept.jpg")
        try store.files.save([job], "queue.json")
        let persisted = try Data(contentsOf: store.files.url("queue.json"))
        try FileManager.default.removeItem(at: store.files.url("queue.json"))
        try FileManager.default.createDirectory(at: store.files.url("queue.json"), withIntermediateDirectories: true)
        store.removeJob(job.id)
        XCTAssertEqual(store.jobs.map(\.id), [job.id])
        XCTAssertEqual(try Data(contentsOf: store.files.url("kept.jpg")), photo)
        XCTAssertNotNil(store.error)
        try FileManager.default.removeItem(at: store.files.url("queue.json"))
        try persisted.write(to: store.files.url("queue.json"))
        let restored = try AppStore(root: root)
        XCTAssertEqual(restored.jobs.map(\.id), [job.id])
        restored.removeJob(job.id)
        XCTAssertTrue(restored.jobs.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.files.url("kept.jpg").path))
        XCTAssertTrue(try AppStore(root: root).jobs.isEmpty)
    }
    func testFailedEnqueueDoesNotPublishOrDuplicateJobs() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root); store.settings.offline = true
        store.draft = CheckInput(text: "Ingredients: honey")
        try FileManager.default.createDirectory(at: store.files.url("queue.json"), withIntermediateDirectories: true)
        store.enqueue()
        XCTAssertTrue(store.jobs.isEmpty); XCTAssertTrue(store.history.isEmpty)
        XCTAssertEqual(store.draft.text, "Ingredients: honey")
        try FileManager.default.removeItem(at: store.files.url("queue.json"))
        store.enqueue()
        for _ in 0..<500 {
            if !store.history.isEmpty { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(store.history.count, 1); XCTAssertTrue(store.jobs.isEmpty)
    }
    func testFailedDraftPhotoChangesPreservePersistedDraft() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        store.draft = CheckInput(text: "my draft"); store.draftPhotos = ["kept.jpg"]
        try store.files.saveData(Data("photo fixture".utf8), "kept.jpg"); store.saveDraft()
        let persisted = try Data(contentsOf: store.files.url("draft.json"))
        try FileManager.default.removeItem(at: store.files.url("draft.json"))
        try FileManager.default.createDirectory(at: store.files.url("draft.json"), withIntermediateDirectories: true)
        store.clearDraft(); store.removePhoto("kept.jpg")
        XCTAssertEqual(store.draft.text, "my draft"); XCTAssertEqual(store.draftPhotos, ["kept.jpg"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.files.url("kept.jpg").path))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { $0.fill(CGRect(x: 0, y: 0, width: 40, height: 40)) }
        XCTAssertThrowsError(try store.addPhoto(XCTUnwrap(image.pngData())))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasSuffix(".jpg") }, ["kept.jpg"])
        try FileManager.default.removeItem(at: store.files.url("draft.json"))
        try persisted.write(to: store.files.url("draft.json"))
        let restored = try AppStore(root: root)
        XCTAssertEqual(restored.draft.text, "my draft"); XCTAssertEqual(restored.draftPhotos, ["kept.jpg"])
        restored.clearDraft()
        XCTAssertFalse(try AppStore(root: root).draft.hasContent)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.files.url("kept.jpg").path))
    }
    func testAcceptedDraftCannotResubmitWhenClearingFails() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { FileStore.rejectWrite = nil; try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root); store.settings.offline = true
        store.draft = CheckInput(text: "Ingredients: honey")
        let draftID = store.draftID
        var writes = 0
        FileStore.rejectWrite = { url in
            guard url == store.files.url("draft.json") else { return false }
            writes += 1; return writes > 1
        }
        store.enqueue(); store.enqueue()
        XCTAssertEqual(store.jobs.map(\.id), [draftID]); XCTAssertTrue(store.draftSubmitted)
        XCTAssertEqual(store.draft.text, "Ingredients: honey")
        for _ in 0..<500 {
            if !store.history.isEmpty { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(store.history.count, 1)
        FileStore.rejectWrite = nil
        let restored = try AppStore(root: root); restored.settings.offline = true
        XCTAssertTrue(restored.draftSubmitted)
        restored.enqueue()
        XCTAssertTrue(restored.jobs.isEmpty); XCTAssertEqual(restored.history.count, 1)
        restored.clearDraft()
        XCTAssertNotEqual(restored.draftID, draftID); XCTAssertFalse(restored.draftSubmitted)
        restored.draft = CheckInput(text: "Ingredients: honey"); restored.enqueue()
        for _ in 0..<500 {
            if restored.history.count == 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(restored.history.count, 2)
    }
    func testPickerFileImportRejectsOversizedAssets() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("small fixture".utf8).write(to: url)
        XCTAssertEqual(try PickedPhoto.load(url).data, Data("small fixture".utf8))
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: 100_000_000); try handle.close()
        XCTAssertThrowsError(try PickedPhoto.load(url))
    }
    func testChatGPTCallbackGuards() throws {
        let result = try ChatGPTConnection.validateCallback(URL(string: "http://127.0.0.1/auth/callback?code=code&state=expected&client_id=oaiapp_test")!, state: "expected", returning: nil)
        XCTAssertEqual(result.clientID, "oaiapp_test")
        XCTAssertThrowsError(try ChatGPTConnection.validateCallback(URL(string: "http://127.0.0.1/auth/callback?code=code&state=wrong&client_id=oaiapp_test")!, state: "expected", returning: nil))
        XCTAssertThrowsError(try ChatGPTConnection.validateCallback(URL(string: "http://127.0.0.1/auth/callback?code=code&state=expected&state=expected&client_id=oaiapp_test")!, state: "expected", returning: nil))
    }
    func testSignedIdentityRejectsWrongNonceAndTampering() throws {
        let key = P256.Signing.PrivateKey(); let raw = key.publicKey.x963Representation
        let header = try ["alg": "ES256", "kid": "test"].jsonData().base64URL
        let claims: [String: Any] = ["iss": "https://auth.openai.com", "aud": "oaiapp_test", "sub": "subject", "nonce": "expected", "iat": 1000, "exp": 2000]
        let body = try JSONSerialization.data(withJSONObject: claims).base64URL
        let message = header + "." + body
        let token = message + "." + (try key.signature(for: Data(message.utf8))).rawRepresentation.base64URL
        let jwks = try JSONSerialization.data(withJSONObject: ["keys": [["kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "test", "x": raw.subdata(in: 1..<33).base64URL, "y": raw.subdata(in: 33..<65).base64URL]]])
        XCTAssertEqual(try ChatGPTConnection.verifyIdentity(token, clientID: "oaiapp_test", nonce: "expected", jwks: jwks, now: 1500).subject, "subject")
        XCTAssertThrowsError(try ChatGPTConnection.verifyIdentity(token, clientID: "oaiapp_test", nonce: "wrong", jwks: jwks, now: 1500))
        XCTAssertThrowsError(try ChatGPTConnection.verifyIdentity(token, clientID: "another", nonce: "expected", jwks: jwks, now: 1500))
        XCTAssertThrowsError(try ChatGPTConnection.verifyIdentity(token, clientID: "oaiapp_test", nonce: "expected", jwks: jwks, now: 2500))
    }
    func testStreamingRequiresTerminalCompletion() throws {
        let delta = Data("data: {\"type\":\"response.output_text.delta\",\"delta\":\"vegan\"}\n\n".utf8)
        XCTAssertThrowsError(try ChatGPTConnection.completedResponse(delta))
        let completed = Data("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n".utf8)
        XCTAssertNoThrow(try ChatGPTConnection.completedResponse(completed))
    }
    func testNativeNetworkBridgeAndResponseLimit() async throws {
        Network.testProtocolClasses = [FixtureProtocol.self]
        defer { Network.testProtocolClasses = nil }
        var settings = Settings(); settings.connection = "api"; settings.baseUrl = "https://fixture.invalid/v1"; settings.model = "fixture"
        let result = try await engine.check(id: UUID().uuidString, input: CheckInput(text: "Ingredients: water, mystery", category: .food, complete: true), settings: settings, token: "fixture-key")
        XCTAssertTrue(result.usedAI); XCTAssertEqual(result.aiStatus, "text")
        do {
            _ = try await Network.get(URL(string: "https://fixture.invalid/oversized")!, limit: 4)
            XCTFail("Oversized response was accepted")
        } catch { XCTAssertTrue(error.localizedDescription.contains("size")) }
    }
    func testUPCEExpansionAndKeychainEndpointBinding() throws {
        XCTAssertEqual(expandUPCE("04252614"), "042100005264")
        let endpoint = "https://fixture-" + UUID().uuidString + ".invalid/v1"
        defer { try? Keychain.save("", for: endpoint) }
        try Keychain.save("fixture-token", for: endpoint)
        XCTAssertEqual(try Keychain.read(endpoint), "fixture-token")
        XCTAssertEqual(try Keychain.read(endpoint + "/other"), "")
    }
    func testHostedSessionAndReportValidation() throws {
        let good = Data(#"{"state":"connected","remaining":3,"expiresAt":1999999999999,"enabled":true}"#.utf8)
        XCTAssertEqual(try HostedAIStatus.decode(good).remaining, 3)
        XCTAssertThrowsError(try HostedAIStatus.decode(Data(#"{"state":"connected","remaining":-1,"expiresAt":1,"enabled":true}"#.utf8)))
        XCTAssertTrue(HostedAIConnection.validToken(try HostedAIConnection.randomID()))
        XCTAssertFalse(HostedAIConnection.validToken("not-a-token"))
        XCTAssertNoThrow(try ContentReport(kind: "ai", text: "Reviewed excerpt", reason: "Incorrect").validatedData())
        XCTAssertThrowsError(try ContentReport(kind: "ai", text: "", reason: "Incorrect").validatedData())
        XCTAssertThrowsError(try ContentReport(kind: "ai", text: String(repeating: "😀", count: 4001), reason: "Incorrect").validatedData())
        XCTAssertThrowsError(try ContentReport(kind: "community", contentId: UUID().uuidString.lowercased(), text: "Must not include reply text", reason: "Incorrect").validatedData())
        XCTAssertNoThrow(try ContentReport(kind: "community", contentId: UUID().uuidString.lowercased(), reason: "Incorrect").validatedData())
    }
    func testConnectionReadinessPreservesCustomAPIAndModelChoice() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root)
        XCTAssertEqual(store.settings.connection, "hosted"); XCTAssertFalse(store.connectionReady(store.settings))
        store.settings.connection = "api"; store.settings.baseUrl = "https://fixture.invalid/v1"; store.settings.model = "custom"
        XCTAssertFalse(store.connectionReady(store.settings))
        try Keychain.save("key", for: store.settings.baseUrl); XCTAssertTrue(store.connectionReady(store.settings))
        store.settings.connection = "hosted"; XCTAssertEqual(store.settings.model, "custom"); XCTAssertEqual(store.settings.baseUrl, "https://fixture.invalid/v1")
        store.settings.connection = "api"; store.settings.offline = true; XCTAssertFalse(store.connectionReady(store.settings))
        XCTAssertEqual(ChatGPTConnection.preferredModel(current: "", available: ["other", "gpt-6-luna"]), "gpt-6-luna")
        XCTAssertEqual(ChatGPTConnection.preferredModel(current: "other", available: ["other", "gpt-6-luna"]), "other")
        XCTAssertFalse(try engine.acceptsImages("gpt-6-luna", metadata: #"{"supports_vision":false}"#))
    }
    func testOfflineBrowseUsesLocalizedNamesAndComposition() throws {
        let data = Data(#"{"code":"4006381333931","name":"Base","name_en":"English","name_de":"Deutsch","brands":"Brand","ingredients":"base text","ingredients_en":"oats","ingredients_de":"Hafer","snapshotDate":"2026-10-09T00:00:00Z"}"#.utf8)
        var product = try JSONDecoder().decode(OfflineBrowseProduct.self, from: data)
        XCTAssertEqual(product.record(source: .food, locale: "en").name, "English")
        XCTAssertEqual(product.record(source: .food, locale: "en").composition, "oats")
        XCTAssertEqual(product.record(source: .food, locale: "de").name, "Deutsch")
        XCTAssertEqual(product.record(source: .food, locale: "de").composition, "Hafer")
        product.name_en = ""; product.ingredients_en = nil
        XCTAssertEqual(product.record(source: .food, locale: "en").name, "Base")
        XCTAssertEqual(product.record(source: .food, locale: "en").composition, "base text")
    }
    func testCancellingChatGPTStopsModelRequestAndClearsConnecting() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root); StalledNetworkProtocol.started = nil }
        Network.testProtocolClasses = [StalledNetworkProtocol.self]
        let started = expectation(description: "Model request started")
        let finished = expectation(description: "Connection task finished after cancellation")
        StalledNetworkProtocol.started = started
        let session = ChatGPTSession(clientID: "fixture", subject: "subject", email: "fixture@example.test", idToken: "id", accessToken: "token", refreshToken: "refresh", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date().timeIntervalSince1970 + 3600)
        try Keychain.save(session.jsonString(), for: "https://auth.openai.com")
        let store = try AppStore(root: root)
        var completedModels = false
        let task = Task {
            await store.changeChatGPT {
                _ = try await store.chatGPT.models()
                completedModels = true
            }
            finished.fulfill()
        }
        await fulfillment(of: [started], timeout: 3)
        XCTAssertTrue(store.switchingChatGPT)
        store.cancelChatGPT()
        await fulfillment(of: [finished], timeout: 3)
        await task.value
        XCTAssertFalse(store.switchingChatGPT); XCTAssertFalse(completedModels)
        XCTAssertTrue(store.chatGPT.modelMetadata.isEmpty); XCTAssertNil(store.error)
    }
    func testAccountSwitchStopsOnlyChatGPTAndBlocksEnqueueAndRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root); store.settings.connection = "chatgpt"; store.settings.offline = true
        let chat = CheckJob(input: CheckInput(text: "chat pending"), photos: [], settings: store.settings)
        var apiSettings = Settings(); apiSettings.connection = "api"; apiSettings.offline = true
        let api = CheckJob(input: CheckInput(text: "Ingredients: oats, honey"), photos: [], settings: apiSettings)
        store.jobs = [chat, api]
        await store.changeChatGPT {
            XCTAssertTrue(store.switchingChatGPT)
            XCTAssertEqual(store.jobs.first(where: { $0.id == chat.id })?.status, "cancelled")
            XCTAssertEqual(store.jobs.first(where: { $0.id == api.id })?.status, "queued")
            store.enqueue(input: CheckInput(text: "must not queue")); store.retry(chat.id)
            XCTAssertEqual(store.jobs.count, 2)
            XCTAssertEqual(store.jobs.first(where: { $0.id == chat.id })?.status, "cancelled")
            throw AppError("Replacement sign-in failed")
        }
        XCTAssertFalse(store.switchingChatGPT)
        for _ in 0..<100 { if !store.history.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(store.history.count, 1)
    }
    func testHiddenRepliesPersistAndRestore() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try AppStore(root: root); let id = UUID().uuidString.lowercased(); store.hideReply(id)
        let restored = try AppStore(root: root); XCTAssertTrue(restored.hiddenReplies.contains(id))
        restored.restoreReplies(); XCTAssertTrue(try AppStore(root: root).hiddenReplies.isEmpty)
    }
    func testHostedRefreshAndOfflineDisconnect() async throws {
        Network.testProtocolClasses = [FixtureProtocol.self]
        let base = "https://fixture.invalid"
        let token = String(repeating: "a", count: 64)
        try Keychain.save(token, for: base + "/ios-access")
        let connection = try HostedAIConnection(configuration: ServiceConfiguration(baseUrl: base, model: "fixture"))
        XCTAssertFalse(connection.ready)
        connection.refresh()
        for _ in 0..<100 { if !connection.busy { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(connection.ready); XCTAssertEqual(connection.status?.remaining, 3)
        try connection.disconnect(offline: true)
        XCTAssertFalse(connection.ready); XCTAssertNil(connection.status)
        XCTAssertEqual(try Keychain.read(base + "/ios-access"), "")
    }
    func testRemovingSavedAccountsPreservesUnrelatedSession() throws {
        let issuer = "https://auth.openai.com"
        let active = ChatGPTSession(clientID: "active", subject: "subject", email: "active@example.test", idToken: "id", accessToken: "token", refreshToken: "refresh", scopes: ["chatgpt.tokens.use.direct"], expiresAt: 1999999999)
        try Keychain.save(active.jsonString(), for: issuer)
        try Keychain.save([ChatGPTConnection.Account(id: "active", email: active.email), ChatGPTConnection.Account(id: "other", email: "other@example.test")].jsonString(), for: issuer + "/accounts")
        try Keychain.save("other-subject", for: issuer + "/subject/other")
        let connection = ChatGPTConnection(); connection.loadStatus()
        try connection.removeAccount("other")
        XCTAssertEqual(try ChatGPTConnection.load()?.clientID, "active")
        XCTAssertEqual(connection.accounts.map(\.id), ["active"])
        XCTAssertEqual(try Keychain.read(issuer + "/subject/other"), "")
        try connection.removeAccount("active")
        XCTAssertNil(try ChatGPTConnection.load()); XCTAssertFalse(connection.connected); XCTAssertTrue(connection.accounts.isEmpty)
    }
    func testManufacturerDraftIsLocalAndLocalized() throws {
        struct Args: Encodable { var result: CheckResult; var locale: String }
        let message: ManufacturerMessage? = try engine.call("message", Args(result: analyze("Ingredients: water, E471"), locale: "de"))
        XCTAssertNotNil(message); XCTAssertTrue(message?.body.contains("E471") == true || message?.body.contains("e471") == true)
    }
}

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { ["fixture.invalid", "::1", "[::1]", "world.openfoodfacts.org"].contains(request.url?.host ?? "") }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let content = #"{"text":"Ingredients: water, mystery","complete":true,"category":"food"}"#
        let json: [String: Any] = ["choices": [["finish_reason": "stop", "message": ["content": content]]]]
        let browseData = request.url?.query?.contains("localized-fixture") == true
            ? Data(#"{"products":[{"code":"4006381333931","product_name_de":"","product_name":"Base product","ingredients_text_de":"  ","ingredients_text":"Ingredients: oats"}],"count":1}"#.utf8)
            : Data(#"{"products":[],"count":0}"#.utf8)
        let data = request.url?.host == "world.openfoodfacts.org" ? browseData : request.url?.path == "/api/session" ? Data(#"{"state":"connected","remaining":3,"expiresAt":1999999999999,"enabled":true}"#.utf8) : try! JSONSerialization.data(withJSONObject: json)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "Content-Length": String(data.count)])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class RejectInboxRemoval: FileManager, @unchecked Sendable {
    override func removeItem(at URL: URL) throws { throw CocoaError(.fileWriteNoPermission) }
}

private final class StalledNetworkProtocol: URLProtocol, @unchecked Sendable {
    static var started: XCTestExpectation?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.started?.fulfill() }
    override func stopLoading() {}
}
