import Foundation
import Network
import Testing

@testable import AgentCore
@testable import AgentUI

enum ReconnectBehavior: Sendable {
  case recover, close, reject, malformed, turnFailure
}

private actor ReconnectCoordinator {
  private let behavior: ReconnectBehavior
  private var sockets: [UUID: NWConnection] = [:]
  private var observers: Set<UUID> = []
  private var observations: [[String]] = []
  private var submissions: [NativeRequestSubmit] = []
  private var release: CheckedContinuation<Void, Never>?
  private var released = false
  private var stopped = false
  private var failures: [String] = []

  init(_ behavior: ReconnectBehavior) { self.behavior = behavior }
  func observedIDs() -> [[String]] { observations }
  func submitted() -> [NativeRequestSubmit] { submissions }
  func activeSockets() -> Int { sockets.count }
  func errors() -> [String] { failures }
  func dropObservers() {
    for id in observers { sockets[id]?.cancel() }
  }
  func failActiveTurn() async throws {
    for id in observers {
      guard let socket = sockets[id] else { continue }
      try await emit(
        .failure(.init(message: "The provider could not finish this turn.")), to: socket)
      try await emit(.idle, to: socket)
    }
  }
  func releaseSnapshot() {
    released = true
    release?.resume()
    release = nil
  }
  func stop() {
    stopped = true
    releaseSnapshot()
    for socket in sockets.values { socket.cancel() }
  }

  func accept(_ socket: NWConnection) async {
    let id = UUID()
    sockets[id] = socket
    defer {
      sockets.removeValue(forKey: id)
      observers.remove(id)
      socket.cancel()
    }
    socket.start(queue: .global())
    do {
      var data = Data()
      while !data.contains(10) { data.append(try await receive(socket)) }
      let end = try #require(data.firstIndex(of: 10))
      let command = try JSONDecoder().decode(NativeCommand.self, from: data.prefix(upTo: end))
      guard case .native(let command) = command else { return }
      switch command.request {
      case .observe(let request):
        observers.insert(id)
        observations.append(request.inputIds)
        if behavior == .reject {
          try await emit(.failure(.init(message: "This client is not authorized.")), to: socket)
          try await emit(.done, to: socket)
          return
        }
        if behavior == .malformed {
          try await send(Data("{\"type\":\"unsupported_event\"}\n".utf8), to: socket)
          return
        }
        try await emit(
          .ready(.init(conversationId: "fixture-root", model: "fixture/model")), to: socket)
        if observations.count > 1 && behavior == .recover && !released {
          await withCheckedContinuation { release = $0 }
        }
        guard !stopped else { return }
        let saved = submissions.filter { request.inputIds.contains($0.inputId) }
        let messages = saved.map {
          HistoryMessage(
            continuation: false, entryId: "saved-\($0.inputId)", finalChunk: true,
            role: .user, text: $0.text)
        }
        try await emit(
          .history(.init(messages: messages, nextCursor: nil, pageComplete: true)), to: socket)
        for input in saved {
          try await emit(
            .placed(.init(entryId: "saved-\(input.inputId)", inputId: input.inputId)), to: socket)
        }
        try await emit(.idle, to: socket)
        if behavior == .close { return }
        _ = try await receive(socket)
      case .submit(let input):
        submissions.append(input)
        try await emit(.accepted(.init(inputId: input.inputId)), to: socket)
        if behavior == .turnFailure {
          try await emit(
            .placed(.init(entryId: "saved-\(input.inputId)", inputId: input.inputId)), to: socket)
          try await emit(.done, to: socket)
        }
      // The server saved the input, then its reply connection disappeared.
      // Recovery must observe its original ID without repeating Submit.
      default:
        try await emit(.done, to: socket)
      }
    } catch {
      if !stopped && !(error is NWError) && (error as? ConnectionError) != .closed {
        failures.append(error.localizedDescription)
      }
    }
  }
  private func receive(_ socket: NWConnection) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      socket.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
        if let error {
          continuation.resume(throwing: error)
        } else if complete && (data?.isEmpty ?? true) {
          continuation.resume(throwing: ConnectionError.closed)
        } else {
          continuation.resume(returning: data ?? Data())
        }
      }
    }
  }
  private func emit(_ event: NativeEvent, to socket: NWConnection) async throws {
    var data = try JSONEncoder().encode(event)
    data.append(10)
    try await send(data, to: socket)
  }
  private func send(_ data: Data, to socket: NWConnection) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, any Error>) in
      socket.send(
        content: data,
        completion: .contentProcessed { error in
          if let error { continuation.resume(throwing: error) } else { continuation.resume() }
        })
    }
  }
}

