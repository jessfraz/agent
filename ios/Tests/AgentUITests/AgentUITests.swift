import UIKit
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
    // XCTest removes this monitor at test completion. Handle only Agent's
    // native permission prompt, leaving unexpected system alerts as failures.
    addUIInterruptionMonitor(withDescription: "Agent notification permission") { alert in
      guard alert.label == "“Agent” Would Like to Send You Notifications",
        alert.buttons["Allow"].exists
      else { return false }
      let receipt = XCTAttachment(screenshot: alert.screenshot())
      receipt.name = "notification-permission-allowed"
      receipt.lifetime = .keepAlways
      self.add(receipt)
      alert.buttons["Allow"].tap()
      XCTAssertTrue(alert.waitForNonExistence(timeout: 3))
      return true
    }
    if let appearance { XCUIDevice.shared.appearance = appearance == .dark ? .dark : .light }
    app.launch()
    if !app.navigationBars["Connection"].waitForExistence(timeout: 3) {
      app.buttons["Connection"].tap()
    }
    XCTAssertTrue(app.navigationBars["Connection"].waitForExistence(timeout: 5))
    // Interruption monitors run on interaction, not on existence queries.
    app.navigationBars["Connection"].tap()
    if let appearance {
      chooseAppearance(appearance.rawValue, app: app)
      assertBackground(appearance, app: app)
    }
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

  func testTranscriptDragDismissesKeyboardWithoutLosingDraft() {
    let app = launch()
    app.buttons["Done"].tap()
    let composer = app.descendants(matching: .any).matching(
      identifier: "Message the coordinator"
    ).firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    composer.tap()
    let draft = "Synthetic draft survives a transcript drag."
    composer.typeText(draft)
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
    XCTAssertTrue(app.staticTexts["No messages yet"].exists)
    let transcript = app.scrollViews.containing(.staticText, identifier: "No messages yet")
      .firstMatch
    XCTAssertTrue(transcript.waitForExistence(timeout: 3))
    capture("transcript-before-drag", app: app)
    // The scroll view's accessibility frame includes the overlaid composer.
    // Start in visible transcript content and pull through the keyboard.
    let start = transcript.staticTexts["No messages yet"].coordinate(
      withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    let end = app.keyboards.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
    start.press(forDuration: 0.05, thenDragTo: end)
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
    XCTAssertEqual(composer.value as? String, draft)
    XCTAssertTrue(app.staticTexts["No messages yet"].exists)
    XCTAssertFalse(app.buttons["Send message"].isEnabled)
    capture("transcript-drag-preserves-draft", app: app)
  }

  func testAppearanceExplicitOverridesPersistAcrossRelaunch() {
    let previous = XCUIDevice.shared.appearance
    defer { XCUIDevice.shared.appearance = previous }
    let app = launch(appearance: .dark)
    executionTimeAllowance = 120
    chooseAppearance("Light", app: app)
    app.buttons["Done"].tap()
    assertBackground(.light, app: app)
    capture("explicit-light-appearance", app: app)

    let composer = app.descendants(matching: .any).matching(
      identifier: "Message the coordinator"
    ).firstMatch
    let draft = "Synthetic draft survives appearance changes."
    composer.tap()
    composer.typeText(draft)
    XCUIDevice.shared.appearance = .light
    app.buttons["Connection"].tap()
    chooseAppearance("Dark", app: app)
    app.buttons["Done"].tap()
    assertBackground(.dark, app: app)
    XCTAssertEqual(composer.value as? String, draft)
    capture("explicit-dark-appearance", app: app)

    app.terminate()
    app.launch()
    XCTAssertTrue(app.navigationBars["Connection"].waitForExistence(timeout: 5))
    app.buttons["Done"].tap()
    assertBackground(.dark, app: app)
    app.buttons["Connection"].tap()
    chooseAppearance("System", app: app)
    app.buttons["Done"].tap()
    assertBackground(.light, app: app)
  }

  private func chooseAppearance(_ label: String, app: XCUIApplication) {
    let picker = app.descendants(matching: .any).matching(identifier: "appearancePicker").firstMatch
    XCTAssertTrue(picker.waitForExistence(timeout: 3))
    picker.tap()
    let choice = app.buttons[label]
    XCTAssertTrue(choice.waitForExistence(timeout: 3))
    choice.tap()
  }

  private func assertBackground(
    _ appearance: Appearance, app: XCUIApplication, file: StaticString = #filePath,
    line: UInt = #line
  ) {
    var lastScreenshot: XCUIScreenshot?
    var lastBrightness: Double?
    let predicate = NSPredicate { [self] _, _ in
      let screenshot = app.screenshot()
      lastScreenshot = screenshot
      lastBrightness = screenshot.image.cgImage.flatMap(backgroundBrightness)
      guard let brightness = lastBrightness else { return false }
      return appearance == .light ? brightness > 0.8 : brightness < 0.2
    }
    let rendered = XCTNSPredicateExpectation(predicate: predicate, object: nil)
    let result = XCTWaiter.wait(for: [rendered], timeout: 3)
    if result != .completed, let lastScreenshot {
      let receipt = XCTAttachment(screenshot: lastScreenshot)
      receipt.name = "\(appearance.rawValue.lowercased())-background-failure"
      receipt.lifetime = .keepAlways
      add(receipt)
    }
    let measured = lastBrightness.map { String(format: "%.3f", $0) } ?? "unavailable"
    XCTAssertEqual(
      result, .completed,
      "Expected \(appearance.rawValue) background; median brightness: \(measured)",
      file: file, line: line)
  }

  nonisolated private func backgroundBrightness(_ image: CGImage) -> Double? {
    guard
      let sample = image.cropping(
        to: CGRect(
          x: Double(image.width) * 0.08, y: Double(image.height) * 0.25,
          width: Double(image.width) * 0.84, height: Double(image.height) * 0.4))
    else { return nil }
    // Text can cover any particular point. The central region's median keeps
    // foreground glyphs, icons and separators from deciding its appearance.
    let side = 32
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    return pixels.withUnsafeMutableBytes { bytes -> Double? in
      guard
        let context = CGContext(
          data: bytes.baseAddress, width: side, height: side, bitsPerComponent: 8,
          bytesPerRow: side * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            | CGBitmapInfo.byteOrder32Big.rawValue)
      else { return nil }
      context.interpolationQuality = .none
      context.draw(sample, in: CGRect(x: 0, y: 0, width: side, height: side))
      let values = bytes.bindMemory(to: UInt8.self)
      let brightness = stride(from: 0, to: values.count, by: 4).map { offset in
        Double(Int(values[offset]) + Int(values[offset + 1]) + Int(values[offset + 2])) / 765
      }.sorted()
      return brightness[brightness.count / 2]
    }
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
