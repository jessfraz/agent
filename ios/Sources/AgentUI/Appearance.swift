import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
  case system, light, dark

  static let preferenceKey = "appearance"
  var id: Self { self }
  var label: String {
    switch self {
    case .system: "System"
    case .light: "Light"
    case .dark: "Dark"
    }
  }
  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}
