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
  private enum Authorization { case unchecked, allowed, denied }
  private enum AppleRegistration { case idle, requested, ready, failed }
  private struct Enrollment {
    let id: UUID
    let generation: UUID
    let token: String
    let operation: Task<Void, any Error>
  }
  @ObservationIgnored private var authorization = Authorization.unchecked
  @ObservationIgnored private var apple = AppleRegistration.idle
  @ObservationIgnored private var enrollment: Enrollment?
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

  public func start() async {
    guard enabled, authorization == .unchecked else { return }
    await setEnabled(true)
  }

  public func disconnect() {
    generation = UUID()
    exchange = nil
    configured = false
    enrollment = nil
  }

  public func connect(
    exchange: @escaping @Sendable (NotificationRequest) async throws -> NotificationStatus
  ) async {
    self.exchange = exchange
    let generation = UUID()
    self.generation = generation
    configured = false
    enrollment = nil
    do {
      let status = try await request(.status(.init(installationId: installationID))).value
      guard self.generation == generation else { return }
      configured = status.configured
      registered = status.registered
      error = nil
      if enabled {
        await start()
        guard self.generation == generation else { return }
        if enabled, authorization == .allowed, configured {
          registerWithApple()
          if let token { try await enroll(token, generation: generation) }
        }
      } else if registered {
        // A lost withdrawal receipt must not silently re-enable alerts after
        // relaunch. Removing the same installation again is idempotent.
        try await withdraw()
      }
    } catch {
      if self.generation == generation {
        self.error =
          enabled || !registered
          ? error.localizedDescription
          : removalError(error)
      }
    }
  }

  public func setEnabled(_ value: Bool) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    var generation = generation
    do {
      if value {
        // Authorization belongs to the installation, not a connection that may
        // reconnect while Apple's first-launch prompt is open.
        let allowed = try await permission()
        generation = self.generation
        authorization = allowed ? .allowed : .denied
        guard allowed else {
          try await withdraw()
          throw RegistrationError.permission
        }
        enabled = true
        save(true)
        registerWithApple()
        if configured, let token { try await enroll(token, generation: generation) }
      } else {
        try await withdraw()
      }
      if self.generation == generation { error = nil }
    } catch {
      if self.generation == generation {
        self.error = !enabled && registered ? removalError(error) : error.localizedDescription
      }
    }
  }

  private func registerWithApple() {
    guard apple == .idle || apple == .failed else { return }
    apple = .requested
    register()
  }

  private func withdraw() async throws {
    // Persist intent before a receipt: late token callbacks cannot re-enroll.
    enabled = false
    save(false)
    enrollment = nil
    guard exchange != nil else {
      if registered { throw ConnectionError.closed }
      return
    }
    let generation = generation
    let status = try await request(.unregister(.init(installationId: installationID))).value
    guard self.generation == generation else { return }
    registered = status.registered
  }

  public func received(token: String) async {
    self.token = token
    apple = .ready
    guard enabled, authorization == .allowed, configured else { return }
    let generation = generation
    do {
      try await enroll(token, generation: generation)
      if self.generation == generation { error = nil }
    } catch {
      if self.generation == generation { self.error = error.localizedDescription }
    }
  }

  public func failed() {
    apple = .failed
    // A late OS callback cannot confirm an earlier coordinator withdrawal.
    guard enabled else { return }
    error =
      "This device could not register with Apple. Check the app's Push Notifications signing capability and network connection."
  }

  private func enroll(_ token: String, generation: UUID) async throws {
    let pending: Enrollment
    if let current = enrollment, current.generation == generation, current.token == token {
      pending = current
    } else {
      let id = UUID()
      let response = try request(.register(.init(installationId: installationID, token: token)))
      let operation = Task { [weak self] in
        let status = try await response.value
        guard let self, self.generation == generation, self.enrollment?.id == id else { return }
        self.registered = status.registered
        if !status.registered { throw RegistrationError.coordinatorSetup }
      }
      pending = Enrollment(
        id: id, generation: generation, token: token, operation: operation)
      enrollment = pending
    }
    do {
      try await pending.operation.value
    } catch {
      if enrollment?.id == pending.id { enrollment = nil }
      throw error
    }
  }

  private func request(_ request: NotificationRequest) throws -> Task<NotificationStatus, any Error>
  {
    guard let exchange else { throw ConnectionError.closed }
    let previous = control
    // Serialize enrollment and withdrawal. A late token registration cannot
    // overtake a user's disable request on another control connection.
    let operation = Task {
      _ = try? await previous?.value
      return try await exchange(request)
    }
    control = operation
    return operation
  }

  private func removalError(_ error: any Error) -> String {
    "Notification removal is unconfirmed. Reconnect or retry removing this device. \(error.localizedDescription)"
  }
}

private enum RegistrationError: LocalizedError {
  case coordinatorSetup, permission
  var errorDescription: String? {
    switch self {
    case .coordinatorSetup:
      "Notifications are not configured on the coordinator. Complete the APNs setup to receive alerts."
    case .permission: "Allow Beep Boop notifications in iPhone Settings to receive alerts."
    }
  }
}
