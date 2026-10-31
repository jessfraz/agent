import CryptoKit
import Foundation
import Network
import Testing

@testable import AgentCore

@Test func rustProducedContractsRoundTripThroughSwift() throws {
  let decoder = JSONDecoder()
  let encoder = JSONEncoder()
  let events = try Data(
    contentsOf: #require(
      Bundle.module.url(forResource: "events", withExtension: "ndjson", subdirectory: "Fixtures")))
  for line in events.split(separator: 10) {
    let event = try decoder.decode(NativeEvent.self, from: Data(line))
    #expect(try decoder.decode(NativeEvent.self, from: encoder.encode(event)) == event)
  }
  let commands = try Data(
    contentsOf: #require(
      Bundle.module.url(forResource: "commands", withExtension: "ndjson", subdirectory: "Fixtures"))
  )
  for line in commands.split(separator: 10) {
    let command = try decoder.decode(NativeCommand.self, from: Data(line))
    #expect(try decoder.decode(NativeCommand.self, from: encoder.encode(command)) == command)
  }
}

@Test func ordinaryNetworksAndAmbiguousAddressesAreRejected() throws {
  for host in [
    "localhost", "127.0.0.1", "192.168.1.2", "100.63.1.2", "100.128.1.2", "100.064.1.2",
    "100.64.1.2.example", "::1",
  ] {
    #expect(throws: ConnectionError.self) { try CoordinatorAddress(host: host) }
  }
  #expect(try CoordinatorAddress(host: "100.64.1.2").port == 43187)
  #expect(throws: ConnectionError.self) { try CoordinatorAddress(host: "100.64.1.2", port: 0) }
}

@Test func reconnectHistoryAndPlacementDoNotDuplicateAnInput() {
  var transcript = Transcript()
  let request = NativeRequestSubmit(
    attachments: nil, inputId: "11111111-1111-4111-8111-111111111111", mode: .steer, text: "Hello")
  transcript.pending(request, delivery: .uncertain)
  let stableID = transcript.rows.first?.id
  let user = HistoryMessage(
    attachments: nil, continuation: false, entryId: "saved-user", finalChunk: true, role: .user,
    text: "Hello",
    tool: nil)
  transcript.history(.init(messages: [user], nextCursor: nil, pageComplete: true))
  transcript.delivery(request.inputId, .saved, entryID: "saved-user")
  transcript.history(.init(messages: [user], nextCursor: nil, pageComplete: true))
  #expect(transcript.rows.count == 1)
  #expect(transcript.rows.first?.id == stableID)
  #expect(transcript.rows.first?.delivery == nil)
}

@Test func historyReconstructsMultipleBlocksChunksAndToolFailure() {
  var transcript = Transcript()
  let first = HistoryMessage(
    attachments: nil, continuation: false, entryId: "entry", finalChunk: false, role: .commentary,
    text: "First ",
    tool: nil)
  let continuation = HistoryMessage(
    attachments: nil, continuation: true, entryId: "entry", finalChunk: true, role: .commentary,
    text: "block",
    tool: nil)
  let second = HistoryMessage(
    attachments: nil, continuation: false, entryId: "entry", finalChunk: true, role: .thinking,
    text: "Another block",
    tool: nil)
  transcript.history(.init(messages: [first], nextCursor: nil, pageComplete: false))
  #expect(transcript.rows.isEmpty)
  transcript.history(
    .init(messages: [continuation, second], nextCursor: "earlier", pageComplete: true))
  #expect(transcript.rows.map(\.text) == ["First block", "Another block"])
  let ids = transcript.rows.map(\.id)
  transcript.history(
    .init(messages: [first, continuation, second], nextCursor: nil, pageComplete: true))
  #expect(transcript.rows.map(\.id) == ids)
  transcript.activity(.toolStarted(.init(callId: "tool", name: "check")))
  transcript.message(
    .init(
      attachments: nil, continuation: false, entryId: "result", finalChunk: true, role: .tool,
      text: "check failed",
      tool: .init(callId: "tool", name: "check", status: .failed)))
  #expect(transcript.rows.filter { $0.tool?.callId == "tool" }.count == 1)
  #expect(transcript.rows.last?.tool?.status == .failed)
}

