import Foundation

public enum Delivery: String, Sendable, Equatable {
  case sending = "Sending"
  case saved = "Saved"
  case uncertain = "Delivery unconfirmed"
  case rejected = "Needs attention"
}

public struct ChatRow: Identifiable, Sendable, Equatable {
  public let id: String
  public var entryID: String?
  public var role: HistoryRole
  public var blocks: [RichBlock]
  public var text: String
  public var tool: ToolHistory?
  public var delivery: Delivery?
  public var inputID: String?
  public var attachments: [AttachmentRef]

  init(
    id: String, entryID: String? = nil, role: HistoryRole, text: String, tool: ToolHistory? = nil,
    delivery: Delivery? = nil, inputID: String? = nil, attachments: [AttachmentRef] = []
  ) {
    self.id = id
    self.entryID = entryID
    self.role = role
    self.text = text
    blocks = []
    self.tool = tool
    self.delivery = delivery
    self.inputID = inputID
    self.attachments = attachments
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
    storage.append(row)
    dirtyRows.insert(row.id)
  }
  private struct Page: Sendable {
    var messages: [HistoryMessage] = []
    var bytes = 0
    var truncated = false
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
    finishResponse()
    thinkingID = nil
    storage.removeAll { $0.id.hasPrefix("thinking:") }
    dirtyRows = dirtyRows.filter { !$0.hasPrefix("thinking:") }
  }
  mutating func pending(_ request: NativeRequestSubmit, delivery: Delivery) {
    if let index = storage.firstIndex(where: { $0.inputID == request.inputId }) {
      storage[index].delivery = delivery
      return
    }
    append(
      ChatRow(
        id: "input:\(request.inputId)", role: .user, text: request.text, delivery: delivery,
        inputID: request.inputId, attachments: request.attachments ?? []))
    bound()
  }
  mutating func delivery(_ id: String, _ state: Delivery, entryID: String? = nil) {
    guard let index = storage.firstIndex(where: { $0.inputID == id }) else { return }
    storage[index].delivery = state
    if let entryID {
      storage[index].entryID = entryID
      storage[index].delivery = nil
      storage.removeAll { $0.entryID == entryID && $0.inputID != id }
    }
  }
  mutating func abandonHistory(_ requestID: UUID) { pages.removeValue(forKey: requestID) }
  mutating func history(
    _ frame: NativeEventHistory, olderPage: Bool = false, requestID: UUID? = nil
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
      if olderPage, let current = storage.first(where: { $0.id == row.id }) { return current }
      return row
    }
    let incomingIDs = Set(incoming.map(\.id))
    storage.removeAll { loadedIDs.contains($0.entryID ?? "") || incomingIDs.contains($0.id) }
    if olderPage {
      storage.insert(contentsOf: incoming, at: 0)
    } else {
      let unsaved = storage.filter { $0.inputID != nil && $0.entryID == nil }
      storage.removeAll { $0.inputID != nil && $0.entryID == nil }
      storage.append(contentsOf: incoming)
      storage.append(contentsOf: unsaved)
    }
    for (id, count) in loaded.segmentCounts {
      segmentCounts[id] = max(segmentCounts[id] ?? 0, count)
    }
    bound(olderPage: olderPage)
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
    if !historical && historicalEntries.contains(message.entryId) { return }
    if message.role == .user,
      storage.contains(where: { $0.entryID == message.entryId && $0.inputID != nil })
    {
      return
    }
    if let tool = message.tool {
      let id = "tool:\(tool.callId)"
      if let index = storage.firstIndex(where: { $0.id == id }) {
        storage[index].tool = tool
        storage[index].entryID = message.entryId
        return
      }
      append(
        ChatRow(id: id, entryID: message.entryId, role: .tool, text: tool.name, tool: tool))
    } else if message.continuation,
      let index = storage.lastIndex(where: {
        $0.entryID == message.entryId && $0.role == message.role
      }
      )
    {
      storage[index].text = boundedText(storage[index].text + message.text)
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
          text: boundedText(message.text), attachments: message.attachments ?? []))
    }
    if !historical { bound() }
  }
  mutating func answer(_ answer: NativeEventAnswer) {
    finishResponse()
    guard !answer.text.isEmpty else { return }
    if let id = answer.entryId, storage.contains(where: { $0.entryID == id }) { return }
    append(
      ChatRow(
        id: "entry:\(answer.entryId ?? UUID().uuidString):0", entryID: answer.entryId, role: .final,
        text: boundedText(answer.text)))
    thinkingID = nil
    bound()
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
        storage[index].tool = info
      } else {
        append(ChatRow(id: "tool:\(tool.callId)", role: .tool, text: tool.name, tool: info))
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
  private mutating func bound(olderPage: Bool = false) {
    textBytes = storage.reduce(0) { $0 + $1.text.utf8.count }
    while storage.count > Self.maximumRows || textBytes > Self.maximumTextBytes {
      let candidates = storage.indices.filter { storage[$0].delivery == nil }
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
