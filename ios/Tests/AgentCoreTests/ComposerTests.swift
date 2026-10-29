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
  let model = ChatModel(admit: { text, _ in await gate.admit(text) })
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

@MainActor @Test(.timeLimit(.minutes(1)))
func sendKeepsAnUnadmittedDraftAndClearsOnlyItsAdmittedOriginal() async {
  let model = ChatModel(admit: { _, _ in false })
  model.connection = .connected
  model.draft = "Not saved"
  await model.send()
  #expect(model.draft == "Not saved")
  let admitted = ChatModel(admit: { _, _ in true })
  admitted.connection = .connected
  admitted.draft = "Saved original"
  await admitted.send()
  #expect(admitted.draft.isEmpty)
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
