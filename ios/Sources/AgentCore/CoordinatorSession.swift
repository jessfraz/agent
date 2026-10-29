import Foundation

public enum ConnectionState: Sendable, Equatable {
  case disconnected, connecting, connected, reconnecting
  public var label: String {
    switch self {
    case .disconnected: "Disconnected"
    case .connecting: "Connecting"
    case .connected: "Connected via Tailscale"
    case .reconnecting: "Reconnecting…"
    }
  }
}

private struct CoordinatorRejection: LocalizedError {
  let message: String
  var errorDescription: String? { message }
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

public struct RestoredDraft: Sendable {
  public let text: String
  public let mode: InputMode
  public let attachments: [LocalAttachment]
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
  private var previewRequests: Set<UUID> = []
  private var pending: [NativeRequestSubmit] = []
  private var attemptedInputs: Set<String> = []
  private var generation = UUID()
  private var flush: Task<Void, Never>?
  private let outboxURL: URL
  private let attachments: AttachmentStore
  private let previews: AttachmentStore
  private let connectTransport: @Sendable (CoordinatorAddress) async throws -> LineConnection

  public init(outboxURL: URL) {
    self.init(
      outboxURL: outboxURL,
      previewDirectory: URL.cachesDirectory.appending(
        path: "Agent/Previews/\(outboxURL.deletingLastPathComponent().lastPathComponent)"),
      connectTransport: { try await LineConnection(address: $0) })
  }
  init(
    outboxURL: URL,
    previewDirectory: URL? = nil,
    connectTransport: @escaping @Sendable (CoordinatorAddress) async throws -> LineConnection
  ) {
    self.outboxURL = outboxURL
    attachments = AttachmentStore(
      directory: outboxURL.deletingLastPathComponent().appending(path: "Attachments"))
    previews = AttachmentStore(
      directory: previewDirectory
        ?? outboxURL.deletingLastPathComponent().appending(path: "Previews"))
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
    attemptedInputs.formUnion(pending.map(\.inputId))
    for request in pending { transcript.pending(request, delivery: .uncertain) }
    snapshot.error = nil
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
    snapshot.busy = false
    snapshot.loadingHistory = false
    for request in pending { transcript.delivery(request.inputId, .uncertain) }
    publish()
    for connection in ownedConnections { await connection.close() }
  }

