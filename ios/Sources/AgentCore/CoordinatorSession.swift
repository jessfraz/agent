import Foundation

public enum ConnectionState: Sendable, Equatable {
  case disconnected, connecting, connected
  case retrying(String)
  public var label: String {
    switch self {
    case .disconnected: "Disconnected"
    case .connecting: "Connecting"
    case .connected: "Connected via Tailscale"
    case .retrying(let reason): reason
    }
  }
}

public struct ChatSnapshot: Sendable {
  public var rows: [ChatRow] = []
  public var connection: ConnectionState = .disconnected
  public var conversationID: String?
  public var model = "Main conversation"
  public var busy = false
  public var commands: [SlashCommand] = []
  public var olderCursor: String?
  public var loadingHistory = false
  public var error: String?
}

/// Owns all network work, decoding, rendering preparation and the on-device outbox.
/// Reconnect observes and reconciles. It never automatically replays an uncertain write.
public actor CoordinatorSession {
  public nonisolated let updates: AsyncStream<ChatSnapshot>
  private let continuation: AsyncStream<ChatSnapshot>.Continuation
  private var snapshot = ChatSnapshot()
  private var transcript = Transcript()
  private var address: CoordinatorAddress?
  private var observation: Task<Void, Never>?
  private var connection: LineConnection?
  private var actions: [UUID: Task<Void, Never>] = [:]
  private var actionConnections: [UUID: LineConnection] = [:]
  private var pending: [NativeRequestSubmit] = []
  private var generation = UUID()
  private var flush: Task<Void, Never>?
  private let outboxURL: URL
  private let connectTransport: @Sendable (CoordinatorAddress) throws -> LineConnection

  public init(outboxURL: URL) {
    self.init(outboxURL: outboxURL, connectTransport: { try LineConnection(address: $0) })
  }
  init(
    outboxURL: URL,
    connectTransport: @escaping @Sendable (CoordinatorAddress) throws -> LineConnection
  ) {
    self.outboxURL = outboxURL
    self.connectTransport = connectTransport
    let pair = AsyncStream<ChatSnapshot>.makeStream(bufferingPolicy: .bufferingNewest(1))
    updates = pair.stream
    continuation = pair.continuation
  }

  public func connect(_ address: CoordinatorAddress) async {
    let generation = UUID()
    await disconnect(generation: generation)
    guard self.generation == generation else { return }
    self.address = address
    do {
      pending = try JSONDecoder().decode(
        [NativeRequestSubmit].self, from: Data(contentsOf: outboxURL))
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile { pending = [] } catch {
      snapshot.error =
        "The saved outbox could not be read. It was preserved; no messages were replayed."
      publish()
      return
    }
    // A different coordinator must never inherit another coordinator's outbox.
    // The UI supplies a per-endpoint outbox directory, not a shared queue.
    for request in pending { transcript.pending(request, delivery: .uncertain) }
    observation = Task { [weak self] in await self?.observe(address, generation: generation) }
  }

  public func disconnect() async { await disconnect(generation: UUID()) }
  private func disconnect(generation: UUID) async {
    self.generation = generation
    observation?.cancel()
    observation = nil
    flush?.cancel()
    flush = nil
    for action in actions.values { action.cancel() }
    actions = [:]
    let ownedConnections = Array(actionConnections.values) + [connection].compactMap { $0 }
    actionConnections = [:]
    connection = nil
    snapshot.connection = .disconnected
    snapshot.loadingHistory = false
    for request in pending { transcript.delivery(request.inputId, .uncertain) }
    publish()
    for connection in ownedConnections { await connection.close() }
  }

  @discardableResult public func submit(_ text: String, mode: InputMode = .steer) -> Bool {
    guard actions.count < 32, snapshot.connection == .connected,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return false }
    guard text.utf8.count <= 65536 else {
      snapshot.error = "Messages must be at most 64 KiB."
      publish()
      return false
    }
    let request = NativeRequestSubmit(inputId: UUID().uuidString, mode: mode, text: text)
    let control =
      text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
      || text.trimmingCharacters(in: .whitespacesAndNewlines) == "?"
    if !control {
      guard pending.count < 32 else {
        snapshot.error = "Resolve pending messages before sending more."
        publish()
        return false
      }
      pending.append(request)
      do { try saveOutbox() } catch {
        pending.removeLast()
        snapshot.error = "The on-device outbox could not be saved. Nothing was sent."
        publish()
        return false
      }
      transcript.pending(request, delivery: .sending)
    }
    snapshot.error = nil
    perform(.submit(request), inputID: control ? nil : request.inputId)
    publish()
    return true
  }

  public func retry(_ inputID: String) {
    guard actions.count < 32, snapshot.connection == .connected,
      let request = pending.first(where: { $0.inputId == inputID })
    else { return }
    transcript.delivery(inputID, .sending)
    perform(.submit(request), inputID: inputID)
    publish()
  }
  public func restore(_ inputID: String) -> String? {
    guard let request = pending.first(where: { $0.inputId == inputID }) else { return nil }
    pending.removeAll { $0.inputId == inputID }
    persistOutboxOrReport()
    transcript.delivery(inputID, .rejected)
    publish()
    return request.text
  }
  public func loadEarlier() {
    guard actions.count < 32, let cursor = snapshot.olderCursor, !snapshot.loadingHistory,
      snapshot.connection == .connected
    else { return }
    snapshot.loadingHistory = true
    perform(.history(.init(cursor: cursor)))
    publish()
  }
  public func interrupt() {
    if actions.count < 32, snapshot.connection == .connected { perform(.interrupt) }
  }

  private func observe(_ address: CoordinatorAddress, generation: UUID) async {
    var attempt = 0
    while !Task.isCancelled && self.generation == generation {
      var stream: LineConnection?
      do {
        transcript.reconnect()
        snapshot.connection = .connecting
        publish()
        let opened = try connectTransport(address)
        stream = opened
        connection = opened
        let stream = opened
        var ready = false
        try await timedSend(stream, .observe(.init(inputIds: pending.map(\.inputId))))
        while !Task.isCancelled {
          let event =
            try await (snapshot.connection == .connected ? stream.next() : timedNext(stream))
          guard self.generation == generation else { return }
          if case .ready = event { ready = true }
          if case .history(let frame) = event, frame.pageComplete, ready {
            attempt = 0
            snapshot.connection = .connected
            snapshot.error = nil
          }
          if case .done = event { throw ConnectionError.closed }
          consume(event)
          schedulePublish()
        }
      } catch {
        await stream?.close()
        guard !Task.isCancelled, self.generation == generation else { return }
        connection = nil
        for request in pending { transcript.delivery(request.inputId, .uncertain) }
        snapshot.connection = .retrying(error.localizedDescription)
        snapshot.busy = false
        publish()
        attempt = min(attempt + 1, 5)
        do { try await Task.sleep(for: .seconds(1 << attempt)) } catch { return }
      }
    }
  }
  private func perform(_ request: NativeRequest, inputID: String? = nil) {
    guard let address else { return }
    let id = UUID()
    let generation = generation
    actions[id] = Task { [weak self] in
      await self?.exchange(
        id: id, address: address, request: request, inputID: inputID, generation: generation)
    }
  }
  private func exchange(
    id: UUID, address: CoordinatorAddress, request: NativeRequest, inputID: String?,
    generation: UUID
  ) async {
    defer {
      actions.removeValue(forKey: id)
      transcript.abandonHistory(id)
    }
    do {
      let stream = try connectTransport(address)
      actionConnections[id] = stream
      try await timedSend(stream, request)
      while !Task.isCancelled {
        let event = try await timedNext(stream)
        guard self.generation == generation else { break }
        if case .done = event { break }
        if case .disconnect = event {
          await disconnect()
          return
        }
        // The observer alone owns live transcript presentation. Action
        // responses carry acknowledgements, controls and history pages.
        switch event {
        case .message, .answer, .textDelta, .activity, .ready, .idle: break
        default: consume(event, historyRequestID: id)
        }
        schedulePublish()
        if case .placed(let placed) = event, placed.inputId == inputID { break }
        if case .rejected(let rejected) = event, rejected.inputId == inputID { break }
      }
    } catch {
      if self.generation == generation && !Task.isCancelled {
        if let inputID { transcript.delivery(inputID, .uncertain) }
        snapshot.error = error.localizedDescription
      }
    }
    await actionConnections.removeValue(forKey: id)?.close()
    if self.generation == generation {
      snapshot.loadingHistory = false
      publish()
    }
  }
  private func timedNext(_ connection: LineConnection) async throws -> NativeEvent {
    try await withThrowingTaskGroup(of: NativeEvent.self) { group in
      group.addTask { try await connection.next() }
      group.addTask {
        try await Task.sleep(for: .seconds(30))
        throw ConnectionError.timedOut
      }
      defer { group.cancelAll() }
      guard let event = try await group.next() else { throw ConnectionError.closed }
      return event
    }
  }
  private func timedSend(_ connection: LineConnection, _ request: NativeRequest) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
      group.addTask { try await connection.send(request) }
      group.addTask {
        try await Task.sleep(for: .seconds(15))
        await connection.close()
        throw ConnectionError.timedOut
      }
      defer { group.cancelAll() }
      try await group.next()
    }
  }
  private func consume(_ event: NativeEvent, historyRequestID: UUID? = nil) {
    switch event {
    case .commands(let value): snapshot.commands = value.commands
    case .ready(let value):
      snapshot.conversationID = value.conversationId
      snapshot.model = value.model
      snapshot.busy = true
    case .history(let value):
      transcript.history(value, olderPage: historyRequestID != nil, requestID: historyRequestID)
      if value.pageComplete {
        snapshot.olderCursor = value.nextCursor
        snapshot.loadingHistory = false
      }
    case .message(let value): transcript.message(value.message)
    case .answer(let value): transcript.answer(value)
    case .textDelta(let value):
      snapshot.busy = true
      transcript.response(value.text)
    case .activity(let value):
      snapshot.busy = true
      transcript.activity(value.activity)
    case .accepted(let value): transcript.delivery(value.inputId, .saved)
    case .placed(let value):
      transcript.delivery(value.inputId, .saved, entryID: value.entryId)
      pending.removeAll { $0.inputId == value.inputId }
      persistOutboxOrReport()
    case .rejected(let value):
      transcript.delivery(value.inputId, .rejected)
      // Keep the original on disk until the user explicitly restores it.
      // Rejections are not proof that a queued durable input never existed.
      snapshot.error = value.message
    case .notice(let value): transcript.notice(value.text)
    case .failure(let value):
      snapshot.error = value.message
      transcript.notice(value.message, failure: true)
    case .idle:
      snapshot.busy = false
      transcript.idle()
    case .disconnect, .done: break
    }
  }
  private func schedulePublish() {
    guard flush == nil else { return }
    flush = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
      await self?.flushUpdate()
    }
  }
  private func flushUpdate() {
    flush = nil
    publish()
  }
  private func publish() {
    snapshot.rows = transcript.rows
    continuation.yield(snapshot)
  }
  private func persistOutboxOrReport() {
    do { try saveOutbox() } catch {
      snapshot.error =
        "The outbox could not be updated. Reconnect reconciles saved message IDs before retry."
    }
  }
  private func saveOutbox() throws {
    try FileManager.default.createDirectory(
      at: outboxURL.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let data = try JSONEncoder().encode(pending)
    #if os(iOS)
      try data.write(to: outboxURL, options: [.atomic, .completeFileProtection])
    #else
      try data.write(to: outboxURL, options: .atomic)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: outboxURL.path)
    #endif
    var url = outboxURL
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }
}
