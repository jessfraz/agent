import AgentCore
import Foundation
import SwiftUI

typealias ToolDetailsLoader = @MainActor (ChatRow) async throws -> ToolDetails

struct ActivityExpansion {
  var groups: Set<String> = []
  var items: Set<String> = []
}

/// An expanded group's visible rows share one lookup at a time. Cancellation
/// abandons a queued row before it opens a socket, without cancelling its neighbor.
@MainActor final class ActivityDetailQueue {
  private var tail: Task<Void, Never>?

  func load(_ row: ChatRow, using loader: @escaping ToolDetailsLoader) async throws -> ToolDetails {
    let previous = tail
    let operation = Task {
      await previous?.value
      try Task.checkCancellation()
      return try await loader(row)
    }
    tail = Task { _ = try? await operation.value }
    return try await withTaskCancellationHandler {
      try await operation.value
    } onCancel: {
      operation.cancel()
    }
  }
}

@MainActor
enum TranscriptItem: Identifiable {
  case message(RowModel)
  case activity(ActivityGroup)

  nonisolated var id: String {
    switch self {
    case .message(let row): row.id
    case .activity(let group): group.id
    }
  }

  static func grouped(_ rows: [RowModel]) -> [TranscriptItem] {
    var result: [TranscriptItem] = []
    var activity: [RowModel] = []
    func flush() {
      if let first = activity.first {
        result.append(.activity(ActivityGroup(id: "activity:\(first.id)", rows: activity)))
      }
      activity = []
    }
    for row in rows {
      if row.row.tool != nil || row.row.role == .thinking {
        activity.append(row)
      } else {
        flush()
        result.append(.message(row))
      }
    }
    flush()
    return result
  }
}

@MainActor
struct ActivityGroup: Identifiable {
  let id: String
  let rows: [RowModel]

  var running: Bool { rows.contains { $0.row.tool?.status == .running } }
  var failed: Bool { rows.contains { $0.row.tool?.status == .failed } }
  var summary: String {
    let tools = rows.filter { $0.row.tool != nil }.count
    let thoughts = rows.filter { $0.row.role == .thinking }.count
    let failures = rows.filter { $0.row.tool?.status == .failed }.count
    let active = rows.filter { $0.row.tool?.status == .running }.count
    return [
      failures == 0 ? nil : "\(failures) failed",
      active == 0 ? nil : "\(active) running",
      tools == 0 ? nil : "\(tools) tool \(tools == 1 ? "call" : "calls")",
      thoughts == 0 ? nil : "\(thoughts) \(thoughts == 1 ? "thought" : "thoughts")",
    ].compactMap { $0 }.joined(separator: " · ")
  }
}

struct ActivityGroupView: View {
  let group: ActivityGroup
  @Binding var expansion: ActivityExpansion
  let details: ToolDetailsLoader
  var onExpand: () -> Void = {}
  @State private var queue = ActivityDetailQueue()

