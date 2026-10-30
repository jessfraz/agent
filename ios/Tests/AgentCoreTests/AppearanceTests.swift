import Foundation
import SwiftUI
import Testing

@testable import AgentUI

@Test @MainActor
func appearancePreferencesFollowSystemUnlessExplicitlyOverridden() throws {
  let name = "appearance-fixture-\(UUID())"
  let defaults = try #require(UserDefaults(suiteName: name))
  defer { defaults.removePersistentDomain(forName: name) }
  let fresh = AppStorage(
    wrappedValue: AppAppearance.system, AppAppearance.preferenceKey, store: defaults)
  #expect(fresh.wrappedValue == .system)
  #expect(fresh.wrappedValue.colorScheme == nil)
  for appearance in AppAppearance.allCases {
    fresh.wrappedValue = appearance
    #expect(defaults.string(forKey: AppAppearance.preferenceKey) == appearance.rawValue)
    let reopened = AppStorage(
      wrappedValue: AppAppearance.system, AppAppearance.preferenceKey, store: defaults)
    #expect(reopened.wrappedValue == appearance)
    #expect(
      reopened.wrappedValue.colorScheme
        == (appearance == .system ? nil : appearance == .dark ? ColorScheme.dark : .light))
  }
  defaults.set("future-value", forKey: AppAppearance.preferenceKey)
  let unknown = AppStorage(
    wrappedValue: AppAppearance.system, AppAppearance.preferenceKey, store: defaults)
  #expect(unknown.wrappedValue == .system)
}
