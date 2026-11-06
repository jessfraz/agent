import Foundation
import Network
import Testing

@testable import AgentCore
@testable import AgentUI

enum ReconnectBehavior: Sendable {
  case recover, close, reject, malformed, turnFailure, acknowledged, paused, active
}

private actor ReconnectCoordinator {
  private let behavior: ReconnectBehavior
  private var sockets: [UUID: NWConnection] = [:]
  private var observers: Set<UUID> = []
  private var observations: [[String]] = []
  private var sourceStatusRequests: [Bool?] = []
  private var submissions: [NativeRequestSubmit] = []
  private var acceptedWork: InputWorkState?
  private var release: CheckedContinuation<Void, Never>?
  private var released = false
  private var stopped = false
  private var failures: [String] = []

  init(_ behavior: ReconnectBehavior) { self.behavior = behavior }
  func observedIDs() -> [[String]] { observations }
  func requestedSourceStatus() -> [Bool?] { sourceStatusRequests }
  func submitted() -> [NativeRequestSubmit] { submissions }
  func describeWork(_ work: InputWorkState?) { acceptedWork = work }
  func placeSubmissions() async throws {
    for id in observers {
      guard let socket = sockets[id] else { continue }
      for input in submissions {
        try await emit(
          .placed(.init(entryId: "saved-\(input.inputId)", inputId: input.inputId)), to: socket)
      }
    }
  }
  func activeSockets() -> Int { sockets.count }
  func errors() -> [String] { failures }
  func observerEvent(_ event: NativeEvent) async throws {
    for id in observers {
      if let socket = sockets[id] { try await emit(event, to: socket) }
    }
  }
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
        sourceStatusRequests.append(request.sourceStatus)
        if behavior == .reject {
          try await emit(.failure(.init(message: "This client is not authorized.")), to: socket)
          try await emit(.done, to: socket)
          _ = try await receive(socket)
          return
        }
        if behavior == .malformed {
          try await send(Data("{\"type\":\"unsupported_event\"}\n".utf8), to: socket)
          // A queued send is not proof of peer consumption. Keep the terminal
          // frame alive until the real reader rejects it and closes its socket.
          _ = try await receive(socket)
          return
        }
        try await emit(
          .ready(.init(conversationId: "fixture-root", model: "fixture/model")), to: socket)
        if observations.count > 1 && behavior == .recover && !released {
          await withCheckedContinuation { release = $0 }
        }
        guard !stopped else { return }
        let saved = submissions.filter { request.inputIds.contains($0.inputId) }
        let messages = (behavior == .acknowledged ? [] : saved).map {
          HistoryMessage(
            continuation: false, entryId: "saved-\($0.inputId)", finalChunk: true,
            role: .user, text: $0.text)
        }
        try await emit(
          .history(.init(messages: messages, nextCursor: nil, pageComplete: true)), to: socket)
        for input in saved {
          if behavior == .acknowledged {
            if let acceptedWork {
              try await emit(
                .accepted(.init(inputId: input.inputId, work: acceptedWork)), to: socket)
            }
          } else {
            try await emit(
              .placed(.init(entryId: "saved-\(input.inputId)", inputId: input.inputId)), to: socket)
          }
        }
        if behavior == .paused {
          try await emit(
            .failure(.init(message: "Main processing is paused after repeated restarts.")),
            to: socket)
        } else if behavior == .active {
          try await emit(
            .activity(.init(activity: .toolStarted(.init(callId: "active-call", name: "check")))),
            to: socket)
        } else {
          try await emit(.idle, to: socket)
        }
        if behavior == .close { return }
        _ = try await receive(socket)
      case .submit(let input):
        submissions.append(input)
        try await emit(.accepted(.init(inputId: input.inputId, work: acceptedWork)), to: socket)
        if behavior == .turnFailure {
          try await emit(
            .placed(.init(entryId: "saved-\(input.inputId)", inputId: input.inputId)), to: socket)
          try await emit(.done, to: socket)
        } else if behavior == .active {
          try await emit(.failure(.init(message: "The action status read failed.")), to: socket)
          try await emit(.done, to: socket)
        } else if behavior == .acknowledged {
          _ = try await receive(socket)
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
  try await withReconnectCoordinator(behavior) { model, fixture, outbox, _ in
    try await body(model, fixture, outbox)
  }
}

@MainActor private func withReconnectCoordinator(
  _ behavior: ReconnectBehavior,
  _ body: (ChatModel, ReconnectCoordinator, URL, @Sendable () -> CoordinatorSession) async throws ->
    Void
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
  let makeSession: @Sendable () -> CoordinatorSession = {
    CoordinatorSession(
      outboxURL: outbox,
      connectTransport: { _ in
        LineConnection(connection: NWConnection(host: .ipv4(.loopback), port: port, using: .tcp))
      })
  }
  let session = makeSession()
  let model = ChatModel()
  await model.connect(session: session, address: try CoordinatorAddress(host: "100.64.1.2"))
  do {
    try await body(model, fixture, outbox, makeSession)
    await model.stop()
    await fixture.stop()
    #expect(await fixture.errors().isEmpty)
  } catch {
    await model.stop()
    await fixture.stop()
    throw error
  }
}

private enum AcknowledgementReconnect: Sendable { case suspension, sessionReopen }

@MainActor
@Test(.timeLimit(.minutes(1)), arguments: [AcknowledgementReconnect.suspension, .sessionReopen])
private func acknowledgedInputsRemainSavedAcrossClientLifecycleAndCannotBeResubmitted(
  _ reconnect: AcknowledgementReconnect
) async throws {
  try await withReconnectCoordinator(.acknowledged) { model, fixture, outbox, makeSession in
    try await waitForReconnectState { model.connection == .connected }
    model.draft = "Continue the supplier drawing review"
    await model.send()
    try await waitForReconnectState { model.rows.first?.row.delivery == .saved }
    let input = try #require(await fixture.submitted().first)
    let originalID = try #require(model.rows.first?.id)
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)) == [
        input
      ])
    switch reconnect {
    case .suspension:
      await model.setActive(false)
      #expect(
        model.rows.first?.row.delivery == .saved, "Suspension cannot undo coordinator admission")
      await model.setActive(true)
    case .sessionReopen:
      await model.stop()
      await model.connect(
        session: makeSession(), address: try CoordinatorAddress(host: "100.64.1.2"))
    }
    try await waitForReconnectFixture { await fixture.observedIDs().count == 2 }
    try await waitForReconnectState { model.connection == .connected }
    #expect(model.rows.map(\.id) == [originalID])
    #expect(model.rows.first?.row.delivery == .saved)
    #expect(model.rows.first?.row.work == nil)
    #expect(await fixture.observedIDs().last == [input.inputId])
    await model.restore(input.inputId)
    #expect(model.draft.isEmpty, "A stale restore action cannot recreate an accepted input")
    #expect(model.attachments.isEmpty)
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox)) == [
        input
      ])
    await model.retry(input.inputId)
    try await Task.sleep(for: .milliseconds(100))
    #expect(
      await fixture.submitted() == [input], "An acknowledged input is observed, never resubmitted")
    #expect(model.rows.first?.row.delivery == .saved)
    #expect(model.error == nil)
  }
}

