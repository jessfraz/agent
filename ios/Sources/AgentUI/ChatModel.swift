import AgentCore
import CryptoKit
import Foundation
import Observation

@MainActor @Observable
final class RowModel: Identifiable {
  let id: String
  var row: ChatRow
  init(_ row: ChatRow) {
    id = row.id
    self.row = row
  }
}

@MainActor @Observable
final class ChatModel {
  var rows: [RowModel] = []
  var connection: ConnectionState = .disconnected
  var model = "Main conversation"
  var commands: [SlashCommand] = []
  var busy = false
  var canLoadEarlier = false
  var loadingHistory = false
  var error: String?
  var revision = 0
  var draft = ""
  var mode: InputMode = .steer
  private(set) var admitting = false
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var admit: @Sendable (String, InputMode) async -> Bool

  init(admit: @escaping @Sendable (String, InputMode) async -> Bool = { _, _ in false }) {
    self.admit = admit
  }
  deinit {
    observation?.cancel()
    let ownedSession = session
    Task { await ownedSession?.disconnect() }
  }
  @ObservationIgnored private var session: CoordinatorSession?
  @ObservationIgnored private var observation: Task<Void, Never>?
  @ObservationIgnored private var address: CoordinatorAddress?
  @ObservationIgnored private var active = true

  func connect(host: String, port: String) async {
    do {
      guard let port = UInt16(port) else { throw ConnectionError.invalidAddress }
      let address = try CoordinatorAddress(
        host: host.trimmingCharacters(in: .whitespacesAndNewlines), port: port)
      let generation = UUID()
      await stop(generation: generation)
      guard self.generation == generation, !Task.isCancelled else { return }
      self.address = address
      let key = SHA256.hash(data: Data("\(address.host):\(address.port)".utf8)).map {
        String(format: "%02x", $0)
      }.joined()
      let directory = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      let session = CoordinatorSession(
        outboxURL: directory.appending(path: "Agent/Outbox/\(key)/pending.json"))
      guard self.generation == generation else { return }
      await connect(session: session, address: address)
    } catch { self.error = error.localizedDescription }
  }
  func connect(session: CoordinatorSession, address: CoordinatorAddress) async {
    self.address = address
    self.session = session
    admit = { text, mode in await session.submit(text, mode: mode) }
    rows = []
    error = nil
    observation = Task { [weak self] in
      for await update in session.updates {
        guard !Task.isCancelled else { return }
        self?.apply(update)
      }
    }
    if active { await session.connect(address) }
  }
  func runUntilCancelled() async {
    let lifetime = AsyncStream<Void> { _ in }
    for await _ in lifetime {}
    await stop()
  }
  func stop() async { await stop(generation: UUID()) }
  private func stop(generation: UUID) async {
    self.generation = generation
    observation?.cancel()
    observation = nil
    let ownedSession = session
    session = nil
    connection = .disconnected
    admit = { _, _ in false }
    await ownedSession?.disconnect()
  }
  func setActive(_ active: Bool) async {
    self.active = active
    guard let session, let address else { return }
    if active { await session.connect(address) } else { await session.disconnect() }
  }
  func send() async {
    guard !admitting, connection == .connected,
      !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return }
    admitting = true
    defer { admitting = false }
    let text = draft
    // Keep the draft until the owned actor has validated and saved the input.
    // Failures also remain available in the input row for copy/retry.
    if await admit(text, mode), draft == text { draft = "" }
  }
  func restore(_ id: String) async {
    guard let text = await session?.restore(id) else { return }
    draft = text
  }
  func retry(_ id: String) async { await session?.retry(id) }
  func history() async { await session?.loadEarlier() }
  func interrupt() async { await session?.interrupt() }
  private func apply(_ update: ChatSnapshot) {
    let existing = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    let next = update.rows.map { row -> RowModel in
      if let model = existing[row.id] {
        if model.row != row { model.row = row }
        return model
      }
      return RowModel(row)
    }
    if rows.map(\.id) != next.map(\.id) { rows = next }
    revision &+= 1
    connection = update.connection
    model = update.model
    busy = update.busy
    commands = update.commands
    canLoadEarlier = update.olderCursor != nil
    loadingHistory = update.loadingHistory
    error = update.error
  }
}
