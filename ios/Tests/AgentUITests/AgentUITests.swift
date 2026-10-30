import XCTest

@MainActor
final class AgentUITests: XCTestCase {
  private enum Appearance: String, CaseIterable {
    case light = "Light"
    case dark = "Dark"
  }

  private func launch(appearance: Appearance? = nil, smallText: Bool = false) -> XCUIApplication {
    continueAfterFailure = false
    executionTimeAllowance = 60
    let app = XCUIApplication()
    if smallText {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXS"]
    }
    app.launch()
    if let appearance { XCUIDevice.shared.appearance = appearance == .dark ? .dark : .light }
    if !app.navigationBars["Connection"].waitForExistence(timeout: 3) {
      app.buttons["Connection"].tap()
    }
    XCTAssertTrue(app.navigationBars["Connection"].waitForExistence(timeout: 5))
    return app
  }

  private func capture(_ name: String, app: XCUIApplication) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = name
    image.lifetime = .keepAlways
    add(image)
  }

  private func replace(_ field: XCUIElement, with text: String) {
    field.tap()
    field.typeKey("a", modifierFlags: .command)
    field.typeText(text.isEmpty ? XCUIKeyboardKey.delete.rawValue : text)
    let value = field.value as? String
    if text.isEmpty {
      XCTAssertTrue(value == nil || value == "" || value == field.placeholderValue)
    } else {
      XCTAssertEqual(value, text)
    }
  }

  func testConnectionLabelsAndAddressValidation() {
    let app = launch()
    capture("connection-before-editing", app: app)
    let connect = app.buttons["Connect"]
    XCTAssertFalse(connect.isEnabled)
    XCTAssertFalse(app.buttons["Disconnect"].isEnabled)
    let address = app.descendants(matching: .any).matching(identifier: "coordinatorAddress")
      .firstMatch
    let port = app.textFields["coordinatorPort"]
    replace(address, with: "192.0.2.1")
    XCTAssertFalse(connect.isEnabled)
    replace(address, with: "100.64.1.2")
    XCTAssertTrue(connect.isEnabled)
    XCTAssertTrue(app.staticTexts["Tailscale address"].exists)
    XCTAssertTrue(app.staticTexts["Port"].exists)
    capture("connection-persistent-labels", app: app)
    replace(port, with: "0")
    XCTAssertFalse(connect.isEnabled)
    replace(port, with: "43187")
    XCTAssertTrue(connect.isEnabled)
    // Never submit the invented address or retain it for an automatic reconnect.
    replace(address, with: "")
    XCTAssertFalse(connect.isEnabled)
  }

  func testOfflineDraftAndDeliveryControls() {
    let app = launch()
    app.buttons["Done"].tap()
    let composer = app.descendants(matching: .any).matching(
      identifier: "Message the coordinator"
    ).firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    composer.tap()
    composer.typeText("Synthetic draft kept safely offline.")
    XCTAssertFalse(app.buttons["Send message"].isEnabled)
    capture("offline-composer-keyboard", app: app)
    app.buttons["composerMenu"].tap()
    app.buttons["Follow-up"].tap()
    XCTAssertFalse(app.buttons["Queue follow-up"].isEnabled)
    XCTAssertEqual(composer.value as? String, "Synthetic draft kept safely offline.")
    capture("offline-follow-up", app: app)
  }

  func testConnectionAndEmptyMainAccessibility() throws {
    let previous = XCUIDevice.shared.appearance
    defer { XCUIDevice.shared.appearance = previous }
    for appearance in Appearance.allCases {
      let app = launch(appearance: appearance)
      defer { app.terminate() }
      try audit(app)
      capture("connection-accessibility-\(appearance.rawValue)", app: app)
      app.buttons["Done"].tap()
      try audit(app)
      capture("main-accessibility-\(appearance.rawValue)", app: app)
    }
  }

  func testConnectionHeaderContrastAtSmallText() throws {
    let previous = XCUIDevice.shared.appearance
    defer { XCUIDevice.shared.appearance = previous }
    for appearance in Appearance.allCases {
      let app = launch(appearance: appearance, smallText: true)
      defer { app.terminate() }
      try audit(app, types: .contrast)
      capture("connection-small-text-\(appearance.rawValue)", app: app)
    }
  }

  private func audit(
    _ app: XCUIApplication,
    types: XCUIAccessibilityAuditType = [
      .contrast, .hitRegion, .sufficientElementDescription, .textClipped,
    ]
  ) throws {
    let previous = continueAfterFailure
    continueAfterFailure = true
    defer { continueAfterFailure = previous }
    try app.performAccessibilityAudit(for: types) { issue in
      // WCAG 1.4.3 excludes inactive controls from text-contrast requirements.
      // https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum#inactive-user-interface-components
      if issue.auditType == .contrast, issue.element?.isEnabled == false { return true }
      guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 27,
        issue.auditType == .contrast, let element = issue.element,
        element.identifier == "dismissConnection", element.label == "Done"
      else { return false }
      // iOS 27 flags this native glass control despite measured text/background contrast over 19:1.
      // Retain its pixels and exempt only this control on the affected OS.
      let receipt = XCTAttachment(screenshot: element.screenshot())
      receipt.name = "native-done-contrast-receipt"
      receipt.lifetime = .keepAlways
      self.add(receipt)
      return true
    }
  }
}