@MainActor
@Test(
  .timeLimit(.minutes(1)),
  arguments: [
    InputWorkState.queued, .running, .completed(.init(answerEntryId: "saved-answer")),
    .blocked(.init(reason: .restartLimit)), .blocked(.init(reason: .missingTask)),
    .blocked(.init(reason: .taskTooOld)), .blocked(.init(reason: .migrationFailed)), .stopped,
  ])
private func admittedInputWorkReconcilesAfterReopenWithoutBecomingADeliveryError(
  _ work: InputWorkState
)
  async throws
{
  try await withReconnectCoordinator(.acknowledged) { model, fixture, _, makeSession in
    try await waitForReconnectState { model.connection == .connected }
    await fixture.describeWork(work)
    model.draft = "Review the connector drawing"
    await model.send()
    try await waitForReconnectState { model.rows.first?.row.delivery == .saved }
    #expect(model.rows.first?.row.work == work)
    #expect(model.error == nil)
    #expect(!work.label.isEmpty)
    if case .completed = work { #expect(work.label == "Completed") }
    if case .blocked = work { #expect(work.label.hasPrefix("Processing paused")) }
    await model.stop()
    await model.connect(session: makeSession(), address: try CoordinatorAddress(host: "100.64.1.2"))
    try await waitForReconnectState {
      model.connection == .connected && model.rows.first?.row.work == work
    }
    #expect(model.rows.first?.row.delivery == .saved)
    #expect(model.rows.first?.row.work == work)
    #expect(model.error == nil)
    #expect(await fixture.submitted().count == 1)
    await fixture.describeWork(nil)
    await model.setActive(false)
    await model.setActive(true)
    // Foregrounding requests a connection; the model can still expose the
    // previous connected snapshot until its observer applies reconciliation.
    try await waitForReconnectState {
      model.connection == .connected && model.rows.first?.row.work == nil
    }
    #expect(model.rows.first?.row.delivery == .saved)
    #expect(
      model.rows.first?.row.work == nil, "An older server cannot leave a stale execution badge")
    let submitted = try #require(await fixture.submitted().first)
    try await fixture.placeSubmissions()
    try await waitForReconnectState {
      model.rows.first?.row.entryID == "saved-\(submitted.inputId)"
        && model.rows.first?.row.delivery == .saved
    }
    #expect(
      model.rows.first?.row.work == nil, "Placement retires the badge without inferring completion")
    #expect(model.error == nil)
  }
}

@MainActor
@Test(
  .timeLimit(.minutes(1)),
  arguments: [
    NativeEvent.ready(.init(conversationId: "fixture-root", model: "fixture/model")),
    .textDelta(.init(text: "Continuing the review")),
    .activity(.init(activity: .toolStarted(.init(callId: "resumed-call", name: "check")))),
  ])
