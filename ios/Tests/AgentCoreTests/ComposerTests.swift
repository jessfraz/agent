import AgentCore
import Foundation
import Testing

@testable import AgentUI

private actor AdmissionGate {
  nonisolated let entered: AsyncStream<Void>
  private let enteredContinuation: AsyncStream<Void>.Continuation
  private var continuation: CheckedContinuation<Bool, Never>?
  private var messages: [String] = []
  init() {
    let pair = AsyncStream<Void>.makeStream()
    entered = pair.stream
    enteredContinuation = pair.continuation
  }
  func admit(_ text: String) async -> Bool {
    messages.append(text)
    return await withCheckedContinuation { continuation in
      self.continuation = continuation
      enteredContinuation.yield(())
    }
  }
  func count() -> Int { messages.count }
  func finish(_ admitted: Bool) {
    continuation?.resume(returning: admitted)
    continuation = nil
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
func sendPreservesNewTypingAndCannotAdmitTheSameDraftTwice() async {
  let gate = AdmissionGate()
  let model = ChatModel(admit: { text, _, _ in await gate.admit(text) })
  model.connection = .connected
  model.draft = "Original draft"
  let sending = Task { await model.send() }
  for await _ in gate.entered { break }
  model.draft = "New typing while admission is pending"
  await model.send()
  #expect(await gate.count() == 1)
  await gate.finish(true)
  await sending.value
  #expect(model.draft == "New typing while admission is pending")
  #expect(!model.admitting)
}

@MainActor @Test(.timeLimit(.minutes(1)), arguments: [false, true])
func durableAdmissionDoesNotEraseANewerDraftWithIdenticalText(afterClearing: Bool) async throws {
  try await withCoordinator { session, _, outbox in
    let gate = AdmissionGate()
    let model = await MainActor.run {
      ChatModel(admit: { text, mode, files in
        let admitted = await session.submit(text, mode: mode, files: files)
        #expect(admitted)
        return await gate.admit(text)
      })
    }
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    await MainActor.run {
      model.connection = .connected
      model.draft = "The same text in a different draft"
    }
    let sending = Task { await model.send() }
    for await _ in gate.entered { break }
    let pending = try JSONDecoder().decode(
      [NativeRequestSubmit].self, from: Data(contentsOf: outbox))
    #expect(pending.count == 1)
    await MainActor.run {
      if afterClearing { model.draft = "" }
      model.draft = "The same text in a different draft"
    }
    await model.send()
    #expect(await gate.count() == 1)
    await gate.finish(true)
    await sending.value
    #expect(await model.draft == "The same text in a different draft")
    #expect(await !model.admitting)
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
func sendKeepsAnUnadmittedDraftAndClearsOnlyItsAdmittedOriginal() async {
  let model = ChatModel(admit: { _, _, _ in false })
  model.connection = .connected
  model.draft = "Not saved"
  await model.send()
  #expect(model.draft == "Not saved")
  let admitted = ChatModel(admit: { _, _, _ in true })
  admitted.connection = .connected
  admitted.draft = "Saved original"
  await admitted.send()
  #expect(admitted.draft.isEmpty)
}

@MainActor @Test(.timeLimit(.minutes(1)))
func feedbackCapturesOnceAndFailedAdmissionKeepsTheExactScreenshot() async throws {
  let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root) }
  let model = ChatModel(
    draftStore: AttachmentStore(directory: root), admit: { _, _, _ in false })
  model.connection = .connected
  model.draft = "/feedback The text is clipped"
  var captures = 0
  await model.send(screenshot: {
    captures += 1
    return Data([1, 2, 3])
  })
  let original = try #require(model.attachments.first)
  await model.send(screenshot: {
    captures += 1
    return Data([4, 5, 6])
  })
  #expect(captures == 1)
  #expect(model.attachments == [original])
  #expect(try Data(contentsOf: original.url) == Data([1, 2, 3]))
  #expect(model.draft == "/feedback The text is clipped")
}

@MainActor @Test(.timeLimit(.minutes(1)))
func attachmentOnlyAdmissionPreservesFilesAddedWhileTheOriginalIsSaving() async throws {
  let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root) }
  let gate = AdmissionGate()
  let model = ChatModel(
    draftStore: AttachmentStore(directory: root),
    admit: { text, _, files in
      #expect(text.isEmpty)
      #expect(files.count == 1)
      return await gate.admit(text)
    })
  model.connection = .connected
  await model.attach(data: Data([1]), name: "First.txt", mediaType: "text/plain")
  let sending = Task { await model.send() }
  for await _ in gate.entered { break }
  await model.attach(data: Data([2]), name: "Second.txt", mediaType: "text/plain")
  await gate.finish(true)
  await sending.value
  #expect(model.attachments.map(\.reference.name) == ["Second.txt"])
  #expect(try Data(contentsOf: #require(model.attachments.first).url) == Data([2]))
}

@MainActor private func connectModelThenRelease(_ session: CoordinatorSession) async throws {
  let model = ChatModel()
  await model.connect(session: session, address: try CoordinatorAddress(host: "100.64.1.2"))
  while model.connection != .connected { try await Task.sleep(for: .milliseconds(1)) }
}

@Test(.timeLimit(.minutes(1)))
func viewLifetimeCancellationAndModelDestructionBothCloseTheirSockets() async throws {
  try await withCoordinator { session, fixture, _ in
    let model = await MainActor.run { ChatModel() }
    await model.connect(session: session, address: try CoordinatorAddress(host: "100.64.1.2"))
    let lifetime = Task { await model.runUntilCancelled() }
    while await model.connection != .connected { try await Task.sleep(for: .milliseconds(1)) }
    lifetime.cancel()
    await lifetime.value
    for await _ in fixture.closedObservations { break }
    #expect(await model.connection == .disconnected)
    #expect(await session.submit("No orphaned observer") == false)
  }
  try await withCoordinator { session, fixture, _ in
    try await connectModelThenRelease(session)
    for await _ in fixture.closedObservations { break }
    #expect(await session.submit("Model was released") == false)
  }
}
