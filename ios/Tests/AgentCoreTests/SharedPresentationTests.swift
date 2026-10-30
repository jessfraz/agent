import Foundation
import Testing

@testable import AgentCore
@testable import AgentUI

@MainActor @Test func rustProducedPresentationsReachNativeRowsAndActivityHeadings() throws {
  let bytes = try Data(
    contentsOf: #require(
      Bundle.module.url(forResource: "events", withExtension: "ndjson", subdirectory: "Fixtures")))
  var headings: Set<String> = []
  for line in bytes.split(separator: 10) {
    let event = try JSONDecoder().decode(NativeEvent.self, from: Data(line))
    let messages: [HistoryMessage]
    switch event {
    case .message(let value): messages = [value.message]
    case .history(let value): messages = value.messages
    default: continue
    }
    for message in messages {
      guard let presentation = message.presentation else { continue }
      var live = Transcript()
      live.message(message)
      let row = try #require(live.rows.first)
      #expect(row.presentation == presentation)
      #expect(row.text == message.text)
      var saved = Transcript()
      saved.history(.init(messages: [message], nextCursor: nil, pageComplete: true))
      #expect(saved.rows == live.rows)
      let heading = presentation.activityTitle(toolName: row.tool?.name)
      #expect(!heading.isEmpty)
      headings.insert(heading)
      #expect(TranscriptItem.grouped(live.rows.map(RowModel.init)).count == 1)
    }
  }
  #expect(headings.count >= 14)
}

@MainActor @Test func olderCallsEnrichResultMetadataWithoutReplacingBodyStatusOrIdentity() throws {
  let result = HistoryMessage(
    continuation: false, entryId: "result", finalChunk: true,
    presentation: .command(.init(durationMs: 12, exitCode: 7)), role: .tool,
    text: "Retained command output", tool: .init(callId: "call", name: "exec", status: .failed))
  let call = HistoryMessage(
    continuation: false, entryId: "call", finalChunk: true,
    presentation: .command(.init(command: "printf fixture")), role: .tool, text: "",
    tool: .init(callId: "call", name: "exec", status: .running))
  var transcript = Transcript()
  transcript.message(result)
  transcript.history(.init(messages: [call], nextCursor: nil, pageComplete: true), olderPage: true)
  transcript.activity(.toolStarted(.init(callId: "call", name: "exec")))
  transcript.activity(.toolFinished(.init(callId: "call", name: "exec")))
  transcript.history(.init(messages: [call], nextCursor: nil, pageComplete: true))
  let row = try #require(transcript.rows.first)
  #expect(transcript.rows.count == 1)
  #expect(row.entryID == "result")
  #expect(row.text == "Retained command output")
  #expect(row.tool?.status == .failed)
  #expect(
    row.presentation == .command(.init(command: "printf fixture", durationMs: 12, exitCode: 7)))
  #expect(row.presentation?.activityTitle() == "printf fixture")
}

@MainActor @Test func typedEventsWithoutToolIdentityKeepTheirBodyAndExistingActivityDisclosure() {
  let cases: [(MessagePresentation, String, String)] = [
    (
      .fileChanges(.init(changes: [.init(operation: .update, path: "example.rs")])), "+new\n-old",
      "example.rs"
    ),
    (
      .agentCoordination(.init(action: .followup, agents: [], receiverThreadIds: ["child"])), "",
      "Queue agent input"
    ),
    (.webSearch(.init(action: .openPage, query: "schema")), "https://example.invalid", "Open page"),
    (.media(.init(operation: .generate, status: "inProgress")), "", "Image generation"),
    (.plan, "1. **Keep** current work.", "Plan"),
    (.hookPrompt, "", "Historical hook prompt · inert"),
    (.unknown(.init(kind: "future_kind")), "", "Unknown history item · future_kind"),
  ]
  var transcript = Transcript()
  for (index, (presentation, text, heading)) in cases.enumerated() {
    transcript.message(
      .init(
        continuation: false, entryId: "event-\(index)", finalChunk: true,
        presentation: presentation, role: .tool, text: text))
    #expect(presentation.activityTitle() == heading)
  }
  let items = TranscriptItem.grouped(transcript.rows.map(RowModel.init))
  #expect(transcript.rows.map(\.text) == cases.map { $0.1 })
  #expect(transcript.rows.map(\.presentation) == cases.map { $0.0 })
  #expect(items.count == 1)
  if case .activity(let group) = items.first {
    #expect(group.summary == "7 events")
  } else {
    Issue.record("Typed events must keep the existing activity disclosure")
  }
}

@MainActor @Test func typedAssistantPlansKeepTheirNormalMessageBodyFlow() {
  var transcript = Transcript()
  transcript.message(
    .init(
      continuation: false, entryId: "plan", finalChunk: true, presentation: .plan,
      role: .assistant, text: "1. **Keep** the existing conversation."))
  let items = TranscriptItem.grouped(transcript.rows.map(RowModel.init))
  if case .message(let model) = items.first {
    #expect(model.row.presentation == .plan)
    #expect(model.row.text == "1. **Keep** the existing conversation.")
    #expect(!model.row.blocks.isEmpty)
  } else {
    Issue.record("Presentation metadata must not collapse an ordinary assistant message")
  }
}

@MainActor @Test func lazyRetainedOutputOnlyDeduplicatesAnExactCompletePreview() throws {
  let preview = String(repeating: "p", count: 32_768)
  let original = ToolDetails.available(
    .init(
      callId: "call", input: .unavailable(.init(reason: .notRecorded)), name: "inspect",
      output: .text(.init(text: preview + "\nAdditional retained evidence", truncated: false)),
      status: .finished))
  let bytes = try JSONEncoder().encode(original)
  guard case .available(let retained) = try JSONDecoder().decode(ToolDetails.self, from: bytes)
  else {
    Issue.record("Expected the native retained tool result")
    return
  }
  #expect(ToolContent(title: "Output", content: retained.output, preview: preview).showsContent)
  #expect(
    !ToolContent(
      title: "Output", content: .text(.init(text: preview, truncated: false)), preview: preview
    )
    .showsContent)
  #expect(
    ToolContent(
      title: "Output", content: .text(.init(text: preview, truncated: true)), preview: preview
    )
    .showsContent)
  #expect(
    ToolContent(
      title: "Output", content: .unavailable(.init(reason: .lookupLimit)), preview: preview
    )
    .showsContent)
}