@Test func streamedTextSettlesToOneDurableAnswerAndMemoryIsBounded() {
  var transcript = Transcript()
  transcript.response("Hello ")
  transcript.response("world")
  #expect(transcript.rows.last?.text == "Hello world")
  transcript.answer(.init(entryId: "answer", text: "Hello world"))
  transcript.answer(.init(entryId: "answer", text: "Hello world"))
  #expect(transcript.rows.count == 1)
  #expect(transcript.rows.first?.role == .final)
  for index in 0...Transcript.maximumRows { transcript.notice("Notice \(index)") }
  #expect(transcript.rows.count == Transcript.maximumRows)
}

@Test func markdownPreservesCodeAndStructuredBlocks() {
  let blocks = RichText.parse(
    "# Heading\n\nText **bold** and [link](https://example.invalid).\n\n```swift\nlet x = \"🦀\"\n```\n\n> Quote\n\n| A | B |\n|---|---|\n| 1 | 2 |"
  )
  #expect(blocks.count == 5)
  #expect(blocks.contains(.code("let x = \"🦀\"", language: "swift")))
  guard case .table(let rows) = blocks.last else {
    Issue.record("Missing native table")
    return
  }
  #expect(rows.count == 2)
}

private func withLocalPeer(_ body: @Sendable (LineConnection, NWConnection) async throws -> Void)
  async throws
{
  let parameters = NWParameters.tcp
  parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
  let listener = try NWListener(using: parameters)
  let ready = AsyncThrowingStream<Void, any Error>.makeStream()
  let accepted = AsyncStream<NWConnection>.makeStream()
  listener.stateUpdateHandler = { state in
    switch state {
    case .ready: ready.continuation.yield(())
    case .failed(let error): ready.continuation.finish(throwing: error)
    case .cancelled: ready.continuation.finish()
    default: break
    }
  }
  listener.newConnectionHandler = { accepted.continuation.yield($0) }
  listener.start(queue: .global())
  defer {
    listener.cancel()
    accepted.continuation.finish()
  }
  for try await _ in ready.stream { break }
  let port = try #require(listener.port)
  let client = LineConnection(
    connection: NWConnection(host: .ipv4(.loopback), port: port, using: .tcp))
  for await server in accepted.stream {
    server.start(queue: .global())
    do {
      try await body(client, server)
      await client.close()
      server.cancel()
    } catch {
      await client.close()
      server.cancel()
      throw error
    }
    break
  }
}

@Test(.timeLimit(.minutes(1))) func realNetworkTransportHandlesFragmentedUnicodeAndCancellation()
  async throws
{
  try await withLocalPeer { client, server in
    let event = NativeEvent.notice(.init(text: "Unicode 🦀\u{2028} stays in the frame"))
    var data = try JSONEncoder().encode(event)
    data.append(10)
    try await send(Data(data.prefix(5)), on: server)
    try await send(Data(data.dropFirst(5)), on: server)
    #expect(try await client.next() == event)
    let reading = Task { try await client.next() }
    reading.cancel()
    do {
      _ = try await reading.value
      Issue.record("Cancelled reader returned a message")
    } catch {}
    await client.close()
  }
}

