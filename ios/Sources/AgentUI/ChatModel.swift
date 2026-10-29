import AgentCore
import CryptoKit
import Foundation
import Observation

#if os(iOS)
  import PhotosUI
  import SwiftUI
#endif

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
  var attachments: [LocalAttachment] = []
  var previewURL: URL?
  private(set) var preparingAttachments = false
  var mode: InputMode = .steer
  private(set) var admitting = false
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var admit:
    @Sendable (String, InputMode, [LocalAttachment]) async -> Bool
  @ObservationIgnored private var draftStore: AttachmentStore?
  @ObservationIgnored private var feedbackScreenshotID: String?

  init(
    draftStore: AttachmentStore? = nil,
    admit: @escaping @Sendable (String, InputMode, [LocalAttachment]) async -> Bool = { _, _, _ in
      false
    }
  ) {
    self.draftStore = draftStore
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
    admit = { text, mode, files in await session.submit(text, mode: mode, files: files) }
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
    admit = { _, _, _ in false }
    await ownedSession?.disconnect()
  }
  func setActive(_ active: Bool) async {
    self.active = active
    guard let session, let address else { return }
    if active { await session.connect(address) } else { await session.disconnect() }
  }
  var canSend: Bool {
    !admitting && !preparingAttachments && connection == .connected
      && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
  }
  func send(screenshot: (@MainActor () throws -> Data)? = nil) async {
    guard canSend
    else { return }
    admitting = true
    defer { admitting = false }
    let text = draft
    let mode = mode
    let generation = generation
    let admit = admit
    var files = attachments
    do {
      if text.split(whereSeparator: \.isWhitespace).first == "/feedback",
        feedbackScreenshotID == nil, let screenshot
      {
        guard files.count < AttachmentLimits.maximumCount else { throw AttachmentError.tooMany }
        // Capture before the composer changes. A failed admission retains this exact image.
        let data = try screenshot()
        let file = try await attachmentStore().stage(
          data: data, name: "Feedback.png", mediaType: "image/png")
        guard self.generation == generation else {
          try? await draftStore?.remove(file)
          return
        }
        attachments.append(file)
        files.append(file)
        feedbackScreenshotID = file.id
      }
    } catch {
      self.error = error.localizedDescription
      return
    }
    guard self.generation == generation else { return }
    // Keep the draft until the owned actor has validated and saved the input.
    // Failures also remain available in the input row for copy/retry.
    if await admit(text, mode, files), self.generation == generation {
      if draft == text { draft = "" }
      let sentIDs = Set(files.map(\.id))
      attachments.removeAll { sentIDs.contains($0.id) }
      if let id = feedbackScreenshotID, sentIDs.contains(id) { feedbackScreenshotID = nil }
      if let store = draftStore {
        for file in files { try? await store.remove(file) }
      }
    }
  }
  func restore(_ id: String) async {
    guard !admitting, draft.isEmpty, attachments.isEmpty else {
      error = "Send or clear the current draft before restoring another message."
      return
    }
    do {
      let store = try attachmentStore()
      guard let restored = await session?.restore(id, to: store) else { return }
      draft = restored.text + (draft.isEmpty ? "" : "\n\n" + draft)
      attachments.insert(contentsOf: restored.attachments, at: 0)
      mode = restored.mode
      if restored.text.split(whereSeparator: \.isWhitespace).first == "/feedback" {
        feedbackScreenshotID =
          restored.attachments.last(where: { $0.reference.name == "Feedback.png" })?.id
      }
    } catch { self.error = error.localizedDescription }
  }
  private func attachmentStore() throws -> AttachmentStore {
    if let draftStore { return draftStore }
    let directory = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let store = AttachmentStore(directory: directory.appending(path: "Agent/Drafts"))
    draftStore = store
    return store
  }
  func attach(urls: [URL]) async {
    guard !preparingAttachments else { return }
    preparingAttachments = true
    defer { preparingAttachments = false }
    do {
      let store = try attachmentStore()
      for url in urls {
        guard attachments.count < AttachmentLimits.maximumCount else {
          throw AttachmentError.tooMany
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        attachments.append(try await store.stage(url: url))
      }
    } catch { self.error = error.localizedDescription }
  }
  func attach(data: Data, name: String, mediaType: String) async {
    do {
      guard attachments.count < AttachmentLimits.maximumCount else { throw AttachmentError.tooMany }
      let file = try await attachmentStore().stage(data: data, name: name, mediaType: mediaType)
      guard attachments.count < AttachmentLimits.maximumCount else {
        try? await draftStore?.remove(file)
        throw AttachmentError.tooMany
      }
      attachments.append(file)
    } catch { self.error = error.localizedDescription }
  }
  #if os(iOS)
    func attach(photo: PhotosPickerItem) async {
      guard !preparingAttachments else { return }
      preparingAttachments = true
      defer { preparingAttachments = false }
      do {
        guard let image = try await photo.loadTransferable(type: ImportedPhoto.self) else {
          throw AttachmentError.invalidFile
        }
        await attach(data: image.data, name: "Photo.jpg", mediaType: "image/jpeg")
      } catch { self.error = error.localizedDescription }
    }
  #endif
  func removeAttachment(_ file: LocalAttachment) async {
    guard !admitting else { return }
    attachments.removeAll { $0.id == file.id }
    if feedbackScreenshotID == file.id { feedbackScreenshotID = nil }
    try? await draftStore?.remove(file)
  }
  func preview(_ reference: AttachmentRef) async {
    do { previewURL = try await session?.preview(reference) } catch {
      self.error = error.localizedDescription
    }
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
