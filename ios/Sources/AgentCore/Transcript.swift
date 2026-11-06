import Foundation

public enum Delivery: String, Sendable, Equatable {
  case sending = "Sending"
  // A coordinator receipt, never merely a local outbox write.
  case saved = "Sent"
  case uncertain = "Delivery unconfirmed"
  case rejected = "Needs attention"
}

public struct ChatRow: Identifiable, Sendable, Equatable {
  public let id: String
  public var entryID: String?
  // Coalesced tools retain their original causal position for ordering.
  fileprivate var positionID: NativeEntryID?
  public var role: HistoryRole
  public var blocks: [RichBlock]
  public var text: String
  public var tool: ToolHistory?
  public var presentation: MessagePresentation?
  public var delivery: Delivery?
  public var work: InputWorkState?
  public var inputID: String?
  public var attachments: [AttachmentRef]
  public var inputOrigin: InputOrigin?
  public var noticeOrigin: NoticeOrigin?

  public var provenanceLabel: String? {
    if role == .user { return inputOrigin.map { $0 == .ios ? "iOS" : "CLI" } }
    if role == .notice, let noticeOrigin { return "Job: \(noticeOrigin.title)" }
    return nil
  }

  init(
    id: String, entryID: String? = nil, role: HistoryRole, text: String, tool: ToolHistory? = nil,
    presentation: MessagePresentation? = nil, delivery: Delivery? = nil,
    work: InputWorkState? = nil,
    inputID: String? = nil,
    attachments: [AttachmentRef] = [], inputOrigin: InputOrigin? = nil,
    noticeOrigin: NoticeOrigin? = nil
  ) {
    self.id = id
    self.entryID = entryID
    positionID = entryID.flatMap(NativeEntryID.init)
    self.role = role
    self.text = text
    blocks = []
    self.tool = tool
    self.presentation = presentation
    self.delivery = delivery ?? (role == .user && entryID != nil ? .saved : nil)
    self.work = work
    self.inputID = inputID
    self.attachments = attachments
    self.inputOrigin = inputOrigin
    self.noticeOrigin = noticeOrigin
  }
}

struct Transcript: Sendable {
  private var storage: [ChatRow] = []
  private var dirtyRows: Set<String> = []

  // The actor's existing publication cadence reads this snapshot. Prepare each
  // changed row once, using its complete current text, before it becomes public.
  var rows: [ChatRow] {
    mutating get {
      let indexes = dirtyRows.compactMap { id in storage.firstIndex { $0.id == id } }
      let blocks = RichText.prepare(indexes.map { storage[$0].text })
      for (index, value) in zip(indexes, blocks) {
        storage[index].blocks = value
      }
      dirtyRows.removeAll(keepingCapacity: true)
      return storage
    }
  }

  private mutating func append(_ row: ChatRow) {
    if let position = row.positionID,
      let index = storage.firstIndex(where: { $0.positionID.map { $0 > position } ?? false })
    {
      storage.insert(row, at: index)
    } else {
      storage.append(row)
    }
    dirtyRows.insert(row.id)
  }
  private struct Page: Sendable {
    var messages: [HistoryMessage] = []
    var bytes = 0
    var truncated = false
    var replacedRows: [String: ChatRow]?
  }
  // nil is the observer; action UUIDs own their independent chunk streams.
  private var pages: [UUID?: Page] = [:]
  private var historicalEntries: Set<String> = []
  private var segmentCounts: [String: Int] = [:]
  private var thinkingID: String?
  private var responseID: String?
  private var textBytes = 0
  static let maximumRows = 500
  static let maximumTextBytes = 4 * 1024 * 1024
  static let maximumRowCharacters = 131072

