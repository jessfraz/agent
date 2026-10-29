import Foundation
import Network
import Testing

@testable import AgentCore

private struct PreviewLifecycleState: Sendable {
  var connecting = 0
  var finished = 0
  var cancelled = 0
  var succeeded = 0
  var closed = 0
}

/// Delays connection creation at the same await as DNS, without replacing the transport.
private actor PreviewConnectionGate {
  nonisolated let updates: AsyncStream<PreviewLifecycleState>
  private let continuation: AsyncStream<PreviewLifecycleState>.Continuation
  private var state = PreviewLifecycleState()
  private var holding = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  init() {
    let pair = AsyncStream<PreviewLifecycleState>.makeStream(bufferingPolicy: .bufferingNewest(1))
    updates = pair.stream
    continuation = pair.continuation
  }

  func hold() {
    #expect(waiting.isEmpty)
    state = PreviewLifecycleState()
    holding = true
    continuation.yield(state)
  }

  func enter() async -> Bool {
    guard holding else { return false }
    state.connecting += 1
    continuation.yield(state)
    await withCheckedContinuation { waiting.append($0) }
    return true
  }

  func release() {
    holding = false
    let owned = waiting
    waiting = []
    for waiter in owned { waiter.resume() }
  }

  func finish(_ error: (any Error)?) {
    state.finished += 1
    if error == nil { state.succeeded += 1 }
    if error is CancellationError { state.cancelled += 1 }
    continuation.yield(state)
  }

  func closed() {
    state.closed += 1
    continuation.yield(state)
  }
}

private func previewState(
  _ gate: PreviewConnectionGate,
  until predicate: @Sendable (PreviewLifecycleState) -> Bool
) async throws -> PreviewLifecycleState {
  for await state in gate.updates where predicate(state) { return state }
  throw CancellationError()
}

private func connected(_ session: CoordinatorSession) async throws {
  for await state in session.updates where state.connection == .connected { return }
  throw ConnectionError.closed
}

private func withGatedPreviewCoordinator(
  _ body: @Sendable (CoordinatorSession, PreviewConnectionGate) async throws -> Void
) async throws {
  let parameters = NWParameters.tcp
  parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
  let listener = try NWListener(using: parameters)
  let ready = AsyncThrowingStream<Void, any Error>.makeStream()
  let fixture = FixtureCoordinator()
  let gate = PreviewConnectionGate()
  listener.stateUpdateHandler = { state in
    if case .ready = state { ready.continuation.yield(()) }
    if case .failed(let error) = state { ready.continuation.finish(throwing: error) }
  }
  listener.newConnectionHandler = { socket in
    Task {
      do { try await fixture.accept(socket) } catch ConnectionError.closed {
        // Cancelled lookups close their connection before sending a command.
      } catch let error as NWError where error == .posix(.ECANCELED) {
        // Network.framework can report the same owned cancellation directly.
      } catch { Issue.record(error) }
    }
  }
  listener.start(queue: .global())
  defer { listener.cancel() }
  for try await _ in ready.stream { break }
  let port = try #require(listener.port)
  let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: directory) }
  let session = CoordinatorSession(
    outboxURL: directory.appending(path: "pending.json"),
    connectTransport: { _ in
      let delayed = await gate.enter()
      let socket = NWConnection(host: .ipv4(.loopback), port: port, using: .tcp)
      if delayed {
        socket.stateUpdateHandler = { state in
          if case .cancelled = state { Task { await gate.closed() } }
        }
      }
      return LineConnection(connection: socket)
    })
  do {
    try await body(session, gate)
    await session.disconnect()
    await gate.release()
    await fixture.stop()
  } catch {
    await session.disconnect()
    await gate.release()
    await fixture.stop()
    throw error
  }
}

@Test(.timeLimit(.minutes(1)))
func previewCapacityIncludesPendingLookupsAndCancellationReleasesTheirOwnedConnections()
  async throws
{
  try await withGatedPreviewCoordinator { session, gate in
    let address = try CoordinatorAddress(host: "100.64.1.2")
    let reference = AttachmentRef(
      id: UUID().uuidString, mediaType: "text/plain", name: "Evidence.txt",
      sha256: String(repeating: "0", count: 64), sizeBytes: 0)
    await session.connect(address)
    try await connected(session)
    await gate.hold()
    let requests = (0..<40).map { _ in
      Task {
        do {
          _ = try await session.preview(reference)
          await gate.finish(nil)
        } catch { await gate.finish(error) }
      }
    }
    let admitted = try await previewState(gate) { $0.connecting + $0.finished == 40 }
    #expect(admitted.connecting == 32)
    #expect(admitted.finished == 8)
    #expect(admitted.succeeded == 0)
    for request in requests { request.cancel() }
    await session.disconnect()
    await gate.release()
    for request in requests { await request.value }
    let released = try await previewState(gate) { $0.closed == admitted.connecting }
    #expect(released.cancelled == admitted.connecting)
    #expect(released.succeeded == 0)

    // A new connection generation can use capacity returned by the cancelled previews.
    await session.connect(address)
    try await connected(session)
    await gate.hold()
    let next = Task {
      do {
        _ = try await session.preview(reference)
        await gate.finish(nil)
      } catch { await gate.finish(error) }
    }
    let reopened = try await previewState(gate) { $0.connecting == 1 || $0.finished == 1 }
    try #require(reopened.connecting == 1)
    next.cancel()
    await session.disconnect()
    await gate.release()
    await next.value
    let reconnected = try await previewState(gate) { $0.closed == 1 }
    #expect(reconnected.cancelled == 1)
    #expect(reconnected.succeeded == 0)
  }
}
