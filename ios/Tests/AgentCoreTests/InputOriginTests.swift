import Foundation
import Testing

@testable import AgentCore

@Test(.timeLimit(.minutes(1)), arguments: [Optional<Bool>.none, .some(false), .some(true)])
func newNativeInputsAdvertiseIOSOnlyWhenTheCurrentConnectionSupportsOrigins(advertised: Bool?)
  async throws
{
  try await withCoordinator { session, fixture, outbox in
    await fixture.advertiseInputOrigins(advertised)
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    #expect(await session.submit("A deliberately unsent-until-admitted native message"))
    let requests = try JSONDecoder().decode(
      [NativeRequestSubmit].self, from: Data(contentsOf: outbox))
    #expect(requests.count == 1)
    #expect(requests.first?.origin == (advertised == true ? .ios : nil))
  }
}

@Test(.timeLimit(.minutes(1)))
func reconnectDoesNotReuseOriginCapabilityOrRewriteAnOlderPendingInput() async throws {
  try await withCoordinator { session, fixture, outbox in
    let address = try CoordinatorAddress(host: "100.64.1.2")
    await fixture.advertiseInputOrigins(true)
    await fixture.loseInputAcknowledgements()
    await session.connect(address)
    for await update in session.updates where update.connection == .connected { break }
    #expect(await session.submit("Original input"))
    await session.disconnect()
    await fixture.advertiseInputOrigins(nil)
    await session.connect(address)
    for await update in session.updates where update.connection == .connected { break }
    #expect(await session.submit("New input on a legacy connection"))
    let requests = try JSONDecoder().decode(
      [NativeRequestSubmit].self, from: Data(contentsOf: outbox))
    #expect(requests.last?.origin == nil)
  }
}

@Test(.timeLimit(.minutes(1)))
func retryingALegacyOutboxNeverInventsAnOriginEvenAfterCapabilityIsAdvertised() async throws {
  try await withCoordinator { session, fixture, outbox in
    let legacy = NativeRequestSubmit(
      inputId: UUID().uuidString, mode: .steer, text: "Legacy pending input")
    try FileManager.default.createDirectory(
      at: outbox.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode([legacy]).write(to: outbox, options: .atomic)
    await fixture.advertiseInputOrigins(true)
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    await session.retry(legacy.inputId)
    for await actual in fixture.observedInputs {
      #expect(actual == legacy)
      #expect(actual.origin == nil)
      break
    }
  }
}
