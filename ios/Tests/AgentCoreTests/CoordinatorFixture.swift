import CryptoKit
import Foundation
import Network
import Testing

@testable import AgentCore

func send(_ data: Data, on connection: NWConnection) async throws {
  try await withCheckedThrowingContinuation {
    (continuation: CheckedContinuation<Void, any Error>) in
    connection.send(
      content: data,
      completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      })
  }
}

actor FixtureCoordinator {
  nonisolated let closedObservations: AsyncStream<Void>
  nonisolated let closedToolLookups: AsyncStream<Void>
  private let closedContinuation: AsyncStream<Void>.Continuation
  private let closedToolContinuation: AsyncStream<Void>.Continuation
  private var toolRequests: [NativeRequestToolDetails] = []
  private var toolReply: [NativeEvent] = []
  private var notificationRequests: [NotificationRequest] = []
  private var notificationsRegistered = false
  private var notificationsHeld = false
  private var dropNotificationRemoval = false
  private var notificationRelease: CheckedContinuation<Void, Never>?
  private let notificationObserved = AsyncStream<Void>.makeStream()
  nonisolated var observedNotifications: AsyncStream<Void> { notificationObserved.stream }
  private var delaySnapshot = false
  private var release: CheckedContinuation<Void, Never>?
  private var initialHistory: NativeEventHistory?
  private var latestHistory: NativeEventHistory?
  private var observer: NWConnection?
  private var historyPages: [String: NativeEventHistory] = [:]
  private var requestedHistory: [String] = []
  private var heldHistory: String?
  private var historyRelease: CheckedContinuation<Void, Never>?
  private let historyObserved = AsyncStream<String>.makeStream()
  nonisolated var observedHistory: AsyncStream<String> { historyObserved.stream }
  init() {
    let pair = AsyncStream<Void>.makeStream()
    closedObservations = pair.stream
    closedContinuation = pair.continuation
    let details = AsyncStream<Void>.makeStream()
    closedToolLookups = details.stream
    closedToolContinuation = details.continuation
  }
  func replyToToolLookups(with events: [NativeEvent]) { toolReply = events }
  func replyToHistory(initial: NativeEventHistory, pages: [String: NativeEventHistory]) {
    initialHistory = initial
    historyPages = pages
  }
  func historyRequests() -> [String] { requestedHistory }
  func replyToLatest(_ page: NativeEventHistory) { latestHistory = page }
  func liveMessage(_ message: HistoryMessage) async throws {
    try await emit(.message(.init(message: message)), on: #require(observer))
  }
  func holdHistory(_ cursor: String) { heldHistory = cursor }
  func releaseHistory() {
    heldHistory = nil
    historyRelease?.resume()
    historyRelease = nil
  }
  func toolLookups() -> [NativeRequestToolDetails] { toolRequests }
  func notificationControls() -> [NotificationRequest] { notificationRequests }
  func dropNextNotificationRemoval() { dropNotificationRemoval = true }
  func holdNotificationRegistration() { notificationsHeld = true }
  func releaseNotificationRegistration() {
    notificationsHeld = false
    notificationRelease?.resume()
    notificationRelease = nil
  }
  func holdSnapshot() { delaySnapshot = true }
  func releaseSnapshot() {
    delaySnapshot = false
    release?.resume()
    release = nil
  }
  private var sockets: [NWConnection] = []
  private var submissions: [NativeRequestSubmit] = []
  private var files: [String: Data] = [:]
  private var uploads = 0
  private var rejectUploads = false
  func refuseUploads() { rejectUploads = true }
  func uploadCount() -> Int { uploads }
  func uploaded(_ id: String) -> Data? { files[id] }
  func count() -> Int { submissions.count }
  func stop() {
    releaseHistory()
    for socket in sockets { socket.cancel() }
    sockets = []
  }
  func accept(_ socket: NWConnection) async throws {
    sockets.append(socket)
    socket.start(queue: .global())
    var bytes = Data()
    while true {
      while !bytes.contains(10) {
        let data = try await withCheckedThrowingContinuation {
          (continuation: CheckedContinuation<Data, any Error>) in
          socket.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
            data, _, complete, error in
            if let error {
              continuation.resume(throwing: error)
            } else if complete && data == nil {
              continuation.resume(throwing: ConnectionError.closed)
            } else {
              continuation.resume(returning: data ?? Data())
            }
          }
        }
        bytes.append(data)
      }
      let end = try #require(bytes.firstIndex(of: 10))
      let command = try JSONDecoder().decode(NativeCommand.self, from: bytes.prefix(upTo: end))
      bytes.removeSubrange(...end)
      guard case .native(let value) = command else { return }
      switch value.request {
      case .notifications(let request):
        notificationRequests.append(request.request)
        notificationObserved.continuation.yield(())
        if case .unregister = request.request, dropNotificationRemoval {
          dropNotificationRemoval = false
          socket.cancel()
          return
        }
        switch request.request {
        case .register:
          if notificationsHeld { await withCheckedContinuation { notificationRelease = $0 } }
          notificationsRegistered = true
        case .unregister: notificationsRegistered = false
        case .status: break
        }
        try await emit(
          .notifications(
            .init(status: .init(configured: true, registered: notificationsRegistered))), on: socket
        )
        try await emit(.done, on: socket)
      case .toolDetails(let request):
        toolRequests.append(request)
        var reply = Data()
        for event in toolReply {
          reply.append(try JSONEncoder().encode(event))
          reply.append(10)
        }
        if !reply.isEmpty { try? await send(reply, on: socket) }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
          socket.receive(minimumIncompleteLength: 1, maximumLength: 1) {
            data, _, complete, error in
            #expect(data?.isEmpty ?? true)
            #expect(complete || error != nil)
            continuation.resume()
          }
        }
        closedToolContinuation.yield(())
        return
      case .observe(let request):
        observer = socket
        try await emit(
          .ready(.init(conversationId: "fixture-root", model: "fixture/model")), on: socket)
        if delaySnapshot { await withCheckedContinuation { release = $0 } }
        let messages = submissions.filter { request.inputIds.contains($0.inputId) }.map { input in
          HistoryMessage(
            attachments: input.attachments, continuation: false, entryId: "placed-\(input.inputId)",
            finalChunk: true, role: .user,
            text: input.text, tool: nil)
        }
        try await emit(
          .history(
            initialHistory ?? .init(messages: messages, nextCursor: nil, pageComplete: true)),
          on: socket)
        for input in submissions where request.inputIds.contains(input.inputId) {
          try await emit(
            .placed(.init(entryId: "placed-\(input.inputId)", inputId: input.inputId)), on: socket)
        }
        try await emit(.idle, on: socket)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
          socket.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in
            continuation.resume()
          }
        }
        closedContinuation.yield(())
        return
      case .submit(let request):
        submissions.append(request)
        if request.text.hasPrefix("/feedback ") {
          try await emit(
            .feedbackReady(
              .init(
                inputId: request.inputId,
                receipt: .init(
                  id: "feedback-fixture", path: "private/feedback", taskId: "repair-fixture"))),
            on: socket)
          // The client may close as soon as the durable receipt arrives.
          try? await emit(.done, on: socket)
          return
        }
        try await emit(.accepted(.init(inputId: request.inputId)), on: socket)
        socket.send(
          content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
        return
      case .history(let request):
        let cursor = request.cursor ?? "<latest>"
        requestedHistory.append(cursor)
        historyObserved.continuation.yield(cursor)
        if heldHistory == cursor { await withCheckedContinuation { historyRelease = $0 } }
        let page = try #require(
          request.cursor == nil ? latestHistory ?? initialHistory : historyPages[cursor])
        try await emit(.history(page), on: socket)
        try await emit(.done, on: socket)
      case .attachment(let value):
        let response: AttachmentResponse
        switch value.request {
        case .upload(let chunk):
          if rejectUploads {
            try await emit(.failure(.init(message: "Attachment storage is full")), on: socket)
            return
          }
          uploads += 1
          let data = try #require(Data(base64Encoded: chunk.dataBase64))
          var file = files[chunk.id] ?? Data()
          #expect(chunk.offset <= file.count)
          let end = chunk.offset + data.count
          if end > file.count { file.append(data.suffix(end - file.count)) }
          files[chunk.id] = file
          let reference =
            chunk.complete
            ? AttachmentRef(
              id: chunk.id, mediaType: chunk.mediaType, name: chunk.name,
              sha256: SHA256.hash(data: file).map { String(format: "%02x", $0) }.joined(),
              sizeBytes: file.count) : nil
          response = .uploaded(.init(attachment: reference, nextOffset: end))
        case .download(let chunk):
          let file = try #require(files[chunk.id])
          let end = min(chunk.offset + chunk.limit, file.count)
          response = .download(
            .init(
              dataBase64: file.subdata(in: chunk.offset..<end).base64EncodedString(),
              nextOffset: end < file.count ? end : nil))
        case .discard: response = .discarded
        }
        try await emit(.attachment(.init(response: response)), on: socket)
        try await emit(.done, on: socket)
      default:
        try await emit(.done, on: socket)
        return
      }
    }
  }
  private func emit(_ event: NativeEvent, on socket: NWConnection) async throws {
    var data = try JSONEncoder().encode(event)
    data.append(10)
    try await send(data, on: socket)
  }
}

