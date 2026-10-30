import Foundation
import Testing

@testable import AgentCore

@Test func toolBodySurvivesNativeWireLiveHistoryAndChunks() throws {
  let first = HistoryMessage(
    continuation: false, entryId: "result", finalChunk: false,
    presentation: .command(.init(command: "printf fixture", durationMs: 12, exitCode: 7)),
    role: .tool, text: "First output\n",
    tool: .init(callId: "command", name: "exec", status: .failed))
  let last = HistoryMessage(
    continuation: true, entryId: "result", finalChunk: true, role: .tool,
    text: "Last output", tool: first.tool)
  var live = Transcript()
  live.activity(.toolStarted(.init(callId: "command", name: "exec")))
  for message in [first, last] {
    let bytes = try JSONEncoder().encode(NativeEvent.message(.init(message: message)))
    guard case .message(let value) = try JSONDecoder().decode(NativeEvent.self, from: bytes) else {
      Issue.record("Expected a native message")
      return
    }
    live.message(value.message)
  }
  live.activity(.toolFinished(.init(callId: "command", name: "exec")))
  #expect(live.rows.count == 1)
  #expect(live.rows.first?.text == "First output\nLast output")
  #expect(live.rows.first?.tool?.status == .failed)
  var reopened = Transcript()
  for (index, message) in [first, last].enumerated() {
    let bytes = try JSONEncoder().encode(
      NativeEvent.history(.init(messages: [message], nextCursor: nil, pageComplete: index == 1)))
    guard case .history(let value) = try JSONDecoder().decode(NativeEvent.self, from: bytes) else {
      Issue.record("Expected native history")
      return
    }
    reopened.history(value)
  }
  #expect(reopened.rows == live.rows)
}
