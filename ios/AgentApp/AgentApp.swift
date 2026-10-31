import AgentUI
import SwiftUI

@main
struct AgentApp: App {
  @UIApplicationDelegateAdaptor(AppNotifications.self) private var notifications
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if let fixture = InteractionFixture.fromEnvironment() {
          fixture
        } else {
          MainChatView(notifications: notifications)
        }
      #else
        MainChatView(notifications: notifications)
      #endif
    }
  }
}
