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
  var rows: [RowModel] = [] {
    didSet { transcriptItems = TranscriptItem.grouped(rows, preserving: transcriptItems) }
  }
  private(set) var transcriptItems: [TranscriptItem] = []
  var connection: ConnectionState = .disconnected
  var model = "Main conversation"
  var commands: [SlashCommand] = []
  private(set) var settingsSupported = false
  private(set) var conversationSettings: NativeSettingsSnapshot?
  private(set) var settingsBusy = false
  var settingsError: String?
  @ObservationIgnored private var settingsRequest: UUID?
  var busy = false
  var canLoadEarlier = false
  var loadingHistory = false
  var includesLatest = true
  var sourceWarning: String?
  var sources: [SourceState] = []
  var error: String?
  var revision = 0
  var draft = "" {
    didSet {
      draftRevision &+= 1
      scheduleDraftSave()
    }
  }
  @ObservationIgnored private var draftRevision = 0
  var attachments: [LocalAttachment] = [] { didSet { scheduleDraftSave() } }
  var previewURL: URL?
  private(set) var preparingAttachments = false
  var mode: InputMode = .steer { didSet { scheduleDraftSave() } }
  private(set) var draftReady: Bool
  private(set) var pendingSharedImport = false
  var draftError: String?
  @ObservationIgnored private let persistence: ComposerDraftStore?
  @ObservationIgnored private let sharedInbox: SharedDraftInbox?
  @ObservationIgnored private var persistentRevision: UInt64 = 0
  @ObservationIgnored private var consumedTransfers: Set<UUID> = []
  @ObservationIgnored private var changingDraft = false
  @ObservationIgnored private var restoringDraft = false
  private(set) var admitting = false
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var admit:
    @Sendable (String, InputMode, [LocalAttachment]) async -> Bool
  @ObservationIgnored private var draftStore: AttachmentStore?
  @ObservationIgnored private var feedbackScreenshotID: String? { didSet { scheduleDraftSave() } }

  init(
    draftStore: AttachmentStore? = nil, persistence: ComposerDraftStore? = nil,
    sharedInbox: SharedDraftInbox? = nil,
    admit: @escaping @Sendable (String, InputMode, [LocalAttachment]) async -> Bool = { _, _, _ in
      false
    }
  ) {
    self.draftStore = draftStore
    self.persistence = persistence
    self.sharedInbox = sharedInbox
    draftReady = persistence == nil
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

  private var currentDraft: ComposerDraft {
    ComposerDraft(
      text: draft, mode: mode, attachments: attachments, consumedTransfers: consumedTransfers,
      feedbackScreenshotID: feedbackScreenshotID)
  }
  private func scheduleDraftSave() {
    guard draftReady, !changingDraft, let persistence else { return }
    persistentRevision &+= 1
    let revision = persistentRevision
    let value = currentDraft
    Task { [weak self] in
      do { try await persistence.save(value, revision: revision) } catch {
        if self?.persistentRevision == revision { self?.draftError = error.localizedDescription }
      }
    }
  }
  private func persistDraft() async throws {
    guard let persistence else { return }
    guard draftReady else { throw SharedDraftError.busy }
    persistentRevision &+= 1
    try await persistence.save(currentDraft, revision: persistentRevision)
  }
  @discardableResult func saveDraft() async -> Bool {
    do {
      try await persistDraft()
      draftError = nil
      return true
    } catch {
      draftError = error.localizedDescription
      return false
    }
  }
  func restoreDraft() async {
    guard !draftReady, !restoringDraft, let persistence else { return }
    restoringDraft = true
    defer { restoringDraft = false }
    let revision = draftRevision
    do {
      let restored = try await persistence.load(from: attachmentStore())
      guard draftRevision == revision, draft.isEmpty, attachments.isEmpty else {
        throw AttachmentError.unavailable(
          "The saved draft was preserved. Clear the current composer before restoring it.")
      }
      changingDraft = true
      draft = restored.draft.text
      mode = restored.draft.mode
      attachments = restored.draft.attachments
      consumedTransfers = restored.draft.consumedTransfers
      feedbackScreenshotID = restored.draft.feedbackScreenshotID
      persistentRevision = restored.revision
      changingDraft = false
      draftReady = true
      pendingSharedImport = !consumedTransfers.isEmpty
      _ = await saveDraft()
      guard sharedInbox != nil || consumedTransfers.isEmpty else {
        throw SharedDraftError.notConfigured
      }
      await receiveSharedDrafts()
    } catch { draftError = error.localizedDescription }
  }
  func receiveSharedDrafts() async {
    guard draftReady, !preparingAttachments, !admitting, let sharedInbox, persistence != nil else {
      return
    }
    preparingAttachments = true
    defer { preparingAttachments = false }
    do {
      let store = try attachmentStore()
      try await retireAcknowledgedTransfers(in: sharedInbox)
      // One activation must not drain an unbounded queue or overfill the composer.
      for _ in 0..<AttachmentLimits.maximumCount {
        let consumed = try await sharedInbox.consumeNext(into: store) { [self] batch in
          try await adoptSharedDraft(batch)
        }
        guard consumed else { break }
        // Only acknowledged IDs may leave the durable host ledger. A crash
        // before this cleanup is harmless and is reconciled on next launch.
        try await retireAcknowledgedTransfers(in: sharedInbox)
      }
      draftError = nil
    } catch {
      if !(error is CancellationError) { draftError = error.localizedDescription }
    }
  }
  private func retireAcknowledgedTransfers(in inbox: SharedDraftInbox) async throws {
    let acknowledged = consumedTransfers.filter { inbox.acknowledged($0) }
    consumedTransfers.subtract(acknowledged)
    pendingSharedImport = !consumedTransfers.isEmpty
    if !acknowledged.isEmpty { try await persistDraft() }
  }
  private func adoptSharedDraft(_ batch: SharedDraftBatch) async throws {
    if !consumedTransfers.contains(batch.id) {
      guard batch.attachments.count <= AttachmentLimits.maximumCount - attachments.count else {
        throw AttachmentError.tooMany
      }
      changingDraft = true
      if !batch.note.isEmpty { draft += (draft.isEmpty ? "" : "\n\n") + batch.note }
      attachments.append(contentsOf: batch.attachments)
      consumedTransfers.insert(batch.id)
      changingDraft = false
    }
    pendingSharedImport = true
    // This complete atomic record, including the UUID, must reach disk before
    // SharedDraftInbox is allowed to acknowledge or delete the source batch.
    try await persistDraft()
  }
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
    settingsSupported = false
    conversationSettings = nil
    settingsRequest = nil
    settingsBusy = false
    settingsError = nil
    admit = { _, _, _ in false }
    await ownedSession?.disconnect()
  }
  func setActive(_ active: Bool) async {
    self.active = active
    guard let session, let address else { return }
    if active { await session.connect(address) } else { await session.disconnect() }
  }
  func connectNotifications(_ registration: NotificationRegistration) async {
    guard let session else { return }
    await registration.connect { request in try await session.notifications(request) }
  }
  var canSend: Bool {
    draftReady && !pendingSharedImport && !admitting && !preparingAttachments
      && connection == .connected
      && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
  }
  func send(screenshot: (@MainActor () throws -> Data)? = nil) async {
    guard canSend
    else { return }
    admitting = true
    defer { admitting = false }
    let text = draft
    let submittedDraftRevision = draftRevision
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
      // A later editor assignment can contain identical text. Clear only the
      // exact draft revision that was durably admitted.
      if draftRevision == submittedDraftRevision { draft = "" }
      let sentIDs = Set(files.map(\.id))
      attachments.removeAll { sentIDs.contains($0.id) }
      if let id = feedbackScreenshotID, sentIDs.contains(id) { feedbackScreenshotID = nil }
      if await saveDraft(), let store = draftStore {
        for file in files { try? await store.remove(file) }
      }
    }
  }
  func restore(_ id: String) async {
    guard draftReady else {
      draftError = draftError ?? "Restore the saved draft before replacing the composer."
      return
    }
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
    guard draftReady, !preparingAttachments else { return }
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
  func attach(providers: [NSItemProvider]) async {
    guard draftReady, !preparingAttachments else { return }
    preparingAttachments = true
    defer { preparingAttachments = false }
    var staged: [LocalAttachment] = []
    do {
      guard providers.count <= AttachmentLimits.maximumCount - attachments.count else {
        throw AttachmentError.tooMany
      }
      let images = try await ItemProviderImages.load(providers)
      let store = try attachmentStore()
      for image in images {
        try Task.checkCancellation()
        staged.append(
          try await store.stage(data: image.data, name: image.name, mediaType: image.mediaType))
      }
      try Task.checkCancellation()
      guard staged.count <= AttachmentLimits.maximumCount - attachments.count else {
        throw AttachmentError.tooMany
      }
      // Adopt the complete selection once. Neither the note nor existing files
      // belong to this import, including when a provider fails or is cancelled.
      attachments.append(contentsOf: staged)
    } catch {
      for file in staged { try? await draftStore?.remove(file) }
      if !(error is CancellationError) { self.error = error.localizedDescription }
    }
  }
  func attach(data: Data, name: String, mediaType: String) async {
    guard draftReady else { return }
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
      guard draftReady, !preparingAttachments else { return }
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
    guard !admitting, !preparingAttachments else { return }
    attachments.removeAll { $0.id == file.id }
    if feedbackScreenshotID == file.id { feedbackScreenshotID = nil }
    if await saveDraft() { try? await draftStore?.remove(file) }
  }
  func preview(_ reference: AttachmentRef) async {
    do { previewURL = try await session?.preview(reference) } catch {
      self.error = error.localizedDescription
    }
  }
  func refreshSettings(change: ConversationChange? = nil) async {
    guard !settingsBusy, settingsSupported, let session, connection == .connected else { return }
    let id = UUID()
    let generation = generation
    settingsRequest = id
    settingsBusy = true
    settingsError = nil
    defer {
      if settingsRequest == id {
        settingsRequest = nil
        settingsBusy = false
      }
    }
    do {
      let settings = try await session.settings(change: change)
      guard self.generation == generation, !Task.isCancelled else { return }
      conversationSettings = settings
    } catch {
      if self.generation == generation, !(error is CancellationError) {
        settingsError = error.localizedDescription
      }
    }
  }
  func retry(_ id: String) async { await session?.retry(id) }
  func toolDetails(for row: ChatRow) async throws -> ToolDetails {
    guard let entryID = row.entryID, let tool = row.tool, let session else {
      throw ConnectionError.closed
    }
    return try await session.toolDetails(entryID: entryID, callID: tool.callId)
  }
  func history(anchorID: String?) async { await session?.loadEarlier(anchorID: anchorID) }
  func latestHistory() async { await session?.loadLatest() }
  func interrupt() async { await session?.interrupt() }
  private func apply(_ update: ChatSnapshot) {
    let existing = Dictionary(
      rows.map { ($0.id, $0) }, uniquingKeysWith: { original, _ in original })
    let next = update.rows.map { row -> RowModel in
      if let model = existing[row.id] {
        if model.row != row { model.row = row }
        return model
      }
      return RowModel(row)
    }
    if rows.map(\.id) != next.map(\.id) {
      rows = next
    } else {
      transcriptItems = TranscriptItem.grouped(rows, preserving: transcriptItems)
    }
    revision &+= 1
    connection = update.connection
    model = update.model
    busy = update.busy
    commands = update.commands
    settingsSupported = update.settingsSupported
    conversationSettings = update.settings
    canLoadEarlier = update.olderCursor != nil
    loadingHistory = update.loadingHistory
    includesLatest = update.includesLatest
    sourceWarning = update.sourceWarning
    sources = update.sources
    error = update.error
  }
}
