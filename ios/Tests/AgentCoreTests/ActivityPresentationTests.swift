import Foundation
import Testing

@testable import AgentCore
@testable import AgentUI

@MainActor @Test func activityGroupsPreserveChronologyAndEveryOriginalRow() {
  var transcript = Transcript()
  for (index, role) in [
    HistoryRole.user, .commentary, .thinking, .tool, .thinking, .user, .tool, .final,
  ].enumerated() {
    transcript.message(
      .init(
        continuation: false, entryId: "message-\(index)", finalChunk: true, role: role,
        text: "Message \(index)",
        tool: role == .tool ? .init(callId: "call-\(index)", name: "exec", status: .finished) : nil)
    )
  }
  let original = transcript.rows.map(RowModel.init)
  let items = TranscriptItem.grouped(original)
  #expect(items.count == 6)
  let flattened = items.flatMap { item in
    switch item {
    case .message(let row): [row.id]
    case .activity(let group): group.rows.map(\.id)
    }
  }
  #expect(flattened == original.map(\.id))
  let groups = items.compactMap { item -> ActivityGroup? in
    if case .activity(let group) = item { return group }
    return nil
  }
  #expect(groups.map { $0.rows.count } == [3, 1])
  #expect(groups.first?.summary == "1 tool call · 2 thoughts")
}

@MainActor @Test func incomingActivityKeepsItsExistingDisclosureIdentity() throws {
  var transcript = Transcript()
  transcript.activity(.toolStarted(.init(callId: "first", name: "exec")))
  let first = TranscriptItem.grouped(transcript.rows.map(RowModel.init))
  let originalID = try #require(first.first?.id)
  transcript.activity(.thinking(.init(text: "Checking the recorded result.")))
  transcript.activity(.toolStarted(.init(callId: "second", name: "exec")))
  let next = TranscriptItem.grouped(transcript.rows.map(RowModel.init))
  #expect(next.count == 1)
  #expect(next.first?.id == originalID)
  guard case .activity(let group) = try #require(next.first) else {
    Issue.record("Expected one activity disclosure")
    return
  }
  #expect(group.rows.map(\.id) == transcript.rows.map(\.id))
  #expect(group.running)
}

@MainActor @Test func collapsedActivityKeepsAFailureVisibleWhileAnotherToolRuns() throws {
  var transcript = Transcript()
  transcript.message(
    .init(
      continuation: false, entryId: "failed", finalChunk: true, role: .tool, text: "exec failed",
      tool: .init(callId: "failed", name: "exec", status: .failed)))
  transcript.activity(.toolStarted(.init(callId: "running", name: "exec")))
  guard
    case .activity(let group) = try #require(
      TranscriptItem.grouped(transcript.rows.map(RowModel.init)).first)
  else {
    Issue.record("Expected a shared activity group")
    return
  }
  #expect(group.failed)
  #expect(group.running)
  #expect(group.summary.hasPrefix("1 failed"))
  #expect(group.summary.contains("1 running"))
}

@MainActor @Test(.timeLimit(.minutes(1)))
func visibleToolLookupsAreSerialAndCancelledQueuedRowsNeverLoad() async throws {
  var transcript = Transcript()
  transcript.activity(.toolStarted(.init(callId: "first", name: "exec")))
  transcript.activity(.toolStarted(.init(callId: "cancelled", name: "exec")))
  let firstRow = try #require(transcript.rows.first)
  let secondRow = try #require(transcript.rows.last)
  let queue = ActivityDetailQueue()
  var calls: [String] = []
  var release: CheckedContinuation<Void, Never>?
  let entered = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
  defer { entered.continuation.finish() }
  let loader: ToolDetailsLoader = { row in
    let id = row.tool?.callId ?? ""
    calls.append(id)
    await withCheckedContinuation {
      release = $0
      entered.continuation.yield(())
    }
    return .unavailable(.init(callId: id))
  }
  let first = Task { try await queue.load(firstRow, using: loader) }
  defer { first.cancel() }
  for await _ in entered.stream { break }
  let second = Task { try await queue.load(secondRow, using: loader) }
  await Task.yield()
  second.cancel()
  #expect(calls == ["first"])
  release?.resume()
  _ = try await first.value
  await #expect(throws: CancellationError.self) { try await second.value }
  #expect(calls == ["first"])
}
