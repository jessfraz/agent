import Foundation
import Testing

@testable import AgentCore

private func toolHistoryPage(_ entry: String, status: ToolStatus) -> NativeEventHistory {
  .init(
    messages: [
      .init(
        continuation: false, entryId: entry, finalChunk: true, role: .tool,
        text: status == .running ? "exec" : "exec \(status.rawValue)",
        tool: .init(callId: "fixture-tool-call", name: "exec", status: status))
    ], nextCursor: "older-page", pageComplete: true)
}

@Test(arguments: [ToolStatus.finished, .failed])
func olderToolCallAndNewerResultShareOneRowWithoutRegressingTheResult(_ status: ToolStatus) throws {
  var transcript = Transcript()
  // Pi gives the assistant's call and its result separate entry IDs. A
  // 20-entry cursor boundary can put the result in the more recent page.
  transcript.history(toolHistoryPage("newer-result", status: status))
  let result = try #require(transcript.rows.first)
  transcript.history(
    toolHistoryPage("older-call", status: .running), olderPage: true, requestID: UUID())
  #expect(transcript.rows == [result], "Older pages retain the newer status, body and canonical ID")
  #expect(Set(transcript.rows.map(\.id)).count == transcript.rows.count)
  // Reopening either cursor must keep the same single row, not add a second tool.
  transcript.history(
    toolHistoryPage("older-call", status: .running), olderPage: true, requestID: UUID())
  transcript.history(toolHistoryPage("newer-result", status: status))
  #expect(transcript.rows == [result])
}

@Test func splitToolPagesPreserveOtherMessagesAndStayUniqueWhileTheWindowIsBounded() {
  var transcript = Transcript()
  transcript.history(toolHistoryPage("result", status: .finished))
  for index in 0..<Transcript.maximumRows {
    transcript.message(
      .init(
        continuation: false, entryId: "later-\(index)", finalChunk: true, role: .final,
        text: "Synthetic later message \(index)", tool: nil))
  }
  // The original tool has fallen outside the display window. It can be loaded
  // again as a result, then overlapped by its older caller on the next cursor.
  transcript.history(
    toolHistoryPage("result", status: .finished), olderPage: true, requestID: UUID())
  transcript.history(toolHistoryPage("call", status: .running), olderPage: true, requestID: UUID())
  #expect(transcript.rows.count == Transcript.maximumRows)
  #expect(Set(transcript.rows.map(\.id)).count == transcript.rows.count)
  #expect(transcript.rows.filter { $0.tool != nil }.count == 1)
  #expect(transcript.rows.first?.tool?.status == .finished)
  #expect(transcript.rows.contains { $0.text == "Synthetic later message 0" })
}

@Test func correlatedInputIdentityIsReusedOnlyOnceForMultipleCanonicalBlocks() {
  var transcript = Transcript()
  let request = NativeRequestSubmit(
    inputId: "11111111-1111-4111-8111-111111111111", mode: .steer,
    text: "Original request")
  transcript.pending(request, delivery: .saved)
  transcript.delivery(request.inputId, .saved, entryID: "user-entry")
  let originalID = transcript.rows.first?.id
  let page = NativeEventHistory(
    messages: [
      .init(
        continuation: false, entryId: "user-entry", finalChunk: true, role: .user,
        text: "First canonical block", tool: nil),
      .init(
        continuation: false, entryId: "user-entry", finalChunk: true, role: .user,
        text: "Second canonical block", tool: nil),
    ], nextCursor: nil, pageComplete: true)
  transcript.history(page, olderPage: true, requestID: UUID())
  #expect(transcript.rows.count == 2)
  #expect(transcript.rows.first?.id == originalID)
  #expect(transcript.rows.last?.text == "Second canonical block")
  #expect(Set(transcript.rows.map(\.id)).count == transcript.rows.count)
  transcript.history(page)
  #expect(transcript.rows.count == 2)
  #expect(transcript.rows.first?.id == originalID)
  #expect(Set(transcript.rows.map(\.id)).count == transcript.rows.count)
}