@Test(.timeLimit(.minutes(1))) func realNetworkTransportRejectsOversizedAndIncompleteFrames()
  async throws
{
  try await withLocalPeer { client, server in
    let reading = Task { try await client.next() }
    try await send(Data(repeating: 65, count: LineConnection.maximumFrameBytes + 1), on: server)
    do {
      _ = try await reading.value
      Issue.record("Oversized frame accepted")
    } catch let error as ConnectionError { #expect(error == .frameTooLarge) }
  }
  try await withLocalPeer { client, server in
    try await send(Data("{\"type\":".utf8), on: server)
    server.send(
      content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
    do {
      _ = try await client.next()
      Issue.record("Incomplete frame accepted")
    } catch let error as ConnectionError { #expect(error == .incompleteFrame) }
  }
}

@Test(.timeLimit(.minutes(1))) func attachmentsSurviveUncertainDeliveryAndDownloadOnlyOnDemand()
  async throws
{
  try await withCoordinator { session, fixture, outbox in
    let store = AttachmentStore(
      directory: outbox.deletingLastPathComponent().appending(path: "Drafts"))
    let bytes = Data(repeating: 42, count: AttachmentLimits.chunkBytes + 17)
    let file = try await store.stage(data: bytes, name: "Notes.txt", mediaType: "text/plain")
    let address = try CoordinatorAddress(host: "100.64.1.2")
    await session.connect(address)
    _ = try await until(session) { $0.connection == .connected }
    #expect(await session.submit("", files: [file]))
    let uncertain = try await until(session) { $0.rows.contains { $0.delivery == .uncertain } }
    #expect(uncertain.rows.last?.attachments == [file.reference])
    #expect(await fixture.uploadCount() == 2)
    #expect(await fixture.uploaded(file.id) == bytes)
    let saved = try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox))
    #expect(saved.first?.attachments == [file.reference])
    // The pending copy has its own lifetime, independent of the picker/draft copy.
    try await store.remove(file)
    let pendingFile = outbox.deletingLastPathComponent().appending(
      path: "Attachments/\(file.id)/Notes.txt")
    #expect(try Data(contentsOf: pendingFile) == bytes)
    // Uncached previews require the lost-reply connection to recover first.
    _ = try await until(session) { $0.connection == .connected }
    let preview = try await session.preview(file.reference)
    #expect(try Data(contentsOf: preview) == bytes)
    #expect(try await session.preview(file.reference) == preview)
    #expect(await session.submit("/help", files: [file]) == false)
    #expect(await fixture.count() == 1, "A rejected control must not admit or clear its files")
    await session.disconnect()
    await session.connect(address)
    _ = try await until(session) { $0.connection == .connected && $0.rows.last?.delivery == nil }
    #expect(await fixture.count() == 1)
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)).isEmpty)
  }
}

@Test(.timeLimit(.minutes(1))) func feedbackReceiptAcknowledgesTheOriginalDurableInput()
  async throws
{
  try await withCoordinator { session, _, outbox in
    let store = AttachmentStore(
      directory: outbox.deletingLastPathComponent().appending(path: "Drafts"))
    let file = try await store.stage(
      data: Data([1, 2, 3]), name: "Feedback.png", mediaType: "image/png")
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    _ = try await until(session) { $0.connection == .connected }
    #expect(await session.submit("/feedback Fix this", files: [file]))
    let result = try await until(session) {
      $0.rows.contains { $0.text.contains("Repair task: repair-fixture") }
    }
    #expect(result.rows.first(where: { $0.role == .user })?.delivery == .saved)
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)).isEmpty)
  }
}

@Test(.timeLimit(.minutes(1))) func rejectedUploadRestoresFilesUnderTheDraftOwnersLifetime()
  async throws
{
  try await withCoordinator { session, fixture, outbox in
    let store = AttachmentStore(
      directory: outbox.deletingLastPathComponent().appending(path: "Drafts"))
    let bytes = Data("Keep this file".utf8)
    let file = try await store.stage(data: bytes, name: "Notes.txt", mediaType: "text/plain")
    await fixture.refuseUploads()
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    _ = try await until(session) { $0.connection == .connected }
    #expect(await session.submit("Fix this", files: [file]))
    let rejected = try await until(session) { $0.rows.last?.delivery == .rejected }
    let id = try #require(rejected.rows.last?.inputID)
    #expect(await fixture.count() == 0, "Upload refusal must happen before input admission")
    try await store.remove(file)
    let restored = try #require(await session.restore(id, to: store))
    #expect(restored.text == "Fix this")
    let restoredFile = try #require(restored.attachments.first)
    #expect(restoredFile.id != file.id)
    #expect(
      restoredFile.url.deletingLastPathComponent().deletingLastPathComponent()
        == file.url.deletingLastPathComponent().deletingLastPathComponent())
    #expect(try Data(contentsOf: restoredFile.url) == bytes)
    try await store.remove(restoredFile)
    #expect(!FileManager.default.fileExists(atPath: restoredFile.url.path))
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)).isEmpty)
  }
}

