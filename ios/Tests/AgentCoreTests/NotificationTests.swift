import Foundation
import Testing

@testable import AgentCore
@testable import AgentUI

@Test(arguments: [false, true]) @MainActor
func notificationStartupAsksOnceBeforeConnectionAndRemembersDenial(granted: Bool) async {
  var permissions = 0
  var registrations = 0
  var saved: [Bool] = []
  let registration = NotificationRegistration(
    installationID: UUID(), enabled: true,
    permission: {
      permissions += 1
      return granted
    },
    register: { registrations += 1 }, save: { saved.append($0) })
  await registration.start()
  #expect(registration.enabled == granted)
  #expect(permissions == 1 && registrations == (granted ? 1 : 0))
  #expect(saved == [granted])
  if !granted { #expect(registration.error?.contains("Settings") == true) }
  await registration.start()
  await registration.connect { _ in .init(configured: false, registered: false) }
  await registration.start()
  #expect(permissions == 1)
  #expect(registrations == (granted ? 1 : 0))
}

@Test @MainActor
func notificationExplicitOptOutNeverRequestsPermissionOrEnrolls() async {
  let registration = NotificationRegistration(
    installationID: UUID(), enabled: false,
    permission: {
      Issue.record("Opt-out must not ask for permission")
      return true
    },
    register: { Issue.record("Opt-out must not register with Apple") }, save: { _ in })
  await registration.start()
  await registration.received(token: String(repeating: "ab", count: 32))
  await registration.connect { request in
    if case .status = request {} else { Issue.record("Opt-out must not enroll") }
    return .init(configured: true, registered: false)
  }
  #expect(!registration.enabled && !registration.registered)
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

@Test @MainActor
func notificationsDefaultOnWithoutOverridingAnExplicitPreference() throws {
  let name = "notification-default-fixture-\(UUID())"
  let defaults = try #require(UserDefaults(suiteName: name))
  defer { defaults.removePersistentDomain(forName: name) }
  #expect(defaults.object(forKey: "notificationsEnabled") == nil)
  #expect(AppNotifications(defaults: defaults).registration.enabled)
  defaults.set(false, forKey: "notificationsEnabled")
  #expect(!AppNotifications(defaults: defaults).registration.enabled)
  defaults.set(true, forKey: "notificationsEnabled")
  #expect(AppNotifications(defaults: defaults).registration.enabled)
}

@Test(.timeLimit(.minutes(1)), arguments: [false, true])
func notificationStartupEnrollsTheLatestTokenOncePerConnection(tokenBeforeConnection: Bool)
  async throws
{
  try await withCoordinator { session, fixture, outbox in
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await snapshot in session.updates where snapshot.connection == .connected { break }
    let probe = NotificationProbe()
    let identifier = UUID()
    let first = String(repeating: "ab", count: 32)
    let second = String(repeating: "cd", count: 32)
    let registration = await NotificationRegistration(
      installationID: identifier, enabled: true,
      permission: {
        probe.permissions += 1
        return true
      },
      register: { probe.registrations += 1 }, save: { probe.saved.append($0) })
    await registration.start()
    if tokenBeforeConnection { await registration.received(token: first) }
    await registration.connect { request in try await session.notifications(request) }
    if !tokenBeforeConnection { await registration.received(token: first) }
    await registration.received(token: first)
    #expect(await registration.registered)
    #expect(await fixture.notificationControls().count == 2)

    await fixture.holdNotificationRegistration()
    let refresh = Task { await registration.received(token: second) }
    for await _ in fixture.observedNotifications {
      if await fixture.notificationControls().contains(
        .register(
          .init(
            installationId: identifier.uuidString, token: second)))
      {
        break
      }
    }
    let duplicate = Task { await registration.received(token: second) }
    await fixture.releaseNotificationRegistration()
    await refresh.value
    await duplicate.value
    #expect(await fixture.notificationControls().count == 3)

    await registration.disconnect()
    await registration.connect { request in try await session.notifications(request) }
    #expect(await registration.registered)
    #expect(await probe.permissions == 1)
    #expect(await probe.registrations == 1)
    await registration.setEnabled(false)
    await registration.received(token: first)
    #expect(await !registration.enabled)
    #expect(await !registration.registered)
    #expect(
      await fixture.notificationControls() == [
        .status(.init(installationId: identifier.uuidString)),
        .register(.init(installationId: identifier.uuidString, token: first)),
        .register(.init(installationId: identifier.uuidString, token: second)),
        .status(.init(installationId: identifier.uuidString)),
        .register(.init(installationId: identifier.uuidString, token: second)),
        .unregister(.init(installationId: identifier.uuidString)),
      ])
    #expect(await fixture.count() == 0)
    #expect(!FileManager.default.fileExists(atPath: outbox.path))
  }
}

@Test(.timeLimit(.minutes(1)))
func notificationPermissionCanCompleteAfterTheConnectionAndTokenArrive() async throws {
  try await withCoordinator { session, fixture, _ in
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await snapshot in session.updates where snapshot.connection == .connected { break }
    let gate = AsyncStream<Void>.makeStream()
    defer { gate.continuation.finish() }
    let probe = NotificationProbe()
    let registration = await NotificationRegistration(
      installationID: UUID(), enabled: true,
      permission: {
        probe.permissions += 1
        for await _ in gate.stream { return true }
        return false
      }, register: { probe.registrations += 1 }, save: { probe.saved.append($0) })
    let opening = Task { await registration.start() }
    while await probe.permissions == 0 { await Task.yield() }
    await registration.connect { request in try await session.notifications(request) }
    await registration.received(token: String(repeating: "ab", count: 32))
    #expect(await fixture.notificationControls().count == 1)
    gate.continuation.yield(())
    await opening.value
    #expect(await registration.registered)
    #expect(await fixture.notificationControls().count == 2)
    #expect(await probe.permissions == 1)
    #expect(await fixture.count() == 0)
  }
}

@Test(.timeLimit(.minutes(1))) @MainActor
func notificationDuplicateTokenKeepsAnUnconfirmedEnrollmentVisible() async {
  let replies = AsyncStream<Void>.makeStream()
  let observed = AsyncStream<NotificationRequest>.makeStream()
  let joined = AsyncStream<Void>.makeStream()
  defer {
    replies.continuation.finish()
    observed.continuation.finish()
    joined.continuation.finish()
  }
  let registration = NotificationRegistration(
    installationID: UUID(), enabled: true, permission: { true }, register: {}, save: { _ in })
  await registration.connect { request in
    observed.continuation.yield(request)
    if case .register = request {
      for await _ in replies.stream { break }
      return .init(configured: true, registered: false)
    }
    return .init(configured: true, registered: true)
  }
  #expect(registration.registered)
  let token = String(repeating: "ab", count: 32)
  let first = Task(priority: .high) { await registration.received(token: token) }
  for await request in observed.stream {
    if case .register = request { break }
  }
  let follower = Task(priority: .background) {
    joined.continuation.yield(())
    await registration.received(token: token)
  }
  for await _ in joined.stream { break }
  replies.continuation.yield(())
  await first.value
  await follower.value
  #expect(!registration.registered)
  #expect(registration.error?.contains("coordinator") == true)
}

@MainActor
private final class NotificationProbe {
  var permissions = 0
  var registrations = 0
  var saved: [Bool] = []
}
