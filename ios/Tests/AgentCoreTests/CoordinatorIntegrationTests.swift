import Foundation
import Network
import Testing

@testable import AgentCore
@testable import AgentUI

// The runtime integration runner starts the production coordinator before
// selecting this test. Ordinary Swift unit runs have no server to connect to.
@Test(
  .enabled(if: ProcessInfo.processInfo.environment["AGENT_E2E_SOCKET"] != nil),
  .timeLimit(.minutes(1)))
@MainActor
func nativeClientReconcilesAgainstTheProductionCoordinator() async throws {
  let environment = ProcessInfo.processInfo.environment
  let socket = try #require(environment["AGENT_E2E_SOCKET"])
  let directory = URL(filePath: try #require(environment["AGENT_E2E_DIRECTORY"]))
  let inputID = try #require(environment["AGENT_E2E_INPUT"])
  let entryID = try #require(environment["AGENT_E2E_ENTRY"])
  let text = try #require(environment["AGENT_E2E_TEXT"])
  let restart = URL(filePath: try #require(environment["AGENT_E2E_RESTART_REQUEST"]))
  let reconnecting = URL(filePath: try #require(environment["AGENT_E2E_RECONNECTING"]))
  let draft = "Keep this unsent composer draft across the service restart."
  let outbox = directory.appending(path: "native-pending.json")
  let input = NativeRequestSubmit(inputId: inputID, mode: .steer, text: text)
  try JSONEncoder().encode([input]).write(to: outbox, options: .atomic)
  let session = CoordinatorSession(
    outboxURL: outbox,
    connectTransport: { _ in
      LineConnection(connection: NWConnection(to: .unix(path: socket), using: .tcp))
    })
  let model = ChatModel()
  func verifySavedInput(_ rows: [ChatRow]) throws {
    #expect(rows.filter { $0.text == text }.map(\.entryID) == [entryID])
    #expect(rows.filter { $0.role == .user }.count == 1)
    #expect(rows.allSatisfy { $0.delivery == nil })
    #expect(
      try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox))
        .isEmpty)
  }
  func waitFor(_ description: String, _ predicate: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(20)
    while !predicate() {
      try #require(
        ContinuousClock.now < deadline,
        "Native client did not reach \(description): \(model.connection.label), \(model.error ?? "no error")"
      )
      try await Task.sleep(for: .milliseconds(10))
    }
  }
  do {
    let address = try CoordinatorAddress(host: "100.64.1.2")
    for _ in 0..<2 {
      await session.connect(address)
      var connected = false
      for await snapshot in session.updates {
        if snapshot.rows.contains(where: { $0.entryID == entryID }) {
          #expect(snapshot.rows.filter { $0.text == text }.count == 1)
        }
        if snapshot.connection == .connected {
          try verifySavedInput(snapshot.rows)
          connected = true
          break
        }
      }
      #expect(connected)
      await session.disconnect()
    }
    await model.connect(session: session, address: address)
    try await waitFor("connected before service restart") { model.connection == .connected }
    try verifySavedInput(model.rows.map(\.row))
    model.draft = draft
    try Data().write(to: restart, options: .atomic)
    try await waitFor("automatic reconnect while the service is stopped") {
      model.connection == .reconnecting
    }
    #expect(model.draft == draft)
    try verifySavedInput(model.rows.map(\.row))
    try Data().write(to: reconnecting, options: .atomic)
    try await waitFor("connected after service restart") { model.connection == .connected }
    try verifySavedInput(model.rows.map(\.row))
    #expect(model.draft == draft)
    #expect(model.error == nil)
    await model.stop()
  } catch {
    await model.stop()
    await session.disconnect()
    throw error
  }
}