func withCoordinator(
  _ body: @Sendable (CoordinatorSession, FixtureCoordinator, URL) async throws -> Void
) async throws {
  let parameters = NWParameters.tcp
  parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
  let listener = try NWListener(using: parameters)
  let ready = AsyncThrowingStream<Void, any Error>.makeStream()
  let fixture = FixtureCoordinator()
  listener.stateUpdateHandler = { state in
    if case .ready = state { ready.continuation.yield(()) }
    if case .failed(let error) = state { ready.continuation.finish(throwing: error) }
  }
  listener.newConnectionHandler = { socket in
    Task {
      do { try await fixture.accept(socket) } catch ConnectionError.closed {
        // A completed transfer releases its owned socket.
      } catch let error as NWError where error == .posix(.ECANCELED) {
        // Fixture teardown cancels receives on its remaining connections.
      } catch let error as NWError
        where error == .posix(.EPIPE) || error == .posix(.ECONNRESET)
      {
        // A cancelled history batch closes its socket before the held reply.
      } catch { Issue.record(error) }
    }
  }
  listener.start(queue: .global())
  defer { listener.cancel() }
  for try await _ in ready.stream { break }
  let port = try #require(listener.port)
  let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  let outbox = directory.appending(path: "outbox.json")
  defer { try? FileManager.default.removeItem(at: directory) }
  let session = CoordinatorSession(
    outboxURL: outbox,
    connectTransport: { _ in
      LineConnection(connection: NWConnection(host: .ipv4(.loopback), port: port, using: .tcp))
    })
  do {
    try await body(session, fixture, outbox)
    await session.disconnect()
    await fixture.stop()
  } catch {
    await session.disconnect()
    await fixture.stop()
    throw error
  }
}