@MainActor private func withReconnectCoordinator(
  _ behavior: ReconnectBehavior,
  _ body: (ChatModel, ReconnectCoordinator, URL) async throws -> Void
) async throws {
  let parameters = NWParameters.tcp
  parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
  let listener = try NWListener(using: parameters)
  let ready = AsyncThrowingStream<Void, any Error>.makeStream()
  let fixture = ReconnectCoordinator(behavior)
  listener.stateUpdateHandler = { state in
    if case .ready = state { ready.continuation.yield(()) }
    if case .failed(let error) = state { ready.continuation.finish(throwing: error) }
  }
  listener.newConnectionHandler = { socket in Task { await fixture.accept(socket) } }
  listener.start(queue: .global())
  defer { listener.cancel() }
  for try await _ in ready.stream { break }
  let port = try #require(listener.port)
  let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: directory) }
  let outbox = directory.appending(path: "pending.json")
  let session = CoordinatorSession(
    outboxURL: outbox,
    connectTransport: { _ in
      LineConnection(connection: NWConnection(host: .ipv4(.loopback), port: port, using: .tcp))
    })
  let model = ChatModel()
  await model.connect(session: session, address: try CoordinatorAddress(host: "100.64.1.2"))
  do {
    try await body(model, fixture, outbox)
    await model.stop()
    await fixture.stop()
    #expect(await fixture.errors().isEmpty)
  } catch {
    await model.stop()
    await fixture.stop()
    throw error
  }
}

@MainActor private func waitForReconnectState(_ predicate: () -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(8)
  while !predicate() {
    guard ContinuousClock.now < deadline else { throw ConnectionError.timedOut }
    try await Task.sleep(for: .milliseconds(5))
  }
}

@MainActor @Test(.timeLimit(.minutes(1)), arguments: [ReconnectBehavior.reject, .malformed])
func terminalCoordinatorRejectionStopsRetryingAndStaysOutOfHistory(_ behavior: ReconnectBehavior)
  async throws
{
  try await withReconnectCoordinator(behavior) { model, fixture, _ in
    try await waitForReconnectState { model.error != nil || model.connection != .connecting }
    try await Task.sleep(for: .milliseconds(2300))
    #expect(model.connection == .disconnected)
    #expect(model.error != nil)
    #expect(model.rows.isEmpty, "Transport and protocol errors are ephemeral UI state")
    #expect(await fixture.observedIDs().count == 1, "A terminal response requires user correction")
  }
}

@MainActor private func waitForReconnectFixture(_ predicate: () async -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(8)
  while !(await predicate()) {
    guard ContinuousClock.now < deadline else { throw ConnectionError.timedOut }
    try await Task.sleep(for: .milliseconds(5))
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
func lostActionReplyReconnectsAndReconcilesWithoutResendingOrClearingNewTyping() async throws {
  try await withReconnectCoordinator(.recover) { model, fixture, outbox in
    try await waitForReconnectState { model.connection == .connected }
    model.draft = "The original submission"
    await model.send()
    model.draft = "New typing survives reconnection"
    try await waitForReconnectState { model.connection == .reconnecting }
    #expect(model.connection.label == "Reconnecting…")
    #expect(model.error == nil)
    #expect(model.draft == "New typing survives reconnection")
    let original = try #require(model.rows.first(where: { $0.row.role == .user }))
    let originalID = original.id
    let submitted = try #require(await fixture.submitted().first)
    let pending = try JSONDecoder().decode(
      [NativeRequestSubmit].self, from: Data(contentsOf: outbox))
    #expect(pending == [submitted])
    try await waitForReconnectFixture { await fixture.observedIDs().count == 2 }
    #expect(await fixture.observedIDs().last == [submitted.inputId])
    #expect(await fixture.submitted().count == 1)
    #expect(model.connection == .reconnecting, "Ready alone cannot admit another draft")
    #expect(!model.canSend)
    await fixture.releaseSnapshot()
    try await waitForReconnectState {
      model.connection == .connected && model.rows.first?.row.delivery == nil
    }
    #expect(model.error == nil)
    #expect(model.draft == "New typing survives reconnection")
    #expect(model.rows.map(\.id) == [originalID])
    #expect(model.rows.map(\.row.text) == [submitted.text])
    #expect(await fixture.submitted().count == 1)
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)).isEmpty)
  }
}

