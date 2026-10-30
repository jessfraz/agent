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

  // Hosted captures share one scene and must own its key window serially.
  @Suite(.serialized) struct NativeRenderingTests {
    @MainActor private func renderRows(
      _ rows: [ChatRow], size: DynamicTypeSize = .large, scheme: ColorScheme = .light,
      expandedActivity: Bool = false, inspection: ToolDetailsAvailable? = nil
    ) async throws -> CGImage {
      let models = rows.map(RowModel.init)
      let content = VStack(alignment: .leading, spacing: 22) {
        if expandedActivity {
          ForEach(TranscriptItem.grouped(models)) { item in
            switch item {
            case .activity(let group):
              ActivityGroupView(
                group: group,
                expansion: .constant(
                  ActivityExpansion(groups: [group.id], items: Set(group.rows.map(\.id)))),
                details: { row in .unavailable(.init(callId: row.tool?.callId ?? "")) })
            case .message(let model):
              MessageRow(model: model, retry: { _ in }, restore: { _ in })
            }
          }
        } else {
          ForEach(models) { model in
            MessageRow(model: model, retry: { _ in }, restore: { _ in })
          }
        }
        if let inspection {
          ToolContent(
            title: "Output", content: inspection.output, name: inspection.name,
            preview: rows.first?.presentation == nil ? nil : rows.first?.text)
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
          host.willMove(toParent: nil)
          host.view.removeFromSuperview()
          host.removeFromParent()
          window.rootViewController = nil
          previousWindow?.makeKey()
        }
        window.layoutIfNeeded()
        container.addChild(host)
        let viewport = UIView(
          frame: CGRect(
            origin: .zero,
            size: CGSize(
              width: dimensions.width, height: min(dimensions.height, container.view.bounds.height))
          ))
        viewport.clipsToBounds = true
        let scroll = UIScrollView(frame: viewport.bounds)
        scroll.showsVerticalScrollIndicator = false
        scroll.contentSize = dimensions
        viewport.addSubview(scroll)
        container.view.addSubview(viewport)
        scroll.addSubview(host.view)
        host.view.frame = CGRect(origin: .zero, size: dimensions)
        host.didMove(toParent: container)
        host.view.layoutIfNeeded()
        #expect(host.view.bounds.size == dimensions)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        var frames: [(CGFloat, UIImage)] = []
        let pageHeight = try #require(viewport.bounds.height > 0 ? viewport.bounds.height : nil)
        // Capture only attached, visible native surfaces, then assemble the gallery.
        // This UIKit scroll view owns its content; the app's lazy SwiftUI scroll
        // view is never moved through UIKit.
        for index in 0..<Int(ceil(dimensions.height / pageHeight)) {
          let offset = min(CGFloat(index) * pageHeight, max(0, dimensions.height - pageHeight))
          scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
          try await Task.sleep(for: .milliseconds(50))
          viewport.layoutIfNeeded()
          let frame = UIGraphicsImageRenderer(size: viewport.bounds.size, format: format).image {
            _ in
            #expect(viewport.drawHierarchy(in: viewport.bounds, afterScreenUpdates: true))
          }
          frames.append((offset, frame))
        }
        let image = UIGraphicsImageRenderer(size: dimensions, format: format).image { context in
          (scheme == .dark ? UIColor.black : UIColor.white).setFill()
          context.fill(CGRect(origin: .zero, size: dimensions))
          for (offset, frame) in frames {
            frame.draw(in: CGRect(x: 0, y: offset, width: dimensions.width, height: pageHeight))
          }
        }
        let pixels = try #require(image.cgImage)
        try requireVisibleContent(pixels)
        return pixels
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

    @MainActor @Test func typedActivityRendersWithoutPrivateDetailsInLightAndDark() async throws {
      var transcript = Transcript()
      for (index, presentation, body) in [
        (
          0,
          MessagePresentation.command(
            .init(command: "printf 'literal output'", durationMs: 12, exitCode: 7)),
          "Literal **stdout**\nA second output line"
        ),
        (
          1, .fileChanges(.init(changes: [.init(operation: .update, path: "example.rs")])),
          "+new line\n-old line"
        ),
        (
          2,
          .agentCoordination(
            .init(
              action: .followup, agents: [.init(state: .completed, threadId: "child")],
              receiverThreadIds: ["child"])), ""
        ),
        (3, .plan, "1. **Keep** the existing conversation."),
      ] {
        transcript.message(
          .init(
            continuation: false, entryId: "typed-\(index)", finalChunk: true,
            presentation: presentation, role: index == 3 ? .assistant : .tool, text: body,
            tool: index < 3
              ? .init(
                callId: "typed-\(index)", name: "exec", status: index == 0 ? .failed : .finished)
              : nil))
      }
      for scheme in [ColorScheme.light, .dark] {
        let image = try await renderRows(transcript.rows, scheme: scheme, expandedActivity: true)
        #expect(image.width >= 390)
        #expect(image.height > 400)
        Attachment.record(image, named: "typed-activity-\(scheme)", as: .png)
      }
    }

    @MainActor @Test func richerLazyOutputRendersBeyondANonemptyTypedPreview() async throws {
      let preview = "Bounded preview\n[Output preview truncated]"
      var transcript = Transcript()
      transcript.message(
        .init(
          continuation: false, entryId: "retained", finalChunk: true,
          presentation: .tool(.init(namespace: "fixture")), role: .tool, text: preview,
          tool: .init(callId: "retained", name: "inspect", status: .finished)))
      let original = (0..<24).map { "Additional retained output line \($0)" }.joined(
        separator: "\n")
      let same = ToolDetailsAvailable(
        callId: "retained", input: .unavailable(.init(reason: .notRecorded)), name: "inspect",
        output: .text(.init(text: preview, truncated: false)), status: .finished)
      var richer = same
      richer.output = .text(.init(text: preview + "\n" + original, truncated: false))
      let collapsed = try await renderRows(transcript.rows, inspection: same)
      let expanded = try await renderRows(transcript.rows, inspection: richer)
      #expect(expanded.height > collapsed.height + 120)
      Attachment.record(expanded, named: "richer-retained-tool-output", as: .png)
    }

    @MainActor @Test func supportedMessageRowsRenderInLightAndDarkAppearance() async throws {
      var transcript = Transcript()
      let roles: [HistoryRole] = [
        .user, .assistant, .commentary, .partialAnswer, .final, .notice, .thinking,
      ]
      let file = AttachmentRef(
        id: "11111111-1111-4111-8111-111111111111", mediaType: "application/pdf",
        name: "Design notes.pdf",
        sha256: String(repeating: "a", count: 64), sizeBytes: 24576)
      for role in roles {
        transcript.message(
          .init(
            attachments: role == .user ? [file] : nil, continuation: false, entryId: role.rawValue,
            finalChunk: true,
            role: role,
            text: "A **useful** message with `inline code` and a [link](https://example.invalid).",
            tool: nil))
      }
      for status in [ToolStatus.running, .finished, .failed, .declined, .interrupted, .unknown] {
        transcript.message(
          .init(
            attachments: nil, continuation: false, entryId: "tool-\(status.rawValue)",
            finalChunk: true, role: .tool,
            text: "Build the native client",
            tool: .init(callId: status.rawValue, name: "build", status: status)))
      }
      transcript.message(
        .init(
          attachments: nil, continuation: false, entryId: "rich-answer", finalChunk: true,
          role: .final,
          text: """
            # Native rendering
            ## Second level
            ### Third level
            #### Fourth level
            ##### Fifth level
            ###### Sixth level

            Plain, *emphasis*, **strong**, ***both***, ~~struck through~~, `inline code`,
            and a [link](https://example.invalid).

            Unicode: café, 日本語, العربية, 🦀, and a combined accent: é.

            > A quoted update.

            - Unordered item
              - Nested item with a longer sentence that wraps onto another line.
            - Another item

            3. Ordered item

               A continuation paragraph stays indented without another number.

            4. Another item

            - [x] Completed task
            - [ ] Open task

            ~~~swift
            let message = "Hello 🦀"
            let deliberatelyWideLine = "Code remains on one line and scrolls horizontally at the phone's available width."
            ~~~

            ````markdown
            ```swift
            let nestedFence = "Preserved as code"
            ```
            ````

            | Check | Result | A deliberately wide third column |
            | --- | --- | --- |
            | Build | Passed | Code and tables can scroll horizontally |
            | Left\\|right | `inline code` | Escaped pipes stay in their cell |
            | - | : | Data that resembles a delimiter remains visible |
            | | An empty first cell | |

            ```swift
            let streaming = "An unfinished fence stays readable"
            """, tool: nil))
      for delivery in [Delivery.uncertain, .rejected] {
        transcript.pending(
          .init(
            attachments: nil, inputId: UUID().uuidString, mode: .steer,
            text: "Keep this original message"),
          delivery: delivery)
      }
      for scheme in [ColorScheme.light, .dark] {
        let image = try await renderRows(transcript.rows, scheme: scheme)
        #expect(image.width >= 390)
        #expect(image.height > 600)
        Attachment.record(image, named: "message-rows-\(scheme)", as: .png)
      }
      // Bound native offscreen surfaces while retaining every row at large text sizes.
      for start in stride(from: 0, to: transcript.rows.count, by: 4) {
        let rows = Array(transcript.rows[start..<min(start + 4, transcript.rows.count)])
        let accessible = try await renderRows(rows, size: .accessibility3)
        #expect(accessible.width >= 390)
        Attachment.record(
          accessible, named: "message-rows-accessibility-\(start / 4 + 1)", as: .png)
      }
    }

    @MainActor @Test func nonSuccessToolStatesHaveDistinctNativeIconsAndCollapsedSummaries()
      async throws
    {
      func row(_ status: ToolStatus) throws -> ChatRow {
        var transcript = Transcript()
        transcript.message(
          .init(
            continuation: false, entryId: "tool-entry", finalChunk: true, role: .tool,
            text: "Check the requested result",
            tool: .init(callId: "tool-call", name: "verify_result", status: status)))
        return try #require(transcript.rows.first)
      }
      let finished = try await renderRows([row(.finished)])
      let finishedPixels = try #require(finished.dataProvider?.data) as Data
      for status in [ToolStatus.declined, .interrupted, .unknown] {
        let item = try row(status)
        let image = try await renderRows([item])
        let pixels = try #require(image.dataProvider?.data) as Data
        #expect(finishedPixels != pixels, "\(status.rawValue) must not render as success")
        let group = ActivityGroup(id: "activity:tool-entry", rows: [RowModel(item)])
        #expect(group.summary.contains(status.rawValue))
        Attachment.record(image, named: "tool-state-\(status.rawValue)", as: .png)
      }
    }

    #if os(iOS)
      private func requireVisibleContent(_ image: CGImage, region: CGRect? = nil) throws {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try pixels.withUnsafeMutableBytes { buffer in
          let context = try #require(
            CGContext(
              data: buffer.baseAddress, width: image.width, height: image.height,
              bitsPerComponent: 8, bytesPerRow: image.width * 4,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                | CGBitmapInfo.byteOrder32Big.rawValue))
          let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
          context.setFillColor(CGColor(gray: 1, alpha: 1))
          context.fill(bounds)
          context.draw(image, in: bounds)
          let area = (region ?? bounds).intersection(bounds).integral
          let bytes = try #require(buffer.bindMemory(to: UInt8.self).baseAddress)
          let first = Int(area.minY) * image.width * 4 + Int(area.minX) * 4
          var different = 0
          for y in Int(area.minY)..<Int(area.maxY) {
            for x in Int(area.minX)..<Int(area.maxX) {
              let offset = (y * image.width + x) * 4
              if (0..<3).contains(where: { bytes[offset + $0] != bytes[first + $0] }) {
                different += 1
              }
            }
          }
          #expect(
            different > Int(area.width * area.height) / 100, "Native transcript capture is blank")
        }
      }

      @MainActor private final class ConversationFixture {
        let model = ChatModel()
        private var details: [String: ToolDetails] = [:]
        private(set) var requests: Set<String> = []

        init() throws {
          var transcript = Transcript()
          transcript.message(
            .init(
              continuation: false, entryId: "request", finalChunk: true, role: .user,
              text: "Check the worker’s allocation logs and explain why its path is stale."))
          transcript.message(
            .init(
              continuation: false, entryId: "preamble", finalChunk: true, role: .commentary,
              text: "The saved allocation and live worker can be compared before changing anything."
            ))
          let commands: [(String, [String])] = [
            ("rg", ["-n", "allocation", "Sources/"]), ("tail", ["-n", "40", "logs/worker.log"]),
            ("ps", ["-o", "pid,comm", "-p", "42"]), ("cat", ["config/worker.json"]),
            ("ls", ["logs/"]), ("test", ["-d", "logs/current"]),
            ("readlink", ["logs/current"]), ("rg", ["-n", "pending", "logs/worker.log"]),
          ]
          for (index, command) in commands.enumerated() {
            if index.isMultiple(of: 3) {
              transcript.message(
                .init(
                  continuation: false, entryId: "thought-\(index)", finalChunk: true,
                  role: .thinking,
                  text: """
                    ### Check the saved allocation

                    The saved allocation and live process agree. The next check is whether the worker still reads an old path.

                    - Compare the recorded identifier.
                    - Inspect `logs/current` without changing the allocation.

                    The final answer should explain the smallest repair and preserve the existing work.
                    """))
            }
            let status: ToolStatus = index == 7 ? .running : index == 5 ? .failed : .finished
            let callID = "command-\(index)"
            transcript.message(
              .init(
                continuation: false, entryId: "tool-entry-\(index)", finalChunk: true, role: .tool,
                text: command.0,
                tool: .init(callId: callID, name: "exec", status: status)))
            let input = try JSONEncoder().encode(
              FixtureCommand(program: command.0, args: command.1, cwd: "/workspace/project"))
            let output = try JSONEncoder().encode(
              FixtureProcess(
                exitCode: status == .failed ? 1 : 0,
                stdout: status == .failed
                  ? "" : "The recorded allocation matches the running worker.\n",
                stderr: status == .failed ? "The current log directory does not exist.\n" : ""))
            details[callID] = .available(
              .init(
                callId: callID,
                input: .text(.init(text: String(decoding: input, as: UTF8.self), truncated: false)),
                name: "exec",
                output: status == .running
                  ? .unavailable(.init(reason: .pending))
                  : .text(.init(text: String(decoding: output, as: UTF8.self), truncated: false)),
                status: status))
          }
          transcript.message(
            .init(
              continuation: false, entryId: "steer", finalChunk: true, role: .user,
              text: "Keep the allocation. Explain the fix."))
          transcript.message(
            .init(
              continuation: false, entryId: "answer", finalChunk: true, role: .final,
              text: """
                ### What changed

                The allocation is intact. The worker was reading an old path.

                - Keep the allocation.
                - Point the worker at `logs/current`.
                - Restart only that worker.
                """))
          model.rows = transcript.rows.map(RowModel.init)
          model.connection = .connected
          model.model = "openai/gpt-6.1-sol · high"
          model.busy = true
        }

        func loadDetails(_ row: ChatRow) async throws -> ToolDetails {
          let id = row.tool?.callId ?? ""
          requests.insert(id)
          return details[id] ?? .unavailable(.init(callId: id))
        }

        func expansion() -> ActivityExpansion {
          var result = ActivityExpansion()
          for item in TranscriptItem.grouped(model.rows) {
            if case .activity(let group) = item { result.groups.insert(group.id) }
          }
          if let thought = model.rows.first(where: { $0.row.role == .thinking }) {
            result.items.insert(thought.id)
          }
          if let failed = model.rows.first(where: { $0.row.tool?.status == .failed }) {
            result.items.insert(failed.id)
          }
          if let command = model.rows.first(where: { $0.row.tool != nil }) {
            result.items.insert(command.id)
          }
          return result
        }
      }

      private struct FixtureCommand: Encodable {
        let program: String
        let args: [String]
        let cwd: String
      }

      private struct FixtureProcess: Encodable {
        let type = "process"
        let exitCode: Int
        let stdout: String
        let stderr: String
        let truncated = false
        enum CodingKeys: String, CodingKey {
          case type, stdout, stderr, truncated
          case exitCode = "exit_code"
        }
      }

      private enum ConversationFocus { case collapsed, latest, reasoning }

      @MainActor private func renderConversation(
        _ fixture: ConversationFixture, focus: ConversationFocus, size: DynamicTypeSize,
        scheme: ColorScheme, dimensions: CGSize
      ) async throws -> CGImage {
        let expanded = focus != .collapsed
        let content = MainChatView(
          model: fixture.model, expansion: expanded ? fixture.expansion() : ActivityExpansion(),
          details: fixture.loadDetails,
          initialScrollTarget: focus == .reasoning ? fixture.expansion().groups.first : nil
        )
        .environment(\.dynamicTypeSize, size).environment(\.colorScheme, scheme)
        let host = UIHostingController(rootView: content)
        let scene = try #require(
          UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        let container = UIViewController()
        window.rootViewController = container
        window.makeKeyAndVisible()
        defer {
          window.isHidden = true
          host.willMove(toParent: nil)
          host.view.removeFromSuperview()
          host.removeFromParent()
          window.rootViewController = nil
          previousWindow?.makeKey()
        }
        window.layoutIfNeeded()
        container.addChild(host)
        container.view.addSubview(host.view)
        host.view.frame = CGRect(origin: .zero, size: dimensions)
        host.didMove(toParent: container)
        host.view.layoutIfNeeded()
        // Native navigation/scroll layout and the disclosure's owned async lookup
        // settle before capture. No live account, transport or saved address is used.
        try await Task.sleep(for: .milliseconds(100))
        host.view.layoutIfNeeded()
        if !expanded { #expect(fixture.requests.isEmpty) }
        if expanded && !size.isAccessibilitySize { #expect(!fixture.requests.isEmpty) }
        #expect(fixture.requests.isSubset(of: Set((0..<8).map { "command-\($0)" })))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(size: dimensions, format: format).image { _ in
          #expect(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
        }
        let pixels = try #require(image.cgImage)
        try requireVisibleContent(
          pixels,
          region: CGRect(
            x: 16, y: 100, width: dimensions.width - 32, height: dimensions.height - 244))
        return pixels
      }

      @MainActor @Test func fullConversationRendersCompactAndExpandedActivity() async throws {
        for (name, scheme, size, width, height, focus) in [
          (
            "light", ColorScheme.light, DynamicTypeSize.large, 390, 844, ConversationFocus.collapsed
          ),
          ("dark", .dark, .large, 390, 844, .collapsed),
          ("large-text", .light, .accessibility3, 390, 844, .collapsed),
          ("small-phone", .light, .large, 320, 568, .collapsed),
          ("expanded-light", .light, .large, 390, 844, .latest),
          ("expanded-dark", .dark, .large, 390, 844, .latest),
          ("reasoning-and-command-light", .light, .large, 390, 844, .reasoning),
          ("reasoning-and-command-dark", .dark, .large, 390, 844, .reasoning),
          ("expanded-large-text", .light, .accessibility3, 390, 844, .reasoning),
        ] {
          let fixture = try ConversationFixture()
          let image = try await renderConversation(
            fixture, focus: focus, size: size, scheme: scheme,
            dimensions: CGSize(width: width, height: height))
          #expect(image.width == width)
          #expect(image.height == height)
          Attachment.record(image, named: "full-chat-\(name)", as: .png)
        }
      }

      @MainActor @Test func accessibilityTextSizeExpandsMessageLayout() async throws {
        var transcript = Transcript()
        transcript.message(
          .init(
            attachments: nil, continuation: false, entryId: "long-answer", finalChunk: true,
            role: .final,
            text: """
              This answer should wrap at the phone's available width. Increasing the preferred text size
              must increase the row's height so that the full message remains readable.
              """, tool: nil))
        let standard = try await renderRows(transcript.rows)
        let accessible = try await renderRows(transcript.rows, size: .accessibility3)
        #expect(standard.width == accessible.width)
        #expect(accessible.height > standard.height)
        Attachment.record(accessible, named: "message-accessibility", as: .png)
      }
    #endif
  }

#endif