  mutating func reconnect() {
    pages.removeValue(forKey: nil)
    // Delivery receipts survive reconnect. Execution badges require a fresh
    // coordinator report, including when an older server omits work metadata.
    for index in storage.indices where storage[index].inputID != nil {
      storage[index].work = nil
    }
    finishResponse()
    thinkingID = nil
    storage.removeAll { $0.id.hasPrefix("thinking:") }
    dirtyRows = dirtyRows.filter { !$0.hasPrefix("thinking:") }
  }
  mutating func pending(_ request: NativeRequestSubmit, delivery: Delivery) {
    if storage.contains(where: { $0.inputID == request.inputId }) {
      self.delivery(request.inputId, delivery)
      return
    }
    append(
      ChatRow(
        id: "input:\(request.inputId)", role: .user, text: request.text, delivery: delivery,
        inputID: request.inputId, attachments: request.attachments ?? [],
        inputOrigin: request.origin))
    bound()
  }
  mutating func delivery(_ id: String, _ state: Delivery, entryID: String? = nil) {
    guard let index = storage.firstIndex(where: { $0.inputID == id }) else { return }
    if entryID == nil {
      // A socket closing is not a new receipt. Foreground reconciliation must
      // not discard known acceptance/rejection or regress confirmed placement.
      guard storage[index].entryID == nil else { return }
      if state == .uncertain,
        storage[index].delivery == .saved || storage[index].delivery == .rejected
      {
        return
      }
    }
    storage[index].delivery = state
    if let entryID {
      storage[index].entryID = entryID
      storage[index].positionID = NativeEntryID(entryID)
      storage[index].delivery = .saved
      if let canonical = storage.firstIndex(where: {
        $0.entryID == entryID && $0.inputID != id && $0.role == .user
      }) {
        if historicalEntries.contains(entryID) || storage[index].positionID != nil {
          // Canonical history, or a native-ID-ordered live echo, already owns
          // the position. Do not keep an optimistic row below its replies.
          let canonicalID = storage[canonical].id
          let placed = storage[index]
          storage = storage.compactMap { row in
            if row.inputID == id { return nil }
            return row.id == canonicalID ? placed : row
          }
        } else {
          // A late live echo has no authoritative history position. Keep the
          // optimistic row's position and remove just its duplicate block.
          storage.remove(at: canonical)
        }
      } else if storage[index].positionID != nil {
        // The user block may be outside the received history window. Its
        // acknowledged native ID still places it before later native replies.
        append(storage.remove(at: index))
      }
    }
  }
  mutating func work(_ id: String, _ state: InputWorkState?) {
    guard let index = storage.firstIndex(where: { $0.inputID == id }) else { return }
    storage[index].work = state
  }
  mutating func abandonHistory(_ requestID: UUID) { pages.removeValue(forKey: requestID) }
  mutating func beginLatestHistory(_ requestID: UUID) {
    // Keep live output and pending inputs that arrive during a refresh. Only
    // the previous bounded window is replaced when the complete page arrives.
    pages[requestID] = Page(
      replacedRows: Dictionary(
        uniqueKeysWithValues:
          rows.filter {
            // Only unplaced local inputs survive independently of this window.
            ($0.entryID != nil || $0.delivery == nil)
              && $0.id != responseID && $0.id != thinkingID
          }.map { ($0.id, $0) }))
  }
  mutating func history(
    _ frame: NativeEventHistory, olderPage: Bool = false, requestID: UUID? = nil,
    preserving anchorID: String? = nil
  ) {
    var page = pages.removeValue(forKey: requestID) ?? Page()
    for message in frame.messages {
      page.messages.append(message)
      page.bytes += message.text.utf8.count
      while page.bytes > Self.maximumTextBytes || page.messages.count > Self.maximumRows {
        page.bytes -= page.messages.removeFirst().text.utf8.count
        page.truncated = true
      }
    }
    guard frame.pageComplete else {
      pages[requestID] = page
      return
    }
    var loaded = Transcript()
    for message in page.messages { loaded.message(message, historical: true) }
    let loadedIDs = Set(loaded.storage.compactMap(\.entryID))
    historicalEntries.formUnion(loadedIDs)
    dirtyRows.formUnion(loaded.dirtyRows)
    // Reuse a correlated input's stable row identity at its canonical position.
    // Multiple user blocks can belong to one entry; only one inherits the input ID.
    var correlatedInputs: Set<String> = []
    let incoming = loaded.storage.map { row in
      if row.role == .user,
        let input = storage.first(where: { $0.inputID != nil && $0.entryID == row.entryID }),
        correlatedInputs.insert(input.id).inserted
      {
        return input
      }
      // Calls and results have different entry IDs but share one tool row ID.
      // An older call must not replace its newer result or duplicate that row.
      if let current = storage.first(where: { $0.id == row.id }),
        let saved = current.tool, let incoming = row.tool
      {
        let preferIncoming =
          !staleTool(saved.status, incoming.status)
          && (!olderPage || current.entryID == nil || current.entryID == row.entryID
            || saved.status == .running || saved.status == .unknown)
        var merged = preferIncoming ? row : current
        if let saved = current.positionID, let incoming = row.positionID {
          merged.positionID = min(saved, incoming)
        } else {
          merged.positionID = current.positionID ?? row.positionID
        }
        merged.presentation = mergePresentation(
          current.presentation, row.presentation, preferIncoming: preferIncoming)
        return merged
      }
      if olderPage, let current = storage.first(where: { $0.id == row.id }) { return current }
      return row
    }
    let incomingIDs = Set(incoming.map(\.id))
    storage.removeAll {
      loadedIDs.contains($0.entryID ?? "") || incomingIDs.contains($0.id)
        || page.replacedRows?[$0.id] == $0
    }
    if olderPage {
      storage.insert(contentsOf: incoming, at: 0)
    } else {
      let unsaved = storage.filter { $0.inputID != nil && $0.entryID == nil }
      storage.removeAll { $0.inputID != nil && $0.entryID == nil }
      if page.replacedRows != nil {
        storage.insert(contentsOf: incoming, at: 0)
      } else {
        storage.append(contentsOf: incoming)
      }
      storage.append(contentsOf: unsaved)
    }
    for (id, count) in loaded.segmentCounts {
      segmentCounts[id] = max(segmentCounts[id] ?? 0, count)
    }
    bound(olderPage: olderPage, preserving: anchorID)
    if page.truncated {
      notice(
        "A large history page reached this device’s display limit. Full content remains on the coordinator."
      )
    }
  }
  mutating func response(_ text: String) {
    if let id = responseID, let index = storage.firstIndex(where: { $0.id == id }) {
      storage[index].text = boundedText(storage[index].text + text)
      dirtyRows.insert(id)
    } else {
      let id = "response:\(UUID().uuidString)"
      responseID = id
      append(ChatRow(id: id, role: .partialAnswer, text: boundedText(text)))
    }
    bound()
  }
  private mutating func finishResponse() {
    if let id = responseID {
      storage.removeAll { $0.id == id }
      dirtyRows.remove(id)
    }
    responseID = nil
  }
  mutating func message(_ message: HistoryMessage, historical: Bool = false) {
    if !historical && message.role == .commentary { finishResponse() }
    if !historical {
      let visible = hasVisibleAnswer(message.entryId)
      let repairsMissingAnswer =
        message.role.carriesAnswer
        && !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !visible
      if historicalEntries.contains(message.entryId) && !repairsMissingAnswer { return }
    }
    if message.role == .user,
      storage.contains(where: { $0.entryID == message.entryId && $0.inputID != nil })
    {
      return
    }
    if let tool = message.tool {
      let id = "tool:\(tool.callId)"
      if let index = storage.firstIndex(where: { $0.id == id }) {
        if let incoming = NativeEntryID(message.entryId),
          storage[index].positionID.map({ incoming < $0 }) ?? true
        {
          storage[index].positionID = incoming
        }
        let stale = storage[index].tool.map { staleTool($0.status, tool.status) } ?? false
        storage[index].presentation = mergePresentation(
          storage[index].presentation, message.presentation, preferIncoming: !stale)
        if !stale {
          let text =
            message.continuation && storage[index].entryID == message.entryId
            ? storage[index].text + message.text : message.text
          storage[index].text = boundedText(text)
          storage[index].tool = tool
          storage[index].entryID = message.entryId
          dirtyRows.insert(id)
        }
      } else {
        append(
          ChatRow(
            id: id, entryID: message.entryId, role: .tool, text: boundedText(message.text),
            tool: tool, presentation: message.presentation))
      }
    } else if message.continuation,
      let index = storage.lastIndex(where: {
        $0.entryID == message.entryId && $0.role == message.role
      }
      )
    {
      storage[index].text = boundedText(storage[index].text + message.text)
      storage[index].presentation = message.presentation ?? storage[index].presentation
      storage[index].noticeOrigin = message.noticeOrigin ?? storage[index].noticeOrigin
      dirtyRows.insert(storage[index].id)
      for attachment in message.attachments ?? []
      where !storage[index].attachments.contains(where: { $0.id == attachment.id }) {
        storage[index].attachments.append(attachment)
      }
    } else {
      let segment = segmentCounts[message.entryId, default: 0]
      segmentCounts[message.entryId] = segment + 1
      append(
        ChatRow(
          id: "entry:\(message.entryId):\(segment)", entryID: message.entryId, role: message.role,
          text: boundedText(message.text), presentation: message.presentation,
          attachments: message.attachments ?? [], noticeOrigin: message.noticeOrigin))
    }
    if !historical { bound() }
  }
  mutating func answer(_ answer: NativeEventAnswer) {
    finishResponse()
    guard !answer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    if let id = answer.entryId, hasVisibleAnswer(id) { return }
    let entry = answer.entryId ?? UUID().uuidString
    let segment = segmentCounts[entry, default: 0]
    if answer.entryId != nil {
      segmentCounts[entry] = segment + 1
    }
    append(
      ChatRow(
        id: "entry:\(entry):\(segment)", entryID: answer.entryId, role: .final,
        text: boundedText(answer.text)))
    thinkingID = nil
    bound()
  }
  private func hasVisibleAnswer(_ entryID: String) -> Bool {
    storage.contains {
      $0.entryID == entryID && $0.role.carriesAnswer
        && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
  mutating func activity(_ activity: ModelActivity) {
    switch activity {
    case .thinking(let value):
      if let id = thinkingID, let index = storage.firstIndex(where: { $0.id == id }) {
        storage[index].text = boundedText(storage[index].text + value.text)
        dirtyRows.insert(id)
      } else {
        let id = "thinking:\(UUID().uuidString)"
        thinkingID = id
        append(ChatRow(id: id, role: .thinking, text: boundedText(value.text)))
      }
    case .toolStarted(let tool):
      thinkingID = nil
      let info = ToolHistory(callId: tool.callId, name: tool.name, status: .running)
      if let index = storage.firstIndex(where: { $0.id == "tool:\(tool.callId)" }) {
        if !staleTool(storage[index].tool?.status ?? .unknown, .running) {
          storage[index].tool = info
        }
      } else {
        append(ChatRow(id: "tool:\(tool.callId)", role: .tool, text: "", tool: info))
      }
    case .toolFinished(let tool):
      if let index = storage.firstIndex(where: { $0.id == "tool:\(tool.callId)" }),
        storage[index].tool?.status == .running
      {
        storage[index].tool?.status = .finished
      }
    case .compaction(let value):
      let text =
        value.failed
        ? "Context compaction failed. Saved history is retained."
        : "Compacting conversation context…"
      storage.removeAll { $0.id == "compaction" }
      if value.active || value.failed {
        append(ChatRow(id: "compaction", role: .notice, text: text))
      }
    }
    bound()
  }
  mutating func notice(_ text: String, failure: Bool = false) {
    append(
      ChatRow(
        id: "notice:\(UUID().uuidString)", role: .notice,
        text: (failure ? "Error: " : "") + boundedText(text)))
    bound()
  }
  mutating func idle() {
    thinkingID = nil
    finishResponse()
  }
  private func boundedText(_ text: String) -> String {
    guard text.count > Self.maximumRowCharacters else { return text }
    return String(text.prefix(Self.maximumRowCharacters))
      + "\n\n[Display limit reached. Full content remains on the coordinator.]"
  }
  var lastReceivedRowID: String? {
    storage.last { $0.entryID != nil || $0.delivery == nil }?.id
  }
  private mutating func bound(olderPage: Bool = false, preserving anchorID: String? = nil) {
    textBytes = storage.reduce(0) { $0 + $1.text.utf8.count }
    while storage.count > Self.maximumRows || textBytes > Self.maximumTextBytes {
      let candidates = storage.indices.filter {
        (storage[$0].entryID != nil || storage[$0].delivery == nil)
          && storage[$0].id != anchorID
      }
      guard let index = olderPage ? candidates.last : candidates.first else { break }
      let removed = storage.remove(at: index)
      textBytes -= removed.text.utf8.count
      dirtyRows.remove(removed.id)
    }
    let retained = Set(storage.compactMap(\.entryID))
    historicalEntries.formIntersection(retained)
    segmentCounts = segmentCounts.filter { retained.contains($0.key) }
  }
}

private func staleTool(_ saved: ToolStatus, _ incoming: ToolStatus) -> Bool {
  (incoming == .running && saved != .running && saved != .unknown)
    || (incoming == .unknown && saved != .unknown)
    || ([ToolStatus.failed, .declined, .interrupted].contains(saved) && saved != incoming)
}

private func mergePresentation(
  _ saved: MessagePresentation?, _ incoming: MessagePresentation?, preferIncoming: Bool
) -> MessagePresentation? {
  switch (saved, incoming) {
  case (.command(let current), .command(let next)):
    let first = preferIncoming ? next : current
    let second = preferIncoming ? current : next
    return .command(
      .init(
        command: first.command ?? second.command, durationMs: first.durationMs ?? second.durationMs,
        exitCode: first.exitCode ?? second.exitCode))
  case (.fileChanges(let current), .fileChanges(let next)):
    let first = preferIncoming ? next : current
    let second = preferIncoming ? current : next
    return .fileChanges(first.changes.isEmpty ? second : first)
  case (.agentCoordination(let current), .agentCoordination(let next)):
    let first = preferIncoming ? next : current
    let second = preferIncoming ? current : next
    return .agentCoordination(
      .init(
        action: first.action ?? second.action,
        agents: first.agents.isEmpty ? second.agents : first.agents,
        receiverThreadIds: first.receiverThreadIds.isEmpty
          ? second.receiverThreadIds : first.receiverThreadIds,
        senderThreadId: first.senderThreadId ?? second.senderThreadId))
  default: return preferIncoming ? incoming ?? saved : saved ?? incoming
  }
}

// Only canonical, positive native sequence IDs carry ordering information.
// UUIDs, prefixed legacy IDs and malformed numbers keep arrival/history order.
private struct NativeEntryID: Sendable, Equatable, Comparable {
  let value: UInt64

  init?(_ raw: String) {
    guard let value = UInt64(raw), value > 0, String(value) == raw else { return nil }
    self.value = value
  }

  static func < (left: Self, right: Self) -> Bool { left.value < right.value }
}

extension HistoryRole {
  fileprivate var carriesAnswer: Bool {
    switch self {
    case .assistant, .final, .commentary: true
    case .thinking, .tool, .user, .notice, .partialAnswer: false
    }
  }
}
