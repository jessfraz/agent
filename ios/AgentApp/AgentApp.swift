import AgentUI
import SwiftUI

@main
struct AgentApp: App {
  @UIApplicationDelegateAdaptor(AppNotifications.self) private var notifications
  var body: some Scene {
    WindowGroup { MainChatView(notifications: notifications) }
  }
}