private func until(_ session: CoordinatorSession, _ predicate: @Sendable (ChatSnapshot) -> Bool)
  async throws -> ChatSnapshot
{
  for await snapshot in session.updates where predicate(snapshot) { return snapshot }
  throw ConnectionError.closed
}

@Test(.timeLimit(.minutes(1))) func sessionPersistsUncertainInputAndReconcilesWithoutReplay()
  async throws
{
  try await withCoordinator { session, fixture, outbox in
    let address = try CoordinatorAddress(host: "100.64.1.2")
    await session.connect(address)
    _ = try await until(session) { $0.connection == .connected }
    #expect(await session.submit("Keep this original") == true)
    let uncertain = try await until(session) { $0.rows.contains { $0.delivery == .uncertain } }
    let id = try #require(uncertain.rows.first(where: { $0.delivery == .uncertain })?.inputID)
    let saved = try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox))
    #expect(saved.map(\.inputId) == [id])
    await session.disconnect()
    await session.connect(address)
    let reconciled = try await until(session) {
      $0.connection == .connected
        && $0.rows.contains { $0.entryID == "placed-\(id)" && $0.delivery == nil }
    }
    #expect(reconciled.rows.filter { $0.text == "Keep this original" }.count == 1)
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)).isEmpty)
    #expect(await fixture.count() == 1, "Reconnect must not replay an uncertain write")
  }
}

@Test func interleavedHistoryPagesHaveIndependentAssemblyAndRemainChronological() {
  var transcript = Transcript()
  let action = UUID()
  let observerFirst = HistoryMessage(
    attachments: nil, continuation: false, entryId: "current", finalChunk: false, role: .final,
    text: "Current ",
    tool: nil)
  let observerLast = HistoryMessage(
    attachments: nil, continuation: true, entryId: "current", finalChunk: true, role: .final,
    text: "answer",
    tool: nil)
  let actionFirst = HistoryMessage(
    attachments: nil, continuation: false, entryId: "older", finalChunk: false, role: .user,
    text: "Older ", tool: nil
  )
  let actionLast = HistoryMessage(
    attachments: nil, continuation: true, entryId: "older", finalChunk: true, role: .user,
    text: "question", tool: nil
  )
  transcript.history(.init(messages: [observerFirst], nextCursor: nil, pageComplete: false))
  transcript.history(
    .init(messages: [actionFirst], nextCursor: nil, pageComplete: false), olderPage: true,
    requestID: action)
  transcript.history(.init(messages: [observerLast], nextCursor: "previous", pageComplete: true))
  #expect(transcript.rows.map(\.text) == ["Current answer"])
  transcript.history(
    .init(messages: [actionLast], nextCursor: "oldest", pageComplete: true), olderPage: true,
    requestID: action)
  #expect(transcript.rows.map(\.text) == ["Older question", "Current answer"])
  transcript.reconnect()
  transcript.history(
    .init(messages: [observerFirst, observerLast], nextCursor: nil, pageComplete: true))
  #expect(transcript.rows.map(\.text) == ["Older question", "Current answer"])
}

@Test func durableLiveNoticeDeduplicatesAgainstReconnectHistory() {
  var transcript = Transcript()
  let notice = HistoryMessage(
    attachments: nil, continuation: false, entryId: "durable-notice", finalChunk: true,
    role: .notice,
    text: "A useful update", tool: nil)
  transcript.message(notice)
  let stableID = transcript.rows.first?.id
  transcript.history(.init(messages: [notice], nextCursor: nil, pageComplete: true))
  transcript.message(notice)
  #expect(transcript.rows.count == 1)
  #expect(transcript.rows.first?.id == stableID)
}

@Test(.timeLimit(.minutes(1))) func readyDoesNotAdmitInputBeforeTheInitialSnapshotCompletes()
  async throws
{
  try await withCoordinator { session, fixture, _ in
    await fixture.holdSnapshot()
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    _ = try await until(session) { $0.conversationID != nil && $0.connection == .connecting }
    #expect(await session.submit("Too early") == false)
    await fixture.releaseSnapshot()
    _ = try await until(session) { $0.connection == .connected }
    #expect(await fixture.count() == 0)
  }
}
