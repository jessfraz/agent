#if os(macOS) || AGENT_APP_HOST
  import CoreGraphics
  import SwiftUI
  import Testing

  @testable import AgentCore
  @testable import AgentUI

  #if os(iOS)
    import UIKit
  #else
    import AppKit
  #endif

  @MainActor private func renderRows(
    _ rows: [ChatRow], size: DynamicTypeSize = .large, scheme: ColorScheme = .light
  ) throws -> CGImage {
    let models = rows.map(RowModel.init)
    let content = VStack(alignment: .leading, spacing: 22) {
      ForEach(models) { model in
        MessageRow(model: model, retry: { _ in }, restore: { _ in })
      }
    }
    .padding(16)
    .frame(width: 390)
    .environment(\.dynamicTypeSize, size)
    .environment(\.colorScheme, scheme)
    .background(.background)
    // Capture the native hierarchy: ImageRenderer omits platform-backed
    // controls and scroll views, which contain the code blocks and tables.
    #if os(iOS)
      let host = UIHostingController(rootView: content)
      let dimensions = host.sizeThatFits(
        in: CGSize(width: 390, height: CGFloat.greatestFiniteMagnitude))
      #expect(dimensions.width == 390)
      let scene = try #require(
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
      let previousWindow = scene.windows.first(where: \.isKeyWindow)
      let window = UIWindow(windowScene: scene)
      window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
      // A scene resizes its root view to the device. Keep the measured view
      // as a fixed-size child so narrow captures retain their leading edge.
      let container = UIViewController()
      window.rootViewController = container
      window.makeKeyAndVisible()
      defer {
        window.isHidden = true
        previousWindow?.makeKey()
      }
      window.layoutIfNeeded()
      container.addChild(host)
      container.view.addSubview(host.view)
      host.view.frame = CGRect(origin: .zero, size: dimensions)
      host.didMove(toParent: container)
      host.view.layoutIfNeeded()
      #expect(host.view.bounds.size == dimensions)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let image = UIGraphicsImageRenderer(size: dimensions, format: format).image { _ in
        #expect(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
      }
      return try #require(image.cgImage)
    #else
      let view = NSHostingView(rootView: content)
      view.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
      view.setFrameSize(view.fittingSize)
      #expect(view.frame.width == 390)
      view.layoutSubtreeIfNeeded()
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.effectiveAppearance.performAsCurrentDrawingAppearance {
        view.cacheDisplay(in: view.bounds, to: bitmap)
      }
      return try #require(bitmap.cgImage)
    #endif
  }

  @MainActor @Test func supportedMessageRowsRenderInLightAndDarkAppearance() throws {
    var transcript = Transcript()
    let roles: [HistoryRole] = [
      .user, .assistant, .commentary, .partialAnswer, .final, .notice, .thinking,
    ]
    for role in roles {
      transcript.message(
        .init(
          continuation: false, entryId: role.rawValue, finalChunk: true, role: role,
          text: "A **useful** message with `inline code` and a [link](https://example.invalid).",
          tool: nil))
    }
    for status in [ToolStatus.running, .finished, .failed] {
      transcript.message(
        .init(
          continuation: false, entryId: "tool-\(status.rawValue)", finalChunk: true, role: .tool,
          text: "Build the native client",
          tool: .init(callId: status.rawValue, name: "build", status: status)))
    }
    transcript.message(
      .init(
        continuation: false, entryId: "rich-answer", finalChunk: true, role: .final,
        text: """
          # Native rendering

          > A quoted update.

          ```swift
          let message = "Hello 🦀"
          ```

          | Check | Result |
          | --- | --- |
          | Build | Passed |
          """, tool: nil))
    for delivery in [Delivery.uncertain, .rejected] {
      transcript.pending(
        .init(inputId: UUID().uuidString, mode: .steer, text: "Keep this original message"),
        delivery: delivery)
    }
    for scheme in [ColorScheme.light, .dark] {
      let image = try renderRows(transcript.rows, scheme: scheme)
      #expect(image.width >= 390)
      #expect(image.height > 600)
      Attachment.record(image, named: "message-rows-\(scheme)", as: .png)
    }
    let accessible = try renderRows(transcript.rows, size: .accessibility3)
    #expect(accessible.width >= 390)
    Attachment.record(accessible, named: "message-rows-accessibility", as: .png)
  }

  #if os(iOS)
    @MainActor @Test func accessibilityTextSizeExpandsMessageLayout() throws {
      var transcript = Transcript()
      transcript.message(
        .init(
          continuation: false, entryId: "long-answer", finalChunk: true, role: .final,
          text: """
            This answer should wrap at the phone's available width. Increasing the preferred text size
            must increase the row's height so that the full message remains readable.
            """, tool: nil))
      let standard = try renderRows(transcript.rows)
      let accessible = try renderRows(transcript.rows, size: .accessibility3)
      #expect(standard.width == accessible.width)
      #expect(accessible.height > standard.height)
      Attachment.record(accessible, named: "message-accessibility", as: .png)
    }
  #endif
#endif