enum ReconnectStop: Sendable { case disconnect, background, cancellation }

@MainActor
@Test(.timeLimit(.minutes(1)), arguments: [ReconnectStop.disconnect, .background, .cancellation])
func stoppingDuringReconnectClosesSocketsAndCancelsTheBackoff(_ stop: ReconnectStop) async throws {
  try await withReconnectCoordinator(.close) { model, fixture, _ in
    model.draft = "An unsent draft"
    try await waitForReconnectState { model.connection == .reconnecting }
    let attempts = await fixture.observedIDs().count
    switch stop {
    case .disconnect: await model.stop()
    case .background: await model.setActive(false)
    case .cancellation:
      let lifetime = Task { await model.runUntilCancelled() }
      lifetime.cancel()
      await lifetime.value
    }
    try await waitForReconnectFixture { await fixture.activeSockets() == 0 }
    try await Task.sleep(for: .milliseconds(2300))
    #expect(model.connection == .disconnected)
    #expect(model.draft == "An unsent draft")
    #expect(model.rows.isEmpty)
    #expect(await fixture.observedIDs().count == attempts)
    #expect(await fixture.activeSockets() == 0)
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
func backgroundClosesALiveObserverAndForegroundResumesTheSameDraft() async throws {
  try await withReconnectCoordinator(.recover) { model, fixture, _ in
    try await waitForReconnectState { model.connection == .connected }
    model.draft = "Keep this unsent draft"
    #expect(await fixture.activeSockets() == 1)
    await model.setActive(false)
    try await waitForReconnectFixture { await fixture.activeSockets() == 0 }
    try await Task.sleep(for: .milliseconds(2300))
    #expect(model.connection == .disconnected)
    #expect(await fixture.observedIDs().count == 1)
    #expect(model.draft == "Keep this unsent draft")
    await fixture.releaseSnapshot()
    await model.setActive(true)
    try await waitForReconnectState { model.connection == .connected }
    #expect(await fixture.observedIDs() == [[], []])
    #expect(await fixture.submitted().isEmpty)
    #expect(model.draft == "Keep this unsent draft")
    #expect(model.rows.isEmpty)
    #expect(model.error == nil)
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
func observerDisconnectRecoversAutomaticallyWithoutSubmittingTheUnsentDraft() async throws {
  try await withReconnectCoordinator(.recover) { model, fixture, _ in
    try await waitForReconnectState { model.connection == .connected }
    model.draft = "An unsent draft stays local"
    await fixture.dropObservers()
    try await waitForReconnectState { model.connection == .reconnecting }
    #expect(model.error == nil)
    try await waitForReconnectFixture { await fixture.observedIDs().count == 2 }
    await fixture.releaseSnapshot()
    try await waitForReconnectState { model.connection == .connected }
    #expect(model.draft == "An unsent draft stays local")
    #expect(model.error == nil)
    #expect(model.rows.isEmpty)
    #expect(await fixture.observedIDs() == [[], []])
    #expect(await fixture.submitted().isEmpty)
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
func establishedObservationSurvivesTurnFailureAndAdmitsTheNextInput() async throws {
  try await withReconnectCoordinator(.turnFailure) { model, fixture, _ in
    try await waitForReconnectState { model.connection == .connected }
    try await fixture.failActiveTurn()
    try await waitForReconnectState {
      model.error == "The provider could not finish this turn." || model.connection == .disconnected
    }
    #expect(model.connection == .connected, "A model turn failure does not reject the connection")
    #expect(model.error == "The provider could not finish this turn.")
    #expect(!model.busy)
    #expect(model.rows.isEmpty, "The failure remains ephemeral")
    model.draft = "Try the next request"
    try #require(model.canSend)
    await model.send()
    try await waitForReconnectFixture { await fixture.submitted().count == 1 }
    try await waitForReconnectState { model.rows.first?.row.delivery == nil && !model.rows.isEmpty }
    #expect(model.connection == .connected)
    #expect(model.error == nil)
    #expect(model.draft.isEmpty)
    #expect(await fixture.observedIDs().count == 1, "An ordinary turn failure must not reconnect")
  }
}