  private var expanded: Bool { expansion.groups.contains(group.id) }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        if expanded {
          expansion.groups.remove(group.id)
        } else {
          expansion.groups.insert(group.id)
          onExpand()
        }
      } label: {
        HStack(spacing: 8) {
          ActivityStatus(running: group.running, failed: group.failed)
          Text(group.summary).lineLimit(2).multilineTextAlignment(.leading)
            .foregroundStyle(group.failed ? .primary : .secondary)
          Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
        }
        .font(.footnote).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityIdentifier(group.id)
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      if expanded {
        LazyVStack(alignment: .leading, spacing: 4) {
          ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
            ActivityItemView(
              model: row,
              expanded: Binding(
                get: { expansion.items.contains(row.id) },
                set: { value in
                  if value {
                    expansion.items.insert(row.id)
                  } else {
                    expansion.items.remove(row.id)
                  }
                }),
              details: { row in try await queue.load(row, using: details) },
              ordinal: group.rows[..<index].filter { $0.row.tool != nil }.count + 1,
              onExpand: onExpand)
          }
        }
        .padding(.leading, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct ActivityStatus: View {
  var running = false
  var failed = false

  var body: some View {
    Group {
      if failed {
        Image(systemName: "xmark.circle").foregroundStyle(.red)
      } else if running {
        ProgressView().controlSize(.mini)
      } else {
        Image(systemName: "checkmark").foregroundStyle(.secondary)
      }
    }
    .font(.caption).frame(width: 18, height: 18).accessibilityHidden(true)
  }
}

struct ActivityItemView: View {
  let model: RowModel
  @Binding var expanded: Bool
  let details: ToolDetailsLoader
  var ordinal: Int?
  var onExpand: () -> Void = {}
  @State private var loaded: ToolDetails?
  @State private var error: String?
  @State private var reload = 0
  @State private var showsRawInput = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        expanded.toggle()
        if expanded { onExpand() }
      } label: {
        HStack(alignment: .center, spacing: 8) {
          if let tool = model.row.tool {
            ActivityStatus(running: tool.status == .running, failed: tool.status == .failed)
          } else {
            Image(systemName: "text.alignleft").font(.caption).frame(width: 18)
          }
          Text(title).lineLimit(1).truncationMode(.middle).multilineTextAlignment(.leading)
            .font(commandInput == nil ? .footnote : .system(.footnote, design: .monospaced))
          Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
        }
        .font(.footnote).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityIdentifier("activity-item:\(model.id)")
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      if expanded {
        Group {
          if model.row.tool != nil {
            VStack(alignment: .leading, spacing: 8) { toolDetails }
              .padding(12)
              .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
              .overlay {
                RoundedRectangle(cornerRadius: 12).strokeBorder(
                  model.row.tool?.status == .failed
                    ? Color.red.opacity(0.2) : Color.primary.opacity(0.08),
                  lineWidth: 0.5)
              }
          } else {
            RichMessage(blocks: model.row.blocks, textStyle: .callout, compact: true)
              .foregroundStyle(.primary.opacity(0.75))
          }
        }
        .padding(.leading, 26).padding(.bottom, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contextMenu {
      ShareLink(item: model.row.text) { Label("Share text", systemImage: "square.and.arrow.up") }
    }
    .task(id: "\(model.row.entryID ?? ""):\(model.row.tool?.status.rawValue ?? ""):\(reload)") {
      guard model.row.tool != nil else { return }
      loaded = nil
      error = nil
      do {
        let value = try await details(model.row)
        guard !Task.isCancelled else { return }
        loaded = value
      } catch {
        guard !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
  }

  private var commandInput: CommandInput? {
    guard case .available(let value) = loaded, value.name == "exec" else { return nil }
    return CommandInput.decode(value.input)
  }

  private var title: String {
    if let tool = model.row.tool {
      if let commandInput { return commandInput.display }
      if tool.name == "exec" { return "Command\(ordinal.map { " \($0)" } ?? "")" }
      return tool.name.replacingOccurrences(of: "_", with: " ")
    }
    for block in model.row.blocks {
      switch block {
      case .prose(let value), .heading(let value, _), .quote(let value), .listItem(let value, _, _):
        if let line = String(value.characters).split(whereSeparator: \.isNewline).first {
          return String(line.prefix(160))
        }
      default: break
      }
    }
    return "Thinking"
  }

  @ViewBuilder private var toolDetails: some View {
    if let error {
      Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
      Button("Try again") { reload += 1 }.buttonStyle(.plain).frame(minHeight: 44)
    } else if let loaded {
      switch loaded {
      case .unavailable:
        Text("Details aren’t available for this activity.").font(.callout).foregroundStyle(
          .secondary)
      case .available(let value):
        VStack(alignment: .leading, spacing: 12) {
          Text(value.status.rawValue.capitalized).font(.caption.weight(.medium))
            .foregroundStyle(value.status == .failed ? .red : .secondary)
          if value.name == "exec", let command = CommandInput.decode(value.input) {
            ToolText(title: "Command", text: command.display)
            if let cwd = command.cwd { ToolText(title: "Working directory", text: cwd) }
            if let host = command.host { ToolText(title: "Host", text: host) }
            if let seconds = command.timeoutSeconds {
              Text("Timeout: \(seconds) seconds").font(.caption).foregroundStyle(.secondary)
            }
            Button {
              showsRawInput.toggle()
            } label: {
              HStack {
                Text("Input details")
                Spacer()
                Image(systemName: showsRawInput ? "chevron.down" : "chevron.right")
              }.contentShape(Rectangle())
            }
            .font(.caption).buttonStyle(.plain).frame(minHeight: 44)
            .accessibilityValue(showsRawInput ? "Expanded" : "Collapsed")
            if showsRawInput { ToolContent(title: "Input", content: value.input) }
          } else {
            ToolContent(title: "Input", content: value.input)
          }
          if value.name == "exec", let process = ProcessOutput.decode(value.output) {
            if !process.stdout.isEmpty { ToolText(title: "Output", text: process.stdout) }
            if !process.stderr.isEmpty {
              ToolText(title: "Error output", text: process.stderr, error: true)
            }
            Text("Exit code \(process.exitCode)").font(.caption.weight(.medium))
              .foregroundStyle(process.exitCode == 0 ? Color.secondary : Color.red)
            if process.truncated {
              Text("Output truncated.").font(.caption).foregroundStyle(.secondary)
            }
          } else {
            ToolContent(title: "Output", content: value.output)
          }
        }
      }
    } else {
      ProgressView("Loading details…").font(.caption).foregroundStyle(.secondary)
    }
  }
}

private struct ToolText: View {
  let title: String
  let text: String
  var error = false
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if error {
        Label(title, systemImage: "exclamationmark.circle")
          .font(.caption.weight(.medium)).foregroundStyle(.red)
      } else {
        Text(title).font(.caption).foregroundStyle(.secondary)
      }
      ScrollView(.horizontal) {
        Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct ToolContent: View {
  let title: String
  let content: ToolDetailContent
  var body: some View {
    switch content {
    case .text(let value):
      ToolText(title: title, text: value.text)
      if value.truncated { Text("\(title) truncated.").font(.caption).foregroundStyle(.secondary) }
    case .unavailable(let value):
      Text("\(title): \(value.reason.description)").font(.caption).foregroundStyle(.secondary)
    }
  }
}

extension ToolDetailUnavailable {
  fileprivate var description: String {
    switch self {
    case .notRecorded: "not recorded"
    case .pending: "still running"
    case .lookupLimit: "outside the available history window"
    case .unsupported: "this format can’t be displayed"
    }
  }
}

private struct CommandInput: Decodable {
  let program: String
  let args: [String]
  let cwd: String?
  let host: String?
  let timeoutSeconds: Int?
  enum CodingKeys: String, CodingKey {
    case program, args, cwd, host
    case timeoutSeconds = "timeout_seconds"
  }
  var display: String {
    ([program] + args).map { value in
      let literal = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=/:.,@"
      if !value.isEmpty && value.allSatisfy({ literal.contains($0) }) { return value }
      return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
    .joined(separator: " ")
  }
  static func decode(_ content: ToolDetailContent) -> CommandInput? {
    guard case .text(let value) = content, !value.truncated else { return nil }
    return try? JSONDecoder().decode(Self.self, from: Data(value.text.utf8))
  }
}

private struct ProcessOutput: Decodable {
  let type: String
  let exitCode: Int
  let stdout: String
  let stderr: String
  let truncated: Bool
  enum CodingKeys: String, CodingKey {
    case type, stdout, stderr, truncated
    case exitCode = "exit_code"
  }
  static func decode(_ content: ToolDetailContent) -> ProcessOutput? {
    guard case .text(let value) = content, !value.truncated,
      let process = try? JSONDecoder().decode(Self.self, from: Data(value.text.utf8)),
      process.type == "process"
    else { return nil }
    return process
  }
}
