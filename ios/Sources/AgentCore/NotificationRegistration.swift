import Foundation
import Observation

/// Device enrollment uses control requests, never model input. Tokens stay in memory.
@MainActor @Observable
public final class NotificationRegistration {
  public private(set) var enabled: Bool
  public private(set) var configured = false
  public private(set) var registered = false
  public private(set) var busy = false
  public private(set) var error: String?
  public let installationID: String
  @ObservationIgnored private var token: String?
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var exchange:
    (@Sendable (NotificationRequest) async throws -> NotificationStatus)?
  @ObservationIgnored private var control: Task<NotificationStatus, any Error>?
  @ObservationIgnored private let permission: @MainActor () async throws -> Bool
  @ObservationIgnored private let register: @MainActor () -> Void
  @ObservationIgnored private let save: @MainActor (Bool) -> Void

  public init(
    installationID: UUID, enabled: Bool,
    permission: @escaping @MainActor () async throws -> Bool,
    register: @escaping @MainActor () -> Void,
    save: @escaping @MainActor (Bool) -> Void
  ) {
    self.installationID = installationID.uuidString
    self.enabled = enabled
    self.permission = permission
    self.register = register
    self.save = save
  }

  public func connect(
    exchange: @escaping @Sendable (NotificationRequest) async throws -> NotificationStatus
  ) async {
    self.exchange = exchange
    let generation = UUID()
    self.generation = generation
    do {
      let status = try await request(.status(.init(installationId: installationID)))
      guard self.generation == generation else { return }
      configured = status.configured
      registered = status.registered
      error = nil
      if enabled, configured {
        register()
      } else if !enabled, registered {
        // A lost withdrawal receipt must not silently re-enable alerts after
        // relaunch. Removing the same installation again is idempotent.
        let removed = try await request(.unregister(.init(installationId: installationID)))
        guard self.generation == generation else { return }
        registered = removed.registered
      }
    } catch {
      if self.generation == generation {
        self.error =
          enabled || !registered
          ? error.localizedDescription
          : "Notification removal is unconfirmed. Reconnect or retry removing this device. \(error.localizedDescription)"
      }
    }
  }

  public func setEnabled(_ value: Bool) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    let generation = generation
    do {
      if value {
        guard configured else { throw RegistrationError.coordinatorSetup }
        guard try await permission() else { throw RegistrationError.permission }
        guard self.generation == generation else { return }
        enabled = true
        save(true)
        register()
        if let token { try await enroll(token, generation: generation) }
      } else {
        // Persist the intent before the receipt so a fresh token cannot enroll
        // again while withdrawal is waiting or its connection is uncertain.
        enabled = false
        save(false)
        let status = try await request(.unregister(.init(installationId: installationID)))
        guard self.generation == generation else { return }
        registered = status.registered
      }
      error = nil
    } catch {
      if self.generation == generation {
        self.error =
          value
          ? error.localizedDescription
          : "Notification removal is unconfirmed. Reconnect or retry removing this device. \(error.localizedDescription)"
      }
    }
  }

  public func received(token: String) async {
    self.token = token
    guard enabled, configured else { return }
    let generation = generation
    do {
      try await enroll(token, generation: generation)
      if self.generation == generation { error = nil }
    } catch {
      if self.generation == generation { self.error = error.localizedDescription }
    }
  }

  public func failed() {
    // A late OS enrollment callback says nothing about an earlier coordinator
    // withdrawal. Preserve its receipt and the user's disabled intent.
    guard enabled else { return }
    error =
      "This device could not register with Apple. Check the app's Push Notifications signing capability and network connection."
  }

  private func enroll(_ token: String, generation: UUID) async throws {
    let status = try await request(.register(.init(installationId: installationID, token: token)))
    guard self.generation == generation else { return }
    registered = status.registered
    if !status.registered { throw RegistrationError.coordinatorSetup }
  }

  private func request(_ request: NotificationRequest) async throws -> NotificationStatus {
    guard let exchange else { throw ConnectionError.closed }
    let previous = control
    // Serialize enrollment and withdrawal. A late token registration must not
    // overtake a user's disable request on another control connection.
    let operation = Task {
      _ = try? await previous?.value
      return try await exchange(request)
    }
    control = operation
    return try await operation.value
  }
}

private enum RegistrationError: LocalizedError {
  case coordinatorSetup, permission
  var errorDescription: String? {
    switch self {
    case .coordinatorSetup:
      "Notifications are not configured on the coordinator. Complete the APNs setup before enabling this device."
    case .permission: "Allow Agent notifications in iPhone Settings to receive alerts."
    }
  }
}
