import Foundation
import Testing

@testable import AgentCore
@testable import AgentUI

@Test(arguments: [false, true]) @MainActor
func notificationSetupNeverPromptsUntilTheCoordinatorIsConfiguredAndTheUserEnablesIt(
  granted: Bool
) async {
  var permissions = 0
  var registrations = 0
  var saved: [Bool] = []
  let registration = NotificationRegistration(
    installationID: UUID(), enabled: false,
    permission: {
      permissions += 1
      return granted
    },
    register: { registrations += 1 }, save: { saved.append($0) })
  await registration.connect { _ in .init(configured: false, registered: false) }
  #expect(permissions == 0)
  await registration.setEnabled(true)
  #expect(!registration.enabled)
  #expect(registration.error?.contains("APNs setup") == true)
  #expect(permissions == 0 && registrations == 0 && saved.isEmpty)

  await registration.connect { _ in .init(configured: true, registered: false) }
  #expect(permissions == 0)
  await registration.setEnabled(true)
  #expect(registration.enabled == granted)
  #expect(!registration.registered)
  #expect(permissions == 1)
  #expect(registrations == (granted ? 1 : 0))
  #expect(saved == (granted ? [true] : []))
  if !granted { #expect(registration.error?.contains("Settings") == true) }
}

@Test(.timeLimit(.minutes(1))) @MainActor
func notificationNativeControlsRefreshTheSameInstallationAndNeverSubmitModelInput() async throws {
  try await withCoordinator { session, fixture, outbox in
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await snapshot in session.updates where snapshot.connection == .connected { break }
    let identifier = UUID()
    let registration = await NotificationRegistration(
      installationID: identifier, enabled: false, permission: { true }, register: {}, save: { _ in }
    )
    await registration.connect { request in try await session.notifications(request) }
    await registration.setEnabled(true)
    await registration.received(token: String(repeating: "01ab", count: 16))
    await registration.received(token: String(repeating: "02cd", count: 24))
    #expect(await registration.registered)
    await registration.setEnabled(false)
    #expect(await !registration.enabled)
    #expect(await !registration.registered)
    #expect(
      await fixture.notificationControls() == [
        .status(.init(installationId: identifier.uuidString)),
        .register(
          .init(installationId: identifier.uuidString, token: String(repeating: "01ab", count: 16))),
        .register(
          .init(installationId: identifier.uuidString, token: String(repeating: "02cd", count: 24))),
        .unregister(.init(installationId: identifier.uuidString)),
      ])
    #expect(await fixture.count() == 0)
    #expect(!FileManager.default.fileExists(atPath: outbox.path))
  }
}

@Test(.timeLimit(.minutes(1))) @MainActor
func notificationWithdrawalOrdersAfterAnInflightTokenAndSuppressesLateRegistration() async throws {
  try await withCoordinator { session, fixture, _ in
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await snapshot in session.updates where snapshot.connection == .connected { break }
    let registration = await NotificationRegistration(
      installationID: UUID(), enabled: true, permission: { true }, register: {}, save: { _ in })
    await registration.connect { request in try await session.notifications(request) }
    await fixture.holdNotificationRegistration()
    let enroll = Task { await registration.received(token: String(repeating: "01ab", count: 16)) }
    for await _ in fixture.observedNotifications {
      if await fixture.notificationControls().contains(where: {
        if case .register = $0 { true } else { false }
      }) {
        break
      }
    }
    let withdraw = Task { await registration.setEnabled(false) }
    while await registration.enabled { await Task.yield() }
    await registration.received(token: String(repeating: "02cd", count: 16))
    #expect(await fixture.notificationControls().count == 2)
    await fixture.releaseNotificationRegistration()
    await enroll.value
    await withdraw.value
    #expect(await !registration.registered)
    #expect(await fixture.notificationControls().count == 3)
    if case .unregister = await fixture.notificationControls().last {
    } else {
      Issue.record("Withdrawal must be the final native control")
    }
    #expect(await fixture.count() == 0)
  }
}

@Test @MainActor
func notificationForegroundPolicyAndTapUseTheExistingMainWithoutPersistingDeviceTokens()
  async throws
{
  let name = "notification-fixture-\(UUID())"
  let defaults = try #require(UserDefaults(suiteName: name))
  defer { defaults.removePersistentDomain(forName: name) }
  defaults.set(true, forKey: "notificationsEnabled")
  let notifications = AppNotifications(defaults: defaults)
  #expect(notifications.presentsAlerts)
  notifications.mainVisible = true
  #expect(!notifications.presentsAlerts)
  let target = NotificationTarget(conversationId: "1", entryId: "42")
  notifications.open(target)
  notifications.open(target)
  #expect(notifications.openedTarget == target)
  let reopened = AppNotifications(defaults: defaults)
  #expect(reopened.registration.installationID == notifications.registration.installationID)
  await notifications.registration.received(token: String(repeating: "ab", count: 32))
  #expect(
    defaults.persistentDomain(forName: name)?.keys.sorted() == [
      "notificationInstallationID", "notificationsEnabled",
    ])
}

@Test(.timeLimit(.minutes(1)))
func notificationRemovalIntentSurvivesAnUncertainReceiptAndAReopenedClient() async throws {
  try await withCoordinator { session, fixture, _ in
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await snapshot in session.updates where snapshot.connection == .connected { break }
    let identifier = UUID()
    let original = await NotificationRegistration(
      installationID: identifier, enabled: true, permission: { true }, register: {}, save: { _ in })
    await original.connect { request in try await session.notifications(request) }
    await original.received(token: String(repeating: "ab", count: 32))
    await fixture.dropNextNotificationRemoval()
    await original.setEnabled(false)
    #expect(await !original.enabled)
    #expect(await original.registered)
    #expect(await original.error != nil)
    await original.failed()
    #expect(await original.registered, "An OS callback cannot confirm coordinator removal")
    #expect(await original.error?.contains("removal is unconfirmed") == true)
    let reopened = await NotificationRegistration(
      installationID: identifier, enabled: false, permission: { true }, register: {}, save: { _ in }
    )
    await reopened.connect { request in try await session.notifications(request) }
    #expect(await !reopened.registered)
    #expect(await reopened.error == nil)
    #expect(
      await fixture.notificationControls().filter {
        if case .unregister = $0 { true } else { false }
      }.count == 2)
    #expect(await fixture.count() == 0)
  }
}
