import AgentCore
import Foundation
import Observation
import UserNotifications

#if os(iOS)
  import UIKit
#endif

/// The app delegate owns OS registration; the coordinator owns delivery.
@MainActor @Observable
public final class AppNotifications: NSObject {
  public let registration: NotificationRegistration
  public var mainVisible = false
  public private(set) var openedTarget: NotificationTarget?
  var presentsAlerts: Bool { !mainVisible && registration.enabled }
  func open(_ target: NotificationTarget) { openedTarget = target }

  public override convenience init() { self.init(defaults: .standard) }

  public init(defaults: UserDefaults) {
    let identifier =
      defaults.string(forKey: "notificationInstallationID").flatMap(UUID.init(uuidString:))
      ?? UUID()
    defaults.set(identifier.uuidString, forKey: "notificationInstallationID")
    registration = NotificationRegistration(
      installationID: identifier,
      enabled: defaults.object(forKey: "notificationsEnabled") == nil
        || defaults.bool(forKey: "notificationsEnabled"),
      permission: {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
          return try await center.requestAuthorization(options: [.alert, .sound])
        case .authorized, .provisional: return true
        #if os(iOS)
          case .ephemeral: return true
        #endif
        case .denied: return false
        @unknown default: return false
        }
      },
      register: {
        #if os(iOS)
          UIApplication.shared.registerForRemoteNotifications()
        #endif
      },
      save: { defaults.set($0, forKey: "notificationsEnabled") })
    super.init()
  }

  private nonisolated static func target(_ userInfo: [AnyHashable: Any]) -> NotificationTarget? {
    guard let value = userInfo["agent"], JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(NotificationTarget.self, from: data)
  }
}

#if os(iOS)
  extension AppNotifications: UIApplicationDelegate {
    public func application(
      _ application: UIApplication,
      didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
      UNUserNotificationCenter.current().delegate = self
      Task { await registration.start() }
      return true
    }

    public func application(
      _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data
    ) {
      let value = token.map { String(format: "%02x", $0) }.joined()
      Task { await registration.received(token: value) }
    }

    public func application(
      _ application: UIApplication,
      didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
      registration.failed()
    }
  }

  extension AppNotifications: UNUserNotificationCenterDelegate {
    public nonisolated func userNotificationCenter(
      _ center: UNUserNotificationCenter,
      willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
      await MainActor.run { presentsAlerts ? [.banner, .sound] : [] }
    }

    public nonisolated func userNotificationCenter(
      _ center: UNUserNotificationCenter,
      didReceive response: UNNotificationResponse
    ) async {
      let target = Self.target(response.notification.request.content.userInfo)
      if let target { await MainActor.run { open(target) } }
    }
  }
#endif