  @discardableResult public func submit(
    _ text: String, mode: InputMode = .steer, files: [LocalAttachment] = []
  ) async -> Bool {
    guard actions.count < 32, snapshot.connection == .connected,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty
    else { return false }
    guard text.utf8.count <= 65536 else {
      snapshot.error = "Messages must be at most 64 KiB."
      publish()
      return false
    }
    guard files.count <= AttachmentLimits.maximumCount,
      Set(files.map(\.id)).count == files.count
    else {
      snapshot.error = AttachmentError.tooMany.localizedDescription
      publish()
      return false
    }
    let feedback = text.split(whereSeparator: \.isWhitespace).first == "/feedback"
    let control =
      text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
      || text.trimmingCharacters(in: .whitespacesAndNewlines) == "?"
    guard files.isEmpty || !control || feedback else {
      snapshot.error = "Files can be sent with messages or /feedback."
      publish()
      return false
    }
    let generation = generation
    do {
      for file in files { _ = try await attachments.adopt(file) }
    } catch {
      snapshot.error = error.localizedDescription
      publish()
      return false
    }
    guard self.generation == generation, snapshot.connection == .connected, actions.count < 32
    else {
      return false
    }
    let request = NativeRequestSubmit(
      attachments: files.isEmpty && !feedback ? nil : files.map(\.reference),
      inputId: UUID().uuidString, mode: mode, text: text)
    let durable = !control || feedback
    if durable {
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
    perform(.submit(request), inputID: durable ? request.inputId : nil)
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
  public func restore(_ inputID: String, to draftStore: AttachmentStore) async -> RestoredDraft? {
    guard let request = pending.first(where: { $0.inputId == inputID }) else { return nil }
    var files: [LocalAttachment] = []
    do {
      for reference in request.attachments ?? [] {
        let original = try await attachments.local(reference)
        // Restoring creates a new draft. Original acknowledgement cleanup
        // must never share a file identity with a later submission.
        files.append(try await draftStore.duplicate(original))
      }
    } catch {
      snapshot.error = error.localizedDescription
      publish()
      return nil
    }
    guard pending.contains(request) else { return nil }
    guard acknowledge(inputID) else {
      publish()
      return nil
    }
    transcript.delivery(inputID, .rejected)
    publish()
    return RestoredDraft(text: request.text, mode: request.mode, attachments: files)
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
        snapshot.connection = attempt == 0 ? .connecting : .reconnecting
        publish()
        let opened = try await connectTransport(address)
        guard self.generation == generation, !Task.isCancelled else {
          await opened.close()
          return
        }
        stream = opened
        connection = opened
        let stream = opened
        var ready = false
        try await timedSend(stream, .observe(.init(inputIds: pending.map(\.inputId))))
        while !Task.isCancelled {
          let event =
            try await (snapshot.connection == .connected ? stream.next() : timedNext(stream))
          guard self.generation == generation else { return }
          // Before readiness this rejects observation admission. Afterwards the
          // same event can be a mirrored model-turn failure; keep observing.
          if case .failure(let value) = event, !ready {
            throw CoordinatorRejection(message: value.message)
          }
          if case .disconnect = event {
            await disconnect()
            return
          }
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
        snapshot.busy = false
        guard ConnectionError.shouldReconnect(after: error) else {
          let stoppedGeneration = UUID()
          await disconnect(generation: stoppedGeneration)
          guard self.generation == stoppedGeneration else { return }
          snapshot.error = ConnectionError.describe(error)
          publish()
          return
        }
        snapshot.connection = .reconnecting
        snapshot.error = nil
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
      let stream = try await connectTransport(address)
      guard self.generation == generation, !Task.isCancelled else {
        await stream.close()
        return
      }
      actionConnections[id] = stream
      if case .submit(let input) = request {
        for reference in input.attachments ?? [] {
          try Task.checkCancellation()
          let file = try await attachments.local(reference)
          try await upload(file, on: stream)
        }
      }
      try Task.checkCancellation()
      guard self.generation == generation else { throw CancellationError() }
      if let inputID { attemptedInputs.insert(inputID) }
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
        case .failure:
          consume(event, historyRequestID: id)
          if let inputID, pending.contains(where: { $0.inputId == inputID }) {
            transcript.delivery(inputID, .uncertain)
          }
        default: consume(event, historyRequestID: id)
        }
        schedulePublish()
        if case .placed(let placed) = event, placed.inputId == inputID { break }
        if case .rejected(let rejected) = event, rejected.inputId == inputID { break }
        if case .feedbackReady(let ready) = event, ready.inputId == inputID { break }
      }
    } catch {
      if self.generation == generation && !Task.isCancelled {
        if let inputID, pending.contains(where: { $0.inputId == inputID }) {
          transcript.delivery(inputID, attemptedInputs.contains(inputID) ? .uncertain : .rejected)
        }
        if ConnectionError.shouldReconnect(after: error) {
          snapshot.connection = .reconnecting
          snapshot.error = nil
          snapshot.busy = false
          // The observer reconciles all pending IDs after a lost action reply.
          // Closing it never resends the action or its uncertain input.
          await connection?.close()
        } else {
          snapshot.error = ConnectionError.describe(error)
        }
      }
    }
    await actionConnections.removeValue(forKey: id)?.close()
    if self.generation == generation {
      snapshot.loadingHistory = false
      publish()
    }
  }
  private func transfer(_ request: AttachmentRequest, on stream: LineConnection) async throws
    -> AttachmentResponse
  {
    try await timedSend(stream, .attachment(.init(request: request)))
    var response: AttachmentResponse?
    while true {
      let event = try await timedNext(stream)
      switch event {
      case .attachment(let value):
        guard response == nil else { throw AttachmentError.invalidResponse }
        response = value.response
      case .done:
        guard let response else { throw AttachmentError.invalidResponse }
        return response
      case .failure(let value): throw AttachmentError.unavailable(value.message)
      default: throw AttachmentError.invalidResponse
      }
    }
  }
  private func upload(_ file: LocalAttachment, on stream: LineConnection) async throws {
    let input = try FileHandle(forReadingFrom: file.url)
    defer { try? input.close() }
    let reference = file.reference
    var offset = 0
    repeat {
      let bytes = try input.read(upToCount: AttachmentLimits.chunkBytes) ?? Data()
      let end = offset + bytes.count
      guard end <= reference.sizeBytes, !bytes.isEmpty || end == reference.sizeBytes else {
        throw AttachmentError.changed
      }
      let complete = end == reference.sizeBytes
      let response = try await transfer(
        .upload(
          .init(
            complete: complete, dataBase64: bytes.base64EncodedString(), id: reference.id,
            mediaType: reference.mediaType, name: reference.name, offset: offset,
            sizeBytes: reference.sizeBytes)), on: stream)
      guard case .uploaded(let uploaded) = response, uploaded.nextOffset == end,
        complete ? uploaded.attachment == reference : uploaded.attachment == nil
      else { throw AttachmentError.changed }
      offset = end
      if complete {
        guard (try input.read(upToCount: 1) ?? Data()).isEmpty else {
          throw AttachmentError.changed
        }
        return
      }
    } while true
  }

