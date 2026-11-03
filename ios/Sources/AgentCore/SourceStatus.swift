import Foundation

extension SourceKey: Hashable {
  public func hash(into hasher: inout Hasher) {
    hasher.combine(provider)
    hasher.combine(account)
  }
}

extension SourceState {
  public var displayName: String {
    switch source.provider {
    case "google": "Gmail"
    case "google_calendar": "Calendar"
    case "github": "GitHub"
    case "slack": "Slack"
    case "messages": "Messages"
    case "task_outcomes": "Task outcomes"
    default: "Other source"
    }
  }
  public var lastChecked: Date? {
    checkedAt > 0 ? Date(timeIntervalSince1970: Double(checkedAt) / 1000) : nil
  }
}

extension SourceCoverage {
  public var label: String {
    switch self {
    case .complete: "Current"
    case .more: "Catching up"
    case .partial: "Partial"
    case .unavailable: "Unavailable"
    }
  }
  /// The source adapter supplies this safe diagnostic, excluding helper payloads.
  public var diagnostic: String? {
    switch self {
    case .partial(let value): value.message
    case .unavailable(let value): value.message
    case .complete, .more: nil
    }
  }
}
