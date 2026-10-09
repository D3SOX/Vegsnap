import XCTest
@testable import Vegsnap

@MainActor final class CommunityRepliesTests: XCTestCase {
    var engine: CoreEngine!
    override func setUp() async throws {
        engine = try CoreEngine()
        Network.testProtocolClasses = [CommunityFixtureProtocol.self]
        CommunityFixtureProtocol.requests = []; CommunityFixtureProtocol.body = #"{"replies":[],"more":false}"#
    }
    override func tearDown() async throws { Network.testProtocolClasses = nil }
    func original(_ text: String = "Ingredients: water, mystery") throws -> CheckResult {
        try engine.call("analyze", CheckInput(text: text, barcode: "4006381333931", name: "Lemon", brand: "Fun Light", category: .drink, market: "SE"))
    }
    func response(candidate: Bool = false, more: Bool = false) -> String {
        let reply = #"{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","productName":"Lemon","brand":"Fun Light","barcode":"04006381333931","market":"SE","variant":"","question":"Is it vegan?","reply":"All our Fun Light products are vegan.","repliedOn":"2026-01-10","claim":"vegan","scope":"whole_product","sourceUrl":"","reviewedAt":"2026-01-11T00:00:00Z","evidencePublic":false}"#
        return candidate ? "{\"replies\":[],\"candidates\":[\(reply)],\"more\":\(more)}" : "{\"replies\":[\(reply)],\"more\":\(more)}"
    }
    func testLookupUpdatesDisplayPreservesOriginalAndSendsIdentityOnly() async throws {
        let original = try original(); let state = CommunityRepliesState()
        CommunityFixtureProtocol.body = response()
        await state.load(original, engine: engine, locale: "en", offline: false)
        let request = try XCTUnwrap(CommunityFixtureProtocol.requests.first)
        let params = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        XCTAssertEqual(params, ["barcode":"04006381333931","name":"Lemon","brand":"Fun Light","market":"SE"])
        XCTAssertNil(request.httpBody); XCTAssertNil(request.value(forHTTPHeaderField: "Authorization")); XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let displayed = state.displayResult(original, engine: engine, locale: "en", hidden: [])
        XCTAssertEqual(displayed.outcome, .vegan); XCTAssertEqual(displayed.basis, "manufacturer")
        XCTAssertEqual(displayed.outcomeLabel, "Manufacturer says vegan"); XCTAssertEqual(original.outcome, .uncertain)
        XCTAssertEqual(displayed.evidence.last?.verification, "unverified")
        XCTAssertEqual(state.displayResult(original, engine: engine, locale: "en", hidden: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).outcome, .uncertain)
        CommunityFixtureProtocol.body = #"{"replies":[],"more":false}"#
        await state.load(original, engine: engine, locale: "en", offline: false)
        XCTAssertEqual(state.displayResult(original, engine: engine, locale: "en", hidden: []).outcome, .uncertain)
    }
    func testRangeNeedsConfirmationAndCannotOverrideAnimalEvidence() async throws {
        let original = try original(); let state = CommunityRepliesState()
        CommunityFixtureProtocol.body = response(candidate: true)
        await state.load(original, engine: engine, locale: "en", offline: false)
        XCTAssertEqual(state.displayResult(original, engine: engine, locale: "en", hidden: []).outcome, .uncertain)
        state.confirmed.insert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        XCTAssertEqual(state.displayResult(original, engine: engine, locale: "en", hidden: []).outcome, .vegan)
        let animal = try self.original("Ingredients: water, honey")
        XCTAssertEqual(state.displayResult(animal, engine: engine, locale: "en", hidden: []).outcome, .conflicting)
    }
    func testIncompleteLookupAndOfflineRetainOriginalVerdict() async throws {
        let original = try original(); let state = CommunityRepliesState()
        CommunityFixtureProtocol.body = response(more: true)
        await state.load(original, engine: engine, locale: "en", offline: false)
        XCTAssertEqual(state.displayResult(original, engine: engine, locale: "en", hidden: []).outcome, .uncertain)
        await state.load(original, engine: engine, locale: "en", offline: true)
        XCTAssertEqual(CommunityFixtureProtocol.requests.count, 1); XCTAssertNil(state.page)
    }
    func testCountryCorrectionDropsOldEvidenceUntilFreshLookup() async throws {
        let original = try original(); let state = CommunityRepliesState()
        CommunityFixtureProtocol.body = response()
        await state.load(original, engine: engine, locale: "en", offline: false)
        XCTAssertEqual(state.displayResult(original, engine: engine, locale: "en", hidden: []).basis, "manufacturer")
        var corrected = original; corrected.identity.market = "DE"
        XCTAssertEqual(state.displayResult(corrected, engine: engine, locale: "en", hidden: []).outcome, .uncertain)
        CommunityFixtureProtocol.body = #"{"replies":[],"more":false}"#
        await state.load(corrected, engine: engine, locale: "en", offline: false)
        let request = try XCTUnwrap(CommunityFixtureProtocol.requests.last)
        XCTAssertTrue(request.url!.absoluteString.contains("market=DE"))
        XCTAssertEqual(state.displayResult(corrected, engine: engine, locale: "en", hidden: []).outcome, .uncertain)
    }
    func testMalformedResponseAndCancelledLookupCannotPublishEvidence() async throws {
        let original = try original(); let state = CommunityRepliesState()
        CommunityFixtureProtocol.body = response().replacingOccurrences(of: "whole_product", with: "unreviewed_scope")
        await state.load(original, engine: engine, locale: "en", offline: false)
        XCTAssertNil(state.page); XCTAssertNotNil(state.failure)
        CommunityFixtureProtocol.body = response()
        let task = Task { await state.load(original, engine: engine, locale: "en", offline: false) }
        task.cancel(); await task.value
        XCTAssertNil(state.page)
    }
}

private final class CommunityFixtureProtocol: URLProtocol, @unchecked Sendable {
    static var requests: [URLRequest] = []
    static var body = ""
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let data = Data(Self.body.utf8)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json","Content-Length":String(data.count)])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
