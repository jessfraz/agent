import Foundation
import Network
import Testing

@testable import AgentCore

// The runtime integration runner starts the production coordinator before
// selecting this test. Ordinary Swift unit runs have no server to connect to.
@Test(
  .enabled(if: ProcessInfo.processInfo.environment["AGENT_E2E_SOCKET"] != nil),
  .timeLimit(.minutes(1)))
func nativeClientReconcilesAgainstTheProductionCoordinator() async throws {
  let environment = ProcessInfo.processInfo.environment
  let socket = try #require(environment["AGENT_E2E_SOCKET"])
  let directory = URL(filePath: try #require(environment["AGENT_E2E_DIRECTORY"]))
  let inputID = try #require(environment["AGENT_E2E_INPUT"])
  let entryID = try #require(environment["AGENT_E2E_ENTRY"])
  let text = try #require(environment["AGENT_E2E_TEXT"])
  let outbox = directory.appending(path: "native-pending.json")
  let input = NativeRequestSubmit(inputId: inputID, mode: .steer, text: text)
  try JSONEncoder().encode([input]).write(to: outbox, options: .atomic)
  let session = CoordinatorSession(
    outboxURL: outbox,
    connectTransport: { _ in
      LineConnection(connection: NWConnection(to: .unix(path: socket), using: .tcp))
    })
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
          #expect(snapshot.rows.filter { $0.text == text }.map(\.entryID) == [entryID])
          #expect(snapshot.rows.allSatisfy { $0.delivery == nil })
          #expect(
            try JSONDecoder().decode([NativeRequestSubmit].self, from: Data(contentsOf: outbox))
              .isEmpty)
          connected = true
          break
        }
      }
      #expect(connected)
      await session.disconnect()
    }
  } catch {
    await session.disconnect()
    throw error
  }
}
