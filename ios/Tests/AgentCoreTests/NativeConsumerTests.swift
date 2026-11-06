import Foundation
import Testing

@testable import AgentCore

@Test(.timeLimit(.minutes(1)))
func settingsUseMainControlAndKeepDefaultLegacyExtraHighFastAndEffectiveUnknownDistinct()
  async throws
{
  try await withCoordinator { session, fixture, _ in
    await fixture.advertiseSettings(true)
    let configured = ModelSelection(
      fast: false, modelId: "test-model", provider: .openaiCodex, reasoning: .xhigh)
    let settings = NativeSettingsSnapshot(
      configured: .init(
        catalog: [
          .init(
            fast: true, modelId: "test-model", name: "Test model", provider: .openaiCodex,
            reasoning: [.low, .high, .xhigh])
        ],
        conversationId: "fixture-root", model: configured), effective: nil)
    await fixture.replyToSettings(settings)
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    let read = try await session.settings()
    #expect(read == settings)
    #expect(read.effective == nil)
    #expect(read.configured.model.reasoning == .xhigh)
    let changes: [ConversationChange] = [
      .setReasoning(.init(reasoning: nil)), .setReasoning(.init(reasoning: .off)),
      .setReasoning(.init(reasoning: .xhigh)), .setFast(.init(mode: .off)),
      .setFast(.init(mode: .on)),
    ]
    for change in changes { _ = try await session.settings(change: change) }
    let requests = await fixture.settingsControls()
    #expect(requests.map(\.change) == [nil] + changes.map(Optional.some))
    #expect(requests.allSatisfy { $0.catalog })
    #expect(await fixture.count() == 0)
    await fixture.rejectSettings("This model does not support Fast")
    await #expect(throws: (any Error).self) {
      try await session.settings(change: .setFast(.init(mode: .on)))
    }
    #expect(await fixture.count() == 0)
  }
}

@Test(.timeLimit(.minutes(1)))
func legacySettingsAreUnavailableWithoutSendingAnyFallbackComposerInput() async throws {
  try await withCoordinator { session, fixture, _ in
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    await #expect(throws: (any Error).self) { try await session.settings() }
    #expect(await fixture.settingsControls().isEmpty)
    #expect(await fixture.count() == 0)
  }
}

@Test func transcriptUsesOnlySuppliedImmutableJobProvenanceAndKnownLocalInputOrigin() throws {
  var transcript = Transcript()
  let job = NoticeOrigin(jobId: "invented-job", title: "Original run title")
  transcript.history(
    .init(
      messages: [
        .init(
          continuation: false, entryId: "job:1", finalChunk: false, noticeOrigin: job,
          role: .notice, text: "Scheduled "),
        .init(
          continuation: true, entryId: "job:1", finalChunk: true, role: .notice, text: "notice"),
        .init(
          continuation: false, entryId: "legacy:1", finalChunk: true, role: .notice,
          text: "No supplied provenance"),
        .init(
          continuation: false, entryId: "legacy:2", finalChunk: true, role: .user,
          text: "Imported user text"),
      ], nextCursor: nil, pageComplete: true))
  let rows = transcript.rows
  #expect(rows[0].noticeOrigin == job)
  #expect(rows[0].provenanceLabel == "Job: Original run title")
  #expect(rows[0].text == "Scheduled notice")
  #expect(rows[1].provenanceLabel == nil)
  #expect(rows[2].inputOrigin == nil)
  #expect(rows[2].provenanceLabel == nil)
  #expect(rows[2].delivery == .saved)
  transcript.pending(
    .init(inputId: "local", mode: .steer, origin: .ios, text: "Known local input"),
    delivery: .uncertain)
  transcript.delivery("local", .saved, entryID: "native:10:0")
  transcript.reconnect()
  #expect(transcript.rows.last?.inputOrigin == .ios)
  #expect(transcript.rows.last?.provenanceLabel == "iOS")
}

@Test(.timeLimit(.minutes(1)))
func cancellingASettingsReadClosesItsOwnedSocketWithoutDisconnectingTheObserver() async throws {
  try await withCoordinator { session, fixture, _ in
    await fixture.advertiseSettings(true)
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    let read = Task { try await session.settings() }
    for await _ in fixture.observedSettings { break }
    read.cancel()
    await #expect(throws: (any Error).self) { try await read.value }
    for await _ in fixture.closedSettings { break }
    #expect(await session.submit("The observer remains usable"))
  }
}

@Test(.timeLimit(.minutes(1)))
func settingsForAnotherConversationCannotReplaceTheMainSelection() async throws {
  try await withCoordinator { session, fixture, _ in
    await fixture.advertiseSettings(true)
    await fixture.replyToSettings(
      .init(
        configured: .init(
          catalog: [],
          conversationId: "another-conversation",
          model: .init(fast: false, modelId: "model", provider: .openai))))
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    await #expect(throws: (any Error).self) { try await session.settings() }
    #expect(await fixture.count() == 0)
  }
}
