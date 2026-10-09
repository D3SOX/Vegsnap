import XCTest
import UIKit

@MainActor final class VegsnapUITests: XCTestCase {
    let app = XCUIApplication()
    override func setUpWithError() throws { continueAfterFailure = false }
    func launch(language: String = "en", reset: Bool = true) {
        app.launchArguments = ["--ui-testing", "-AppleLanguages", "(\(language))", "-AppleLocale", language == "de" ? "de_DE" : "en_US"] + (reset ? ["--reset"] : [])
        app.launch()
        if reset && app.buttons["getStarted"].waitForExistence(timeout: 20) { app.buttons["getStarted"].tap() }
        if !app.textFields["productName"].exists { app.swipeUp() }
        XCTAssertTrue(app.textFields["productName"].waitForExistence(timeout: 20))
    }
    func capture(_ name: String) { let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment) }
    func selectTab(_ name: String) {
        let tab = app.tabBars.buttons[name]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tab.exists && tab.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed, "Tab is not ready: \(name)")
        // A busy simulator can drop a tap during a tab-bar transition. Retry only
        // when the requested tab has not become selected; screen assertions still run once.
        for _ in 0..<2 {
            if tab.isSelected { return }
            tab.tap()
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tab.isSelected }, object: nil)
            if XCTWaiter.wait(for: [selected], timeout: 10) == .completed { return }
        }
        XCTFail("Tab did not become selected: \(name)")
    }
    func rotate(_ orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frame = self.app.frame
            return (frame.width > frame.height) == orientation.isLandscape
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 30), .completed)
        // Window geometry changes before the system rotation animation finishes.
        Thread.sleep(forTimeInterval: 1)
    }
    func testCheckHistoryAndRelaunch() {
        launch(); capture("check-light")
        app.textFields["productName"].tap(); app.textFields["productName"].typeText("Honey granola")
        if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        let text = app.descendants(matching: .any).matching(identifier: "ingredients").firstMatch
        reveal(text, forTap: true); text.tap(); text.typeText("Ingredients: oats, honey, salt")
        if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        reveal(app.buttons["checkProduct"], forTap: true); app.buttons["checkProduct"].tap()
        XCTAssertTrue(app.staticTexts["Not vegan"].waitForExistence(timeout: 20)); capture("result-light")
        app.navigationBars.buttons["Done"].tap()
        selectTab("History"); XCTAssertTrue(app.staticTexts["Honey granola"].waitForExistence(timeout: 10)); capture("history-light")
        app.terminate(); launch(reset: false)
        selectTab("History"); XCTAssertTrue(app.staticTexts["Honey granola"].waitForExistence(timeout: 10))
    }
    func testDraftPersistsAndBarcodeValidation() {
        launch()
        let barcode = app.textFields["barcode"]
        reveal(barcode, forTap: true); barcode.tap(); barcode.typeText("12345678")
        if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        app.swipeUp(); app.buttons["checkProduct"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10)); app.alerts.buttons["OK"].tap()
        app.terminate(); launch(reset: false)
        XCTAssertEqual(app.textFields["barcode"].value as? String, "12345678")
    }
    func testBrowseOfflineAndSettings() {
        launch(); selectTab("Browse")
        XCTAssertTrue(app.textFields["browseQuery"].waitForExistence(timeout: 10))
        app.textFields["browseQuery"].tap(); app.textFields["browseQuery"].typeText("Quaker Oats\n")
        XCTAssertTrue(app.staticTexts["Quaker Oats"].firstMatch.waitForExistence(timeout: 10))
        capture("browse-light")
        selectTab("Settings"); XCTAssertTrue(app.switches["offlineMode"].waitForExistence(timeout: 10)); capture("settings-light")
    }
    func reveal(_ element: XCUIElement, scrollingDown: Bool = false, forTap: Bool = false) {
        for _ in 0..<8 {
            if element.exists && (!forTap || element.isHittable) { return }
            if scrollingDown { app.swipeDown() } else { app.swipeUp() }
        }
        XCTAssertTrue(element.exists)
        if forTap { XCTAssertTrue(element.isHittable) }
    }
    func chooseConnection(_ name: String) {
        let picker = app.buttons["connectionPicker"]
        reveal(picker, scrollingDown: true, forTap: true); picker.tap()
        app.buttons[name].firstMatch.tap()
    }
    func testConnectionChoicesAndOfflineGates() {
        launch(); selectTab("Settings")
        reveal(app.buttons["Connect to free AI"])
        XCTAssertFalse(app.buttons["Connect to free AI"].isEnabled)
        chooseConnection("ChatGPT")
        reveal(app.buttons["Connect ChatGPT"])
        XCTAssertFalse(app.buttons["Connect ChatGPT"].isEnabled)
        reveal(app.switches["Show account emails"], scrollingDown: true)
        capture("chatgpt-settings")
        chooseConnection("API key or local model")
        reveal(app.textFields["API endpoint"])
        let original = app.textFields["API endpoint"].value as? String
        chooseConnection("Vegsnap AI (free)")
        reveal(app.buttons["Connect to free AI"])
        chooseConnection("API key or local model")
        reveal(app.textFields["API endpoint"])
        XCTAssertEqual(app.textFields["API endpoint"].value as? String, original)
    }
    func testAccessibilityLayout() {
        launch(); capture("adaptive-check")
        selectTab("Settings")
        XCTAssertTrue(app.switches["offlineMode"].waitForExistence(timeout: 10)); capture("adaptive-settings")
        selectTab("History"); capture("adaptive-history")
        rotate(.landscapeLeft); capture("adaptive-landscape")
        rotate(.portrait)
    }
    func testGermanAndLandscape() {
        launch(language: "de"); XCTAssertTrue(app.buttons["Verlauf"].firstMatch.exists); capture("check-german")
        rotate(.landscapeLeft); capture("check-landscape")
        rotate(.portrait)
    }
}
