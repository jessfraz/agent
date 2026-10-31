import AgentCore
import Network
import UIKit
import XCTest

@MainActor
final class HistoryInteractionTests: XCTestCase {
  private func eventually(_ predicate: () async throws -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while try await !predicate() {
      guard ContinuousClock.now < deadline else {
        XCTFail("Expected history navigation state did not arrive")
        return
      }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  func testTopPagingPreservesVisibleGroupAndLatestReloadsTheActualTail() async throws {
    continueAfterFailure = false
    executionTimeAllowance = 120
    let peer = InteractionPeer()
    addTeardownBlock { await peer.stop() }
    func activity(_ start: Int, count: Int = 25, next: String?) -> NativeEventHistory {
      .init(
        messages: (start..<(start + count)).map { index in
          .init(
            continuation: false, entryId: "tool-\(index)", finalChunk: true,
            role: .tool, text: "",
            tool: .init(callId: "call-\(index)", name: "exec", status: .finished))
        }, nextCursor: next, pageComplete: true)
    }
    let recent: [HistoryMessage] = (100..<120).map { index in
      .init(
        continuation: false, entryId: "recent-\(index)", finalChunk: true,
        role: index.isMultiple(of: 2) ? .user : .final,
        text: "Conversation message \(index). A useful question and a complete answer.")
    }
    let earlier = "The earlier question supplies useful conversation context."
    let latest = "The current latest reply is visible."
    await peer.history(
      initial: .init(
        messages: activity(75, next: nil).messages + recent,
        nextCursor: "one", pageComplete: true),
      pages: [
        "one": activity(50, next: "two"), "two": activity(25, next: "three"),
        "three": .init(
          messages: [
            .init(
              continuation: false, entryId: "earlier-question", finalChunk: true, role: .user,
              text: earlier),
            .init(
              continuation: false, entryId: "earlier-answer", finalChunk: true, role: .final,
              text: "The earlier answer closes the previous question and explains the later work."),
          ], nextCursor: "four", pageComplete: true),
        "four": activity(-500, count: 500, next: nil),
      ],
      latest: .init(
        messages: recent + [
          .init(
            continuation: false, entryId: "current-tail", finalChunk: true, role: .final,
            text: latest)
        ], nextCursor: "recent-older", pageComplete: true))
    await peer.hold("one")
    await peer.hold("four")
    let port = try await peer.start()
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERACTION_PORT"] = String(port)
    app.launchArguments += ["-notificationsEnabled", "NO"]
    app.launch()
    defer { app.terminate() }
    let transcript = app.scrollViews["transcript"]
    XCTAssertTrue(transcript.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts[recent.last!.text].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["latest-messages"].waitForNonExistence(timeout: 5))
    let initialRequests = await peer.cursors()
    XCTAssertEqual(initialRequests, [])
    for _ in 0..<8 {
      if !(await peer.cursors()).isEmpty { break }
      transcript.swipeDown(velocity: .fast)
    }
    try await eventually { await peer.cursors() == ["one"] }
    let group = app.buttons["activity:tool:call-75"]
    XCTAssertTrue(group.waitForExistence(timeout: 3))
    XCTAssertTrue(group.isHittable)
    let anchor = group.frame
    XCTAssertTrue(app.buttons["latest-messages"].isHittable)
    transcript.swipeDown()
    let heldRequests = await peer.cursors()
    XCTAssertEqual(
      heldRequests, ["one"], "Scrolling during a pending page started another request")
    let settledAnchor = group.frame
    await peer.release("one")
    try await eventually {
      await peer.cursors() == ["one", "two", "three"]
        && app.buttons["Load earlier messages"].isEnabled
    }
    XCTAssertEqual(
      group.frame.minY, settledAnchor.minY, accuracy: 2,
      "Prepending history moved the visible group")
    XCTAssertEqual(group.frame.height, anchor.height, accuracy: 2)
    XCTAssertTrue(app.staticTexts[earlier].exists)
    let receipt = XCTAttachment(screenshot: app.screenshot())
    receipt.name = "tool-heavy-history-preserves-visible-group"
    receipt.lifetime = .keepAlways
    add(receipt)

    // A further bounded page evicts the recent tail. At the retained window's
    // physical bottom, Latest must still return to real recent conversation.
    for _ in 0..<5 {
      if (await peer.cursors()).contains("four") { break }
      transcript.swipeDown()
    }
    try await eventually { await peer.cursors() == ["one", "two", "three", "four"] }
    await peer.release("four")
    try await eventually { !app.buttons["Load earlier messages"].exists }
    let concurrent = "A new reply arrived while older history was open."
    try await peer.reply(concurrent)
    XCTAssertTrue(app.staticTexts[concurrent].waitForExistence(timeout: 5))
    transcript.swipeUp()
    XCTAssertTrue(app.buttons["latest-messages"].isHittable)
    app.buttons["latest-messages"].tap()
    try await eventually { (await peer.cursors()).last == "<latest>" }
    XCTAssertTrue(app.staticTexts[latest].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["latest-messages"].waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts[earlier].waitForNonExistence(timeout: 5))
    let tail = XCTAttachment(screenshot: app.screenshot())
    tail.name = "latest-reloads-current-conversation"
    tail.lifetime = .keepAlways
    add(tail)
  }
}

// Shared DEBUG app fixture, real screen/session and an owned NDJSON loopback
// peer. Replies are released by assertions instead of elapsed time.
private actor InteractionPeer {
  private var listener: NWListener?
  private var sockets: [UUID: NWConnection] = [:]
  private var initial: NativeEventHistory?
  private var pages: [String: NativeEventHistory] = [:]
  private var latest: NativeEventHistory?
  private var observer: NWConnection?
  private var requests: [String] = []
  private var held: Set<String> = []
  private var releases: [String: CheckedContinuation<Void, Never>] = [:]

  func history(
    initial: NativeEventHistory, pages: [String: NativeEventHistory], latest: NativeEventHistory
  ) {
    self.initial = initial
    self.pages = pages
    self.latest = latest
  }
  func cursors() -> [String] { requests }
  func reply(_ text: String) async throws {
    let message = HistoryMessage(
      continuation: false, entryId: "concurrent-reply", finalChunk: true,
      role: .final, text: text)
    latest?.messages.append(message)
    try await emit(.message(.init(message: message)), to: XCTUnwrap(observer))
  }
  func hold(_ cursor: String) { held.insert(cursor) }
  func release(_ cursor: String) {
    held.remove(cursor)
    releases.removeValue(forKey: cursor)?.resume()
  }
  func start() async throws -> UInt16 {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    let ready = AsyncThrowingStream<Void, any Error>.makeStream()
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.continuation.yield(()) }
      if case .failed(let error) = state { ready.continuation.finish(throwing: error) }
    }
    listener.newConnectionHandler = { socket in Task { await self.accept(socket) } }
    listener.start(queue: .global())
    for try await _ in ready.stream { break }
    return try XCTUnwrap(listener.port).rawValue
  }
  func stop() {
    for continuation in releases.values { continuation.resume() }
    releases = [:]
    listener?.cancel()
    listener = nil
    for socket in sockets.values { socket.cancel() }
    sockets = [:]
  }
  private func accept(_ socket: NWConnection) async {
    let id = UUID()
    sockets[id] = socket
    socket.start(queue: .global())
    defer {
      sockets.removeValue(forKey: id)
      socket.cancel()
    }
    do {
      var data = Data()
      while !data.contains(10) { data.append(try await receive(socket)) }
      let end = try XCTUnwrap(data.firstIndex(of: 10))
      let command = try JSONDecoder().decode(NativeCommand.self, from: data.prefix(upTo: end))
      guard case .native(let command) = command else { return }
      switch command.request {
      case .observe:
        observer = socket
        try await emit(
          .ready(.init(conversationId: "fixture-root", model: "fixture/model")), to: socket)
        try await emit(.history(try XCTUnwrap(initial)), to: socket)
        try await emit(.idle, to: socket)
      case .history(let request):
        let cursor = request.cursor ?? "<latest>"
        requests.append(cursor)
        if held.contains(cursor) { await withCheckedContinuation { releases[cursor] = $0 } }
        try await emit(
          .history(try XCTUnwrap(request.cursor == nil ? latest : pages[cursor])), to: socket)
        try await emit(.done, to: socket)
      default: try await emit(.done, to: socket)
      }
      _ = try await receive(socket)
    } catch {
      // Client cancellation owns closing both observers and history requests.
    }
  }
  private func receive(_ socket: NWConnection) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      socket.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
        if let error {
          continuation.resume(throwing: error)
        } else if complete && (data?.isEmpty ?? true) {
          continuation.resume(throwing: CocoaError(.fileReadUnknown))
        } else {
          continuation.resume(returning: data ?? Data())
        }
      }
    }
  }
  private func emit(_ event: NativeEvent, to socket: NWConnection) async throws {
    var data = try JSONEncoder().encode(event)
    data.append(10)
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
