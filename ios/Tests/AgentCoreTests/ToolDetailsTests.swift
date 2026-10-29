import Foundation
import Testing

@testable import AgentCore

private let selectedTool = NativeRequestToolDetails(callId: "tool-call", entryId: "42")

private func recordedTool(status: ToolStatus = .finished, callID: String = "tool-call")
  -> ToolDetails
{
  .available(
    .init(
      callId: callID,
      input: .text(
        .init(text: #"{"command":"printf 'hello 🦀\\n'","cwd":"/workspace"}"#, truncated: false)),
      name: "exec",
      output: .text(
        .init(
          text: status == .failed
            ? "error: file missing\nexit_code: 1\n" : "hello 🦀\nexit_code: 0\n",
          truncated: true)), status: status))
}

private func connectForToolDetails(_ session: CoordinatorSession) async throws {
  await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
  for await snapshot in session.updates where snapshot.connection == .connected { return }
  throw ConnectionError.closed
}

private func waitForToolLookups(_ fixture: FixtureCoordinator, count: Int) async throws {
  let deadline = ContinuousClock.now + .seconds(8)
  while await fixture.toolLookups().count < count {
    guard ContinuousClock.now < deadline else { throw ConnectionError.timedOut }
    try await Task.sleep(for: .milliseconds(5))
  }
}

@Test(.timeLimit(.minutes(1)), arguments: [ToolStatus.finished, .failed])
func toolDetailsUseOnlyTheSelectedReadAndPreserveExactInputOutputAndStatus(_ status: ToolStatus)
  async throws
{
  try await withCoordinator { session, fixture, outbox in
    let expected = recordedTool(status: status)
    await fixture.replyToToolLookups(with: [.toolDetails(.init(details: expected)), .done])
    try await connectForToolDetails(session)

    let details = try await session.toolDetails(
      entryID: selectedTool.entryId, callID: selectedTool.callId)

    #expect(details == expected)
    #expect(await fixture.toolLookups() == [selectedTool])
    #expect(await fixture.count() == 0, "Opening a tool must not submit a model input")
    #expect(!FileManager.default.fileExists(atPath: outbox.path))
    for await _ in fixture.closedToolLookups { break }
  }
}

@Test(.timeLimit(.minutes(1)))
func toolDetailsReturnExplicitUnavailableContentWithoutInventingOutput() async throws {
  try await withCoordinator { session, fixture, _ in
    let unavailable = ToolDetails.unavailable(.init(callId: selectedTool.callId))
    await fixture.replyToToolLookups(with: [.toolDetails(.init(details: unavailable)), .done])
    try await connectForToolDetails(session)
    #expect(
      try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
        == unavailable)
    for await _ in fixture.closedToolLookups { break }

    let pending = ToolDetails.available(
      .init(
        callId: selectedTool.callId, input: .unavailable(.init(reason: .notRecorded)),
        name: "exec", output: .unavailable(.init(reason: .pending)), status: .running))
    await fixture.replyToToolLookups(with: [.toolDetails(.init(details: pending)), .done])
    #expect(
      try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
        == pending)
    for await _ in fixture.closedToolLookups { break }
    #expect(await fixture.count() == 0)
  }
}

private enum ToolReplyViolation: CaseIterable, Sendable {
  case wrongAvailableCall, wrongUnavailableCall, duplicate, missing, unexpected, failure

  var frames: [NativeEvent] {
    switch self {
    case .wrongAvailableCall:
      [.toolDetails(.init(details: recordedTool(callID: "other-call"))), .done]
    case .wrongUnavailableCall:
      [.toolDetails(.init(details: .unavailable(.init(callId: "other-call")))), .done]
    case .duplicate:
      [
        .toolDetails(.init(details: recordedTool())),
        .toolDetails(.init(details: recordedTool())), .done,
      ]
    case .missing: [.done]
    case .unexpected: [.answer(.init(entryId: nil, text: "Unrelated answer")), .done]
    case .failure: [.failure(.init(message: "Stored output could not be read.")), .done]
    }
  }
}

@Test(.timeLimit(.minutes(1)), arguments: ToolReplyViolation.allCases)
private func toolDetailsRejectUncorrelatedOrIncompleteRepliesAndCloseTheirSocket(
  _ violation: ToolReplyViolation
) async throws {
  try await withCoordinator { session, fixture, _ in
    await fixture.replyToToolLookups(with: violation.frames)
    try await connectForToolDetails(session)
    do {
      _ = try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
      Issue.record("An invalid tool reply was accepted")
    } catch {
      if violation == .failure {
        #expect(error.localizedDescription == "Stored output could not be read.")
      } else {
        #expect(error as? ConnectionError == .incompleteFrame)
      }
    }
    for await _ in fixture.closedToolLookups { break }
    #expect(await fixture.count() == 0)

    // A rejected lookup must release capacity without replacing the live observer.
    let expected = recordedTool()
    await fixture.replyToToolLookups(with: [.toolDetails(.init(details: expected)), .done])
    #expect(
      try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
        == expected)
    for await _ in fixture.closedToolLookups { break }
  }
}

@Test(.serialized, .timeLimit(.minutes(1)), arguments: [false, true])
func toolDetailsCancellationAndDisconnectClosePendingReadsAndReturnTheirCapacity(
  disconnect: Bool
) async throws {
  try await withCoordinator { session, fixture, _ in
    try await connectForToolDetails(session)
    let lookups = (0..<32).map { _ in
      Task {
        try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
      }
    }
    try await waitForToolLookups(fixture, count: lookups.count)
    do {
      _ = try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
      Issue.record("A lookup exceeded the connection capacity")
    } catch { #expect(error as? ConnectionError == .closed) }
    if disconnect {
      await session.disconnect()
    } else {
      for lookup in lookups { lookup.cancel() }
    }
    for lookup in lookups {
      do {
        _ = try await lookup.value
        Issue.record("A stopped lookup returned tool details")
      } catch {}
    }
    var closed = fixture.closedToolLookups.makeAsyncIterator()
    for _ in lookups { #expect(await closed.next() != nil) }
    #expect(await fixture.count() == 0)

    if disconnect { try await connectForToolDetails(session) }
    let expected = recordedTool()
    await fixture.replyToToolLookups(with: [.toolDetails(.init(details: expected)), .done])
    #expect(
      try await session.toolDetails(entryID: selectedTool.entryId, callID: selectedTool.callId)
        == expected)
    for await _ in fixture.closedToolLookups { break }
  }
}