private func pausedObserverWithoutPendingInputsStopsWorkingAndClearsThePauseOnResume(
  _ resume: NativeEvent
)
  async throws
{
  try await withReconnectCoordinator(.paused) { model, fixture, _ in
    try await waitForReconnectState { model.connection == .connected && model.error != nil }
    #expect(!model.busy, "A parked main conversation is paused, not still working")
    #expect(model.rows.isEmpty, "The processing pause is connection state, not history")
    #expect(await fixture.observedIDs() == [[]])
    try await fixture.observerEvent(resume)
    try await waitForReconnectState { model.busy && model.error == nil }
    #expect(model.connection == .connected)
    #expect(await fixture.observedIDs().count == 1)
    #expect(await fixture.submitted().isEmpty)
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
private func actionFailureDoesNotStopTheObserversActiveWorkOrUndoAdmission() async throws {
  try await withReconnectCoordinator(.active) { model, fixture, _ in
    try await waitForReconnectState { model.connection == .connected && model.busy }
    model.draft = "Check the related drawing"
    await model.send()
    try await waitForReconnectState { model.error != nil }
    #expect(model.busy)
    #expect(model.connection == .connected)
    #expect(model.rows.first(where: { $0.row.role == .user })?.row.delivery == .saved)
    #expect(await fixture.submitted().count == 1)
  }
}

@MainActor private func waitForReconnectState(_ predicate: () -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(8)
  while !predicate() {
    guard ContinuousClock.now < deadline else { throw ConnectionError.timedOut }
    try await Task.sleep(for: .milliseconds(5))
  }
}

@MainActor @Test(.timeLimit(.minutes(1)))
private func sourceCoverageShowsOneTransientWarningAndClearsWithoutChangingHistory() async throws {
  try await withReconnectCoordinator(.recover) { model, fixture, _ in
    try await waitForReconnectState { model.connection == .connected }
    #expect(await fixture.requestedSourceStatus() == [true])
    let state: (SourceCoverage, Int) -> SourceState = { coverage, checkedAt in
      SourceState(
        checkedAt: checkedAt, checkpoint: nil, coverage: coverage,
        source: SourceKey(account: "private-account", provider: "google"))
    }
    let healthy = SourceState(
      checkedAt: 1_800_000_000_000, checkpoint: nil, coverage: .complete,
      source: SourceKey(account: "local-messages", provider: "messages"))
    for checkedAt in 1...2 {
      let states = [state(.unavailable(.init(message: "private-diagnostic")), checkedAt), healthy]
      try await fixture.observerEvent(
        .sources(.init(sources: states)))
      try await fixture.observerEvent(
        .ready(.init(conversationId: "fixture-root", model: "coverage-\(checkedAt)")))
      try await fixture.observerEvent(.idle)
      try await waitForReconnectState { model.model == "coverage-\(checkedAt)" && !model.busy }
      #expect(model.sourceWarning == "Source checks incomplete: Gmail unavailable")
      #expect(model.sources == states, "Retain per-account errors, healthy sources and check times")
      #expect(model.rows.isEmpty)
      #expect(model.error == nil)
    }
    try await fixture.observerEvent(
      .sources(.init(sources: [state(.partial(.init(message: "private-diagnostic")), 3)])))
    try await fixture.observerEvent(
      .ready(.init(conversationId: "fixture-root", model: "coverage-3")))
    try await waitForReconnectState { model.model == "coverage-3" }
    #expect(model.sourceWarning == "Source checks incomplete: Gmail partial")
    #expect(model.sources == [state(.partial(.init(message: "private-diagnostic")), 3)])
    for (index, coverage) in [SourceCoverage.more, .complete].enumerated() {
      try await fixture.observerEvent(.sources(.init(sources: [state(coverage, index + 4)])))
      try await fixture.observerEvent(
        .ready(.init(conversationId: "fixture-root", model: "healthy-\(index)")))
      try await fixture.observerEvent(.idle)
      try await waitForReconnectState { model.model == "healthy-\(index)" && !model.busy }
      #expect(model.sourceWarning == nil)
      #expect(
        model.sources == [state(coverage, index + 4)], "Recovered coverage replaces old errors")
    }
    #expect(model.rows.isEmpty)
    #expect(model.error == nil)
    #expect(await fixture.submitted().isEmpty)
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
func acknowledgedActionReplyReconnectsAndReconcilesWithoutResendingOrClearingNewTyping()
  async throws
{
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
    #expect(
      original.row.delivery == .saved, "A lost action socket cannot undo the accepted receipt")
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
      model.connection == .connected
        && model.rows.first?.row.entryID == "saved-\(submitted.inputId)"
        && model.rows.first?.row.delivery == .saved
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
    let submitted = try #require(await fixture.submitted().first)
    try await waitForReconnectState {
      model.rows.first?.row.entryID == "saved-\(submitted.inputId)"
        && model.rows.first?.row.delivery == .saved
    }
    #expect(model.connection == .connected)
    #expect(model.error == nil)
    #expect(model.draft.isEmpty)
    #expect(await fixture.observedIDs().count == 1, "An ordinary turn failure must not reconnect")
  }
}
