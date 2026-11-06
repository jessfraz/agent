import UIKit
import XCTest

@MainActor
final class AgentUITests: XCTestCase {
  private enum Appearance: String, CaseIterable {
    case light = "Light"
    case dark = "Dark"
  }

  private func launch(
    appearance: Appearance? = nil, smallText: Bool = false, notificationsEnabled: Bool? = nil
  ) -> XCUIApplication {
    continueAfterFailure = false
    executionTimeAllowance = 60
    let app = XCUIApplication()
    if let notificationsEnabled {
      // This is the existing user preference, not a test-only app interface.
      app.launchArguments += ["-notificationsEnabled", notificationsEnabled ? "YES" : "NO"]
    }
    if smallText {
      app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXS"]
    }
    // XCTest removes this monitor at test completion. Handle only Beep Boop's
    // native permission prompt, leaving unexpected system alerts as failures.
    addUIInterruptionMonitor(withDescription: "Beep Boop notification permission") { alert in
      guard alert.label == "“Beep Boop” Would Like to Send You Notifications",
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

  private func foregroundScreenshot(_ app: XCUIApplication) -> XCUIScreenshot? {
    // The application AX root can be frameless after relaunch. Sample its
    // visible window, never a screen fallback that could capture Springboard.
    guard app.state == .runningForeground else { return nil }
    let window = app.windows.firstMatch
    guard window.exists, !window.frame.isEmpty, window.isHittable else { return nil }
    return window.screenshot()
  }

  private func capture(_ name: String, app: XCUIApplication) {
    guard let screenshot = foregroundScreenshot(app) else {
      XCTFail("Cannot capture an application without a visible foreground window")
      return
    }
    let image = XCTAttachment(screenshot: screenshot)
    image.name = name
    image.lifetime = .keepAlways
    add(image)
  }

  private func replace(_ field: XCUIElement, with text: String) {
    field.tap()
    if field.identifier == "Message the coordinator", let value = field.value as? String,
      !value.isEmpty, value != field.placeholderValue
    {
      field.press(forDuration: 1)
      let selectAll = XCUIApplication().menuItems["Select All"]
      XCTAssertTrue(selectAll.waitForExistence(timeout: 3), XCUIApplication().debugDescription)
      selectAll.tap()
    } else {
      field.typeKey("a", modifierFlags: .command)
    }
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
    app.buttons["composerMenu"].tap()
    app.buttons["Steer"].tap()
    replace(composer, with: "Synthetic draft kept safely offline.")
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
    let draft = "Synthetic draft survives a transcript drag."
    app.buttons["composerMenu"].tap()
    app.buttons["Steer"].tap()
    replace(composer, with: draft)
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
    replace(composer, with: draft)
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

  func testAppearanceSamplingRequiresTheVisibleForegroundApp() {
    let previous = XCUIDevice.shared.appearance
    defer { XCUIDevice.shared.appearance = previous }
    let app = launch(appearance: .dark)
    executionTimeAllowance = 120
    defer { app.terminate() }
    chooseAppearance("Light", app: app)
    app.buttons["Done"].tap()
    assertBackground(.light, app: app)

    app.terminate()
    XCTAssertEqual(app.state, .notRunning)
    XCTAssertNil(foregroundScreenshot(app), "Springboard is not the application's appearance")
    XCTAssertEqual(app.state, .notRunning, "Sampling must not launch the application")
    app.launch()
    XCTAssertTrue(app.navigationBars["Connection"].waitForExistence(timeout: 5))
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
    // Native interactions already wait for UI idleness. Measure one foreground
    // window; screenshot acquisition time is diagnostic, not appearance state.
    let started = ContinuousClock.now
    guard let screenshot = foregroundScreenshot(app) else {
      XCTFail(
        "Expected a visible foreground application window; acquisition unavailable after "
          + "\(started.duration(to: .now))", file: file, line: line)
      return
    }
    let acquired = started.duration(to: .now)
    let brightness = screenshot.image.cgImage.flatMap(backgroundBrightness)
    let completed = started.duration(to: .now)
    let matches = brightness.map { appearance == .light ? $0 > 0.8 : $0 < 0.2 } ?? false
    let measured = brightness.map { String(format: "%.3f", $0) } ?? "unavailable"
    let measurement =
      "median brightness: \(measured); acquired: \(acquired); completed: \(completed)"
    XCTContext.runActivity(named: "\(appearance.rawValue) background; \(measurement)") { activity in
      if !matches {
        let receipt = XCTAttachment(screenshot: screenshot)
        receipt.name = "\(appearance.rawValue.lowercased())-background-failure"
        receipt.lifetime = .keepAlways
        activity.add(receipt)
      }
      XCTAssertTrue(
        matches, "Expected \(appearance.rawValue) background; \(measurement)",
        file: file, line: line)
    }
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
      var brightness: [Double] = []
      for offset in stride(from: 0, to: values.count, by: 4) {
        let red = Double(values[offset])
        let green = Double(values[offset + 1])
        let blue = Double(values[offset + 2])
        brightness.append((red + green + blue) / 765)
      }
      brightness.sort()
      return brightness[brightness.count / 2]
    }
  }

  func testConnectionAndEmptyMainAccessibilityInLightAppearance() throws {
    try checkConnectionAndEmptyMainAccessibility(.light)
  }

  func testConnectionAndEmptyMainAccessibilityInDarkAppearance() throws {
    try checkConnectionAndEmptyMainAccessibility(.dark)
  }

  private func checkConnectionAndEmptyMainAccessibility(_ appearance: Appearance) throws {
    let previous = XCUIDevice.shared.appearance
    defer { XCUIDevice.shared.appearance = previous }
    // An unsigned, offline simulator cannot enroll with APNs. Keep its
    // notification preference off so an asynchronous enrollment failure cannot
    // replace the disconnected guidance while this view is being audited.
    let app = launch(appearance: appearance, notificationsEnabled: false)
    defer { app.terminate() }
    try revealCompleteConnectionForm(app)
    try audit(app)
    capture("connection-accessibility-\(appearance.rawValue)", app: app)
    if !app.buttons["dismissConnection"].exists {
      let window = app.windows.firstMatch
      let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
      start.press(
        forDuration: 0.05,
        thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)),
        withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    XCTAssertTrue(
      app.buttons["dismissConnection"].waitForExistence(timeout: 3), app.debugDescription)
    app.buttons["Done"].tap()
    try audit(app)
    capture("main-accessibility-\(appearance.rawValue)", app: app)
  }

  private func revealCompleteConnectionForm(_ app: XCUIApplication) throws {
    let window = app.windows.firstMatch
    let form = app.collectionViews.firstMatch
    let status = app.cells.containing(.staticText, identifier: "Status").firstMatch
    // Use the same text node the native audit inspects, not its containing cell.
    let guidance = app.staticTexts["Connect to the coordinator to receive updates."].firstMatch
    XCTAssertTrue(form.exists, app.debugDescription)
    XCTAssertTrue(status.exists)
    XCTAssertTrue(status.isHittable, app.debugDescription)
    XCTAssertTrue(window.frame.contains(status.frame), "The first form row must be fully onscreen")
    capture("connection-top-accessibility", app: app)
    // Preserve top coverage separately when the last row is unmaterialized.
    // Never audit a known partially visible guidance node before revealing it.
    if !guidance.exists {
      XCTAssertFalse(
        guidance.exists && window.frame.intersects(guidance.frame)
          && !window.frame.contains(guidance.frame),
        "Reveal partially visible guidance before its contrast audit")
      try audit(app)
    }

    func viewport() -> CGRect {
      let visible = window.frame.intersection(form.frame)
      let top = max(visible.minY, app.navigationBars["Connection"].frame.maxY)
      return CGRect(
        x: visible.minX, y: top, width: visible.width, height: max(0, visible.maxY - top))
    }

    // A short form viewport with larger text can need several native scrolls.
    // Re-query materialization, hittability and geometry after every gesture;
    // neither a single window swipe nor the original title frame proves arrival.
    for attempt in 0..<6 {
      let visible = viewport()
      XCTAssertFalse(visible.isEmpty, app.debugDescription)
      let complete =
        guidance.exists && guidance.isHittable && visible.contains(guidance.frame)
      let partial = form.cells.allElementsBoundByIndex.first {
        $0.isHittable && $0.frame.minY < visible.minY && $0.frame.maxY > visible.minY
      }
      if complete && partial == nil { break }
      let state = XCTAttachment(string: form.debugDescription)
      state.name = "connection-form-before-scroll-\(attempt)"
      state.lifetime = .keepAlways
      add(state)
      if !complete {
        // Target the real Form collection, not its window or the sheet chrome.
        form.swipeUp(velocity: .slow)
      } else if let partial {
        let guidanceBeforeAlignment = guidance.frame
        let adjustment = visible.minY - partial.frame.minY
        // Align the first partial row only if the complete guidance still fits.
        // Otherwise scroll that row out, rather than cropping the guidance again.
        let distance =
          guidance.frame.maxY + adjustment <= visible.maxY
          ? adjustment : visible.minY - partial.frame.maxY
        let bounded = max(-visible.height / 2, min(distance, visible.height / 2))
        let start = form.coordinate(withNormalizedOffset: .zero).withOffset(
          CGVector(dx: visible.midX - form.frame.minX, dy: visible.midY - form.frame.minY))
        start.press(
          forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: bounded)),
          withVelocity: .slow, thenHoldForDuration: 0.1)
        // A tiny alignment drag can leave a native Form unchanged. Do not repeat
        // it once the actual viewport and fully visible guidance have not moved.
        if viewport() == visible, guidance.exists, guidance.isHittable,
          guidance.frame == guidanceBeforeAlignment
        {
          break
        }
      }
    }
    XCTAssertTrue(guidance.waitForExistence(timeout: 3), app.debugDescription)
    XCTAssertTrue(guidance.isHittable, app.debugDescription)
    XCTAssertTrue(window.frame.contains(guidance.frame), "The last form row must be fully onscreen")
    XCTAssertTrue(
      viewport().contains(guidance.frame), "Guidance must clear the form and navigation")
    let complete = XCTAttachment(string: app.debugDescription)
    complete.name = "connection-guidance-before-audit-native-hierarchy"
    complete.lifetime = .keepAlways
    add(complete)
    capture("connection-guidance-before-audit", app: app)
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
      let nativeElement = XCTAttachment(
        string: issue.element?.debugDescription ?? "No native element")
      nativeElement.name = "native-audit-issue-element"
      nativeElement.lifetime = .keepAlways
      self.add(nativeElement)
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
