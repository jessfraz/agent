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

  var anchorID: String? {
    switch self {
    case .message(let row): row.id
    case .activity(let group): group.rows.first?.id
    }
  }

  static func grouped(_ rows: [RowModel], preserving previous: [TranscriptItem] = [])
    -> [TranscriptItem]
  {
    var result: [TranscriptItem] = []
    var activity: [RowModel] = []
    var previousGroups: [String: String] = [:]
    for case .activity(let group) in previous {
      for row in group.rows { previousGroups[row.id] = group.id }
    }
    var usedGroups: Set<String> = []
    func flush() {
      if let first = activity.first {
        // Earlier pages can extend a leading group; live output can append to
        // it. Keep its identity in both directions, including open disclosures.
        var id = "activity:\(first.id)"
        for row in activity {
          if let previousID = previousGroups[row.id], !usedGroups.contains(previousID) {
            id = previousID
            break
          }
        }
        if usedGroups.contains(id) { id = "activity:\(UUID().uuidString)" }
        usedGroups.insert(id)
        result.append(.activity(ActivityGroup(id: id, rows: activity)))
      }
      activity = []
    }
    for row in rows {
      if row.row.tool != nil || row.row.role == .thinking
        || (row.row.role == .tool && row.row.presentation != nil)
      {
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

  var status: ToolStatus? {
    rows.compactMap { $0.row.tool?.status }.max { $0.activityPriority < $1.activityPriority }
  }
  var running: Bool { rows.contains { $0.row.tool?.status == .running } }
  var failed: Bool { rows.contains { $0.row.tool?.status == .failed } }
  var summary: String {
    let tools = rows.filter { $0.row.tool != nil }.count
    let thoughts = rows.filter { $0.row.role == .thinking }.count
    let failures = rows.filter { $0.row.tool?.status == .failed }.count
    let active = rows.filter { $0.row.tool?.status == .running }.count
    let declined = rows.filter { $0.row.tool?.status == .declined }.count
    let interrupted = rows.filter { $0.row.tool?.status == .interrupted }.count
    let unknown = rows.filter { $0.row.tool?.status == .unknown }.count
    let events = rows.filter {
      $0.row.presentation != nil && $0.row.tool == nil && $0.row.role != .thinking
    }.count
    return [
      failures == 0 ? nil : "\(failures) failed",
      active == 0 ? nil : "\(active) running",
      declined == 0 ? nil : "\(declined) declined",
      interrupted == 0 ? nil : "\(interrupted) interrupted",
      unknown == 0 ? nil : "\(unknown) unknown",
      tools == 0 ? nil : "\(tools) tool \(tools == 1 ? "call" : "calls")",
      thoughts == 0 ? nil : "\(thoughts) \(thoughts == 1 ? "summary" : "summaries")",
      events == 0 ? nil : "\(events) \(events == 1 ? "event" : "events")",
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
          ActivityStatus(status: group.status)
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
            if row.row.role == .thinking, row.row.tool == nil {
              RichMessage(blocks: row.row.blocks, textStyle: .callout, compact: true)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
                .messageTextActions(row.row.text)
            } else {
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
        }
        .padding(.leading, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension ToolStatus {
  func commandTitle(_ command: String?, ordinal: Int? = nil) -> String {
    let description = command ?? "command\(ordinal.map { " \($0)" } ?? "")"
    return switch self {
    case .finished: "Ran " + description
    case .running: "Running " + description
    case .failed: "Failed command · " + description
    case .declined: "Declined command · " + description
    case .interrupted: "Interrupted command · " + description
    case .unknown: command.map { "Command " + $0 } ?? description.capitalized
    }
  }

  func commandResult(exitCode: Int?) -> String {
    switch self {
    case .running: return "Running"
    case .declined: return "Declined"
    case .interrupted: return "Interrupted"
    case .failed: return exitCode.map { "Failed (exit \($0))" } ?? "Failed"
    case .finished, .unknown:
      if let exitCode { return exitCode == 0 ? "Success" : "Failed (exit \(exitCode))" }
      return self == .finished ? "Finished" : "Status unavailable"
    }
  }

  fileprivate var activityPriority: Int {
    switch self {
    case .finished: 0
    case .unknown: 1
    case .declined: 2
    case .interrupted: 3
    case .running: 4
    case .failed: 5
    }
  }
}

private struct ActivityStatus: View {
  var status: ToolStatus?

  var body: some View {
    Group {
      switch status {
      case .failed:
        Image(systemName: "xmark.circle").foregroundStyle(.red)
      case .running:
        ProgressView().controlSize(.mini)
      case .finished:
        Image(systemName: "checkmark").foregroundStyle(.secondary)
      case .declined:
        Image(systemName: "minus.circle").foregroundStyle(.secondary)
      case .interrupted:
        Image(systemName: "pause.circle").foregroundStyle(.secondary)
      case .unknown:
        Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
      case nil:
        Image(systemName: "text.alignleft").foregroundStyle(.secondary)
      }
    }
    .font(.caption).frame(width: 18, height: 18)
    .accessibilityLabel(status?.rawValue.capitalized ?? "Activity")
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
          if let tool = model.row.tool, tool.status != .finished {
            ActivityStatus(status: tool.status)
          }
          Image(
            systemName: model.row.presentation?.activitySymbol ?? (isShell ? "terminal" : "wrench")
          )
          .font(.callout).frame(width: 20).accessibilityHidden(true)
          Text(title).lineLimit(1).truncationMode(.tail).multilineTextAlignment(.leading)
            .font(.callout)
          Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
        }
        .font(.footnote).foregroundStyle(.primary.opacity(0.65))
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityIdentifier("activity-item:\(model.id)")
      .accessibilityLabel(title)
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      if expanded {
        if isShell {
          shellCard.padding(.leading, 26).padding(.bottom, 8)
        } else {
          VStack(alignment: .leading, spacing: 8) {
            presentationDetails
            if !model.row.text.isEmpty {
              if model.row.tool != nil {
                ToolText(title: "Output", text: model.row.text)
              } else {
                RichMessage(blocks: model.row.blocks, textStyle: .callout, compact: true)
                  .foregroundStyle(.primary.opacity(0.75))
              }
            }
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
            }
          }
          .padding(.leading, 26).padding(.bottom, 8)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .messageTextActions(model.row.text)
    .task(
      id:
        "\(expanded):\(model.row.entryID ?? ""):\(model.row.tool?.status.rawValue ?? ""):\(reload)"
    ) {
      loaded = nil
      error = nil
      guard expanded, model.row.tool != nil else { return }
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

  private var commandPreview: String? {
    guard case .command(let value)? = model.row.presentation else { return nil }
    return value.command
  }

  private var title: String {
    if let presentation = model.row.presentation {
      if case .command(let value) = presentation {
        return shellStatus.commandTitle(value.command ?? commandInput?.display, ordinal: ordinal)
      }
      return presentation.activityTitle(
        toolName: model.row.tool?.name, status: model.row.tool?.status)
    }
    if let tool = model.row.tool {
      if tool.name == "exec" {
        return shellStatus.commandTitle(commandInput?.display, ordinal: ordinal)
      }
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

  private var isShell: Bool {
    switch model.row.presentation {
    case .command?: true
    case nil: model.row.tool?.name == "exec"
    default: false
    }
  }

  private var shellStatus: ToolStatus {
    model.row.tool?.status ?? availableDetails?.status ?? .unknown
  }

  private var availableDetails: ToolDetailsAvailable? {
    guard case .available(let value) = loaded else { return nil }
    return value
  }

  private var shellExitCode: Int? {
    if let output = availableDetails?.output, let process = ProcessOutput.decode(output) {
      return process.exitCode
    }
    guard case .command(let value)? = model.row.presentation else { return nil }
    return value.exitCode
  }

  private var shellDurationMs: Int? {
    guard case .command(let value)? = model.row.presentation else { return nil }
    return value.durationMs
  }

  private var shellCard: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Shell").font(.callout.weight(.medium)).foregroundStyle(.primary.opacity(0.65))
      if let command = commandPreview ?? commandInput?.display {
        Text("$ " + command).font(.system(.callout, design: .monospaced))
          .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
          .messageTextActions(command)
      } else {
        Text("Command not recorded.").font(.callout).foregroundStyle(.secondary)
      }
      shellOutput
      if let error {
        Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
        Button("Try again") { reload += 1 }.buttonStyle(.plain).frame(minHeight: 44)
      }
      if availableDetails != nil || shellDurationMs != nil {
        DisclosureGroup("Input details", isExpanded: $showsRawInput) {
          if let commandInput {
            if let cwd = commandInput.cwd { ToolText(title: "Working directory", text: cwd) }
            if let host = commandInput.host { ToolText(title: "Host", text: host) }
            if let seconds = commandInput.timeoutSeconds {
              Text("Timeout: \(seconds) seconds").font(.caption).foregroundStyle(.secondary)
            }
          }
          if let duration = shellDurationMs {
            Text("\(duration) ms").font(.caption).foregroundStyle(.secondary)
          }
          if let details = availableDetails { ToolContent(title: "Input", content: details.input) }
        }.font(.caption).tint(.primary)
      }
      Text(shellStatus.commandResult(exitCode: shellExitCode))
        .font(.caption).foregroundStyle(
          shellStatus == .failed || (shellExitCode ?? 0) != 0
            ? Color.red : Color.primary.opacity(0.65)
        )
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
    .overlay {
      RoundedRectangle(cornerRadius: 16).strokeBorder(
        shellStatus == .failed ? Color.red.opacity(0.2) : Color.primary.opacity(0.08),
        lineWidth: 0.5)
    }
  }

  @ViewBuilder private var shellOutput: some View {
    if let output = availableDetails?.output, case .text(let value) = output {
      let process = ProcessOutput.decode(output)
      let text = process?.stdout ?? value.text
      if !model.row.text.isEmpty && !model.row.text.utf8.elementsEqual(text.utf8)
        && !model.row.text.utf8.elementsEqual(value.text.utf8)
      {
        ToolText(title: "Preview", text: model.row.text)
      }
      if !text.isEmpty { ShellOutput(text: text) }
      if let process, !process.stderr.isEmpty {
        Label("Error output", systemImage: "exclamationmark.circle").font(.caption)
          .foregroundStyle(.red)
        ShellOutput(text: process.stderr)
      }
      if value.truncated || process?.truncated == true {
        Text("Output truncated.").font(.caption).foregroundStyle(.secondary)
      }
    } else {
      if !model.row.text.isEmpty { ShellOutput(text: model.row.text) }
      if let output = availableDetails?.output, case .unavailable(let value) = output {
        Text("Output: \(value.reason.description)").font(.caption).foregroundStyle(.secondary)
      } else if case .unavailable = loaded, model.row.text.isEmpty {
        Text("Output not recorded.").font(.caption).foregroundStyle(.secondary)
      } else if loaded == nil, model.row.tool != nil, error == nil {
        ProgressView("Loading output…").font(.caption).foregroundStyle(.secondary)
      }
    }
  }

  @ViewBuilder private var presentationDetails: some View {
    if let presentation = model.row.presentation {
      switch presentation {
      case .fileChanges(let value):
        ForEach(Array(value.changes.enumerated()), id: \.offset) { _, change in
          Text("\(change.operation?.rawValue ?? "change") \(change.path)")
            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
      case .agentCoordination(let value):
        ForEach(Array(value.activityAgentLines.enumerated()), id: \.offset) { _, line in
          Text(line)
            .font(.caption).textSelection(.enabled)
        }
      case .agentActivity(let value):
        ToolText(
          title: "Agent", text: value.agentPath.isEmpty ? "Agent" : value.agentPath)
        Text(value.state?.rawValue ?? "State unavailable").font(.caption)
      case .webSearch(let value):
        if !value.query.isEmpty { ToolText(title: "Query", text: value.query) }
      case .media(let value):
        if let path = value.path { ToolText(title: "File", text: path) }
        if let status = value.status { Text(status).font(.caption) }
      case .sleep(let value):
        if let duration = value.durationMs { Text("\(duration) ms").font(.caption) }
      case .hookPrompt:
        Text("Retained historical instructions stay inert.").font(.caption)
      default: EmptyView()
      }
    }
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
          ToolContent(title: "Input", content: value.input)
          ToolContent(
            title: "Output", content: value.output, name: value.name,
            preview: model.row.presentation == nil ? nil : model.row.text)
        }
      }
    } else {
      ProgressView("Loading details…").font(.caption).foregroundStyle(.secondary)
    }
  }
}

extension AgentStatePresentation {
  var activityName: String {
    let label = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return label.isEmpty ? "Agent" : label
  }
}

extension MessagePresentationAgentCoordination {
  private var activityAgentNames: [String] {
    agents.isEmpty ? receiverThreadIds.map { _ in "Agent" } : agents.map(\.activityName)
  }

  var activityAgentLines: [String] {
    // A successful input operation acknowledges delivery, not the target's
    // completion. Legacy snapshots may still carry its previous task state.
    switch action {
    case .sendInput, .sendMessage, .followup: return activityAgentNames
    default:
      if agents.isEmpty { return activityAgentNames }
      return agents.map {
        let state =
          $0.state?.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
          ?? "State unavailable"
        return "\($0.activityName) · \(state)"
      }
    }
  }

  func activityTitle(status: ToolStatus?) -> String {
    let label: String =
      switch action {
      case .spawn: "Spawn agent"
      case .sendInput: status == .finished ? "Sent input" : "Send agent input"
      case .sendMessage: status == .finished ? "Sent message" : "Message agent"
      case .followup: status == .finished ? "Queued input" : "Queue agent input"
      case .resume: "Resume agent"
      case .wait: "Wait for agents"
      case .close: "Close agent"
      case .interrupt: "Interrupt agent"
      case .list: "List agents"
      case .report: "Agent report"
      case nil: "Agent operation"
      }
    let names = activityAgentNames
    return names.isEmpty ? label : label + " · " + names.joined(separator: ", ")
  }
}

extension MessagePresentation {
  var activitySymbol: String {
    switch self {
    case .command: "terminal"
    case .fileChanges: "pencil"
    case .tool: "wrench.and.screwdriver"
    case .agentCoordination, .agentActivity: "person.2"
    case .webSearch(let value): value.action == .openPage ? "book" : "magnifyingglass"
    case .media: "photo"
    case .sleep: "clock"
    case .plan: "checklist"
    case .review: "checkmark.shield"
    case .hookPrompt: "text.quote"
    case .compaction: "arrow.triangle.2.circlepath"
    case .unknown, .unavailable: "questionmark.circle"
    }
  }

  func activityTitle(toolName: String? = nil, status: ToolStatus? = nil) -> String {
    switch self {
    case .command(let value):
      status.map { $0.commandTitle(value.command) } ?? value.command ?? "Command"
    case .fileChanges(let value):
      value.changes.isEmpty
        ? "File changes"
        : (status == .running
          ? "Editing " : status == .finished ? "Edited " : status == nil ? "" : "File changes · ")
          + value.changes.map(\.path).joined(separator: ", ")
    case .tool(let value):
      [value.namespace, toolName ?? "Tool"].compactMap { $0 }.joined(separator: ".")
    case .agentCoordination(let value):
      value.activityTitle(status: status)
    case .agentActivity: "Agent activity"
    case .webSearch(let value): value.activityTitle(status: status)
    case .media(let value):
      switch value.operation {
      case .generate: "Image generation"
      case .view: "Image view"
      case .attachment: "Media attachment"
      }
    case .sleep: "Wait"
    case .plan: "Plan"
    case .review(let value): "Review \(value.stage.rawValue)"
    case .hookPrompt: "Historical hook prompt · inert"
    case .compaction: "Context compaction"
    case .unknown(let value): "Unknown history item · \(value.kind)"
    case .unavailable(let value): "Original unavailable · \(value.kind)"
    }
  }
}

extension MessagePresentationWebSearch {
  fileprivate func activityTitle(status: ToolStatus?) -> String {
    let title: String
    switch action {
    case .openPage:
      title = status == .finished ? "Read page" : status == .running ? "Reading page" : "Open page"
    case .findInPage:
      title =
        status == .finished
        ? "Searched page" : status == .running ? "Searching page" : "Search page"
    default:
      title =
        status == .finished ? "Searched web" : status == .running ? "Searching web" : "Web search"
    }
    return title + (query.isEmpty ? "" : " " + query)
  }
}

private struct ShellOutput: View {
  let text: String
  @ScaledMetric(relativeTo: .callout) private var lineHeight: CGFloat = 22

  private var visibleLines: Int {
    min(10, max(1, text.split(separator: "\n", omittingEmptySubsequences: false).count))
  }

  var body: some View {
    ScrollView([.horizontal, .vertical]) {
      Text(text).font(.system(.callout, design: .monospaced)).foregroundStyle(
        .primary.opacity(0.75)
      )
      .fixedSize(horizontal: true, vertical: true).textSelection(.enabled)
    }
    .frame(height: CGFloat(visibleLines) * lineHeight + 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .messageTextActions(text)
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
      .messageTextActions(text)
  }
}

struct ToolContent: View {
  let title: String
  let content: ToolDetailContent
  var name: String? = nil
  var preview: String? = nil

  var showsContent: Bool {
    guard let preview, !preview.isEmpty, case .text(let value) = content else { return true }
    return value.truncated || !value.text.utf8.elementsEqual(preview.utf8)
  }

  var body: some View {
    if showsContent {
      if name == "exec", let process = ProcessOutput.decode(content) {
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
        switch content {
        case .text(let value):
          ToolText(title: title, text: value.text)
          if value.truncated {
            Text("\(title) truncated.").font(.caption).foregroundStyle(.secondary)
          }
        case .unavailable(let value):
          Text("\(title): \(value.reason.description)").font(.caption).foregroundStyle(.secondary)
        }
      }
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