  /// Tool input and output are loaded only when their durable row is opened.
  public func toolDetails(entryID: String, callID: String) async throws -> ToolDetails {
    guard actions.count + previewRequests.count < 32, let address,
      snapshot.connection == .connected
    else { throw ConnectionError.closed }
    let id = UUID()
    previewRequests.insert(id)
    defer { previewRequests.remove(id) }
    let generation = generation
    let stream = try await connectTransport(address)
    guard self.generation == generation, !Task.isCancelled else {
      await stream.close()
      throw CancellationError()
    }
    actionConnections[id] = stream
    do {
      try await timedSend(stream, .toolDetails(.init(callId: callID, entryId: entryID)))
      var details: ToolDetails?
      while true {
        let event = try await timedNext(stream)
        guard self.generation == generation, !Task.isCancelled else { throw CancellationError() }
        switch event {
        case .toolDetails(let value):
          guard details == nil else { throw ConnectionError.incompleteFrame }
          switch value.details {
          case .available(let detail):
            guard detail.callId == callID else { throw ConnectionError.incompleteFrame }
          case .unavailable(let detail):
            guard detail.callId == callID else { throw ConnectionError.incompleteFrame }
          }
          details = value.details
        case .done:
          guard let details else { throw ConnectionError.incompleteFrame }
          await actionConnections.removeValue(forKey: id)?.close()
          return details
        case .failure(let value): throw CoordinatorRejection(message: value.message)
        default: throw ConnectionError.incompleteFrame
        }
      }
    } catch {
      await actionConnections.removeValue(forKey: id)?.close()
      throw error
    }
  }

  /// Fetch only on an explicit preview request; history carries metadata, never image bytes.
  public func preview(_ reference: AttachmentRef) async throws -> URL {
    guard actions.count + previewRequests.count < 32 else {
      throw AttachmentError.unavailable("Wait for the current files to finish opening.")
    }
    let id = UUID()
    previewRequests.insert(id)
    defer { previewRequests.remove(id) }
    if let cached = try await previews.existing(reference) { return cached.url }
    guard let address, snapshot.connection == .connected
    else { throw ConnectionError.closed }
    let generation = generation
    let stream = try await connectTransport(address)
    guard self.generation == generation, !Task.isCancelled else {
      await stream.close()
      throw CancellationError()
    }
    actionConnections[id] = stream
    do {
      var data = Data()
      var offset = 0
      repeat {
        let response = try await transfer(
          .download(.init(id: reference.id, limit: AttachmentLimits.chunkBytes, offset: offset)),
          on: stream)
        guard self.generation == generation else { throw CancellationError() }
        guard case .download(let chunk) = response,
          let bytes = Data(base64Encoded: chunk.dataBase64),
          bytes.count <= AttachmentLimits.chunkBytes,
          data.count + bytes.count <= min(reference.sizeBytes, AttachmentLimits.maximumBytes)
        else { throw AttachmentError.invalidResponse }
        data.append(bytes)
        let end = offset + bytes.count
        if let next = chunk.nextOffset {
          guard next == end, next > offset, next < reference.sizeBytes else {
            throw AttachmentError.invalidResponse
          }
          offset = next
        } else {
          break
        }
      } while true
      let staged = try await previews.receive(data, reference: reference)
      await actionConnections.removeValue(forKey: id)?.close()
      return staged.url
    } catch {
      await actionConnections.removeValue(forKey: id)?.close()
      throw error
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
      acknowledge(value.inputId)
    case .feedbackReady(let value):
      transcript.delivery(value.inputId, .saved)
      transcript.notice("Feedback saved. Repair task: \(value.receipt.taskId)")
      acknowledge(value.inputId)
    case .rejected(let value):
      transcript.delivery(value.inputId, .rejected)
      // Keep the original on disk until the user explicitly restores it.
      // Rejections are not proof that a queued durable input never existed.
      snapshot.error = value.message
    case .notice(let value): transcript.notice(value.text)
    case .failure(let value):
      snapshot.error = value.message
    case .idle:
      snapshot.busy = false
      transcript.idle()
    case .attachment, .toolDetails, .disconnect, .done: break
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
  @discardableResult private func acknowledge(_ inputID: String) -> Bool {
    let previous = pending
    let completed = pending.filter { $0.inputId == inputID }.flatMap { $0.attachments ?? [] }
    pending.removeAll { $0.inputId == inputID }
    do { try saveOutbox() } catch {
      pending = previous
      snapshot.error = "The saved outbox could not be updated. Original files were preserved."
      return false
    }
    attemptedInputs.remove(inputID)
    let retained = Set(pending.flatMap { $0.attachments ?? [] }.map(\.id))
    let store = attachments
    Task {
      for reference in completed where !retained.contains(reference.id) {
        if let file = try? await store.local(reference) { try? await store.remove(file) }
      }
    }
    return true
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
