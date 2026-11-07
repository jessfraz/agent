import Darwin
import Foundation

public enum SharedDraftError: Error, LocalizedError, Sendable {
  case notConfigured, busy, invalidBatch
  public var errorDescription: String? {
    switch self {
    case .notConfigured:
      "Sharing is not configured. Both app targets need the same provisioned App Group."
    case .busy: "Another draft import is in progress. Try again."
    case .invalidBatch: "The shared draft could not be verified. It has not been removed."
    }
  }
}

public struct SharedDraftBatch: Sendable {
  public let id: UUID
  public let note: String
  public let attachments: [LocalAttachment]
}

/// A local delivery queue, never a sender. The app must durably save the merged
/// unsent draft AND this batch ID in one transaction before `persist` returns.
/// On retry, an already-saved batch ID must not append its note or files again.
public struct SharedDraftInbox: Sendable {
  public static let configurationKey = "AgentAppGroupIdentifier"
  private static let maximumManifestBytes = 128 * 1024
  private let directory: URL

  public init(containerURL: URL) {
    directory = containerURL.appending(path: "SharedDraftInbox", directoryHint: .isDirectory)
  }

  public static func configured(bundle: Bundle = .main) throws -> SharedDraftInbox {
    guard let group = bundle.object(forInfoDictionaryKey: configurationKey) as? String,
      group.hasPrefix("group."), !group.contains("$("),
      let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw SharedDraftError.notConfigured }
    return SharedDraftInbox(containerURL: url)
  }

  /// A durable receipt allows the host to retire its own deduplication ledger entry.
  public func acknowledged(_ id: UUID) -> Bool {
    // Do not observe an in-flight receipt before its producer finishes syncing
    // it. A receipt left by a crashed consumer is made durable before the host
    // may retire its own UUID ledger entry.
    guard let lock = try? acquire() else { return false }
    defer { try? lock.close() }
    guard exists(receipt(id)) else { return false }
    do {
      try synchronize(directory.appending(path: "Receipts"))
      return true
    } catch { return false }
  }

  /// Reuse `id` only to retry this exact transfer, never to dedupe image content.
  /// A committed batch survives cancellation; cancel is checked before publication.
  @discardableResult public func enqueue(
    images: [ImportedImage], note: String = "", id: UUID = UUID()
  ) async throws -> UUID {
    try await enqueue(images.map { .image($0) }, note: note, id: id)
  }

  @discardableResult public func enqueue(
    attachments: [LocalAttachment], note: String = "", id: UUID = UUID()
  ) async throws -> UUID {
    try await enqueue(attachments.map { .file($0) }, note: note, id: id)
  }

  private enum Selection: Sendable {
    case image(ImportedImage)
    case file(LocalAttachment)
  }

  private func enqueue(_ selection: [Selection], note: String, id: UUID) async throws -> UUID {
    guard !selection.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw AttachmentError.invalidFile
    }
    guard selection.count <= AttachmentLimits.maximumCount else { throw AttachmentError.tooMany }
    guard note.utf8.count <= 64 * 1024 else { throw SharedDraftError.invalidBatch }
    try Task.checkCancellation()
    let lock = try acquire()
    defer { try? lock.close() }
    try recover()
    if exists(receipt(id)) { return id }
    let target = batchURL(id)
    if exists(target) {
      _ = try read(id)
      return id
    }
    let pending = directory.appending(path: "\(id.uuidString).partial", directoryHint: .isDirectory)
    try makeDirectory(pending)
    defer { try? FileManager.default.removeItem(at: pending) }
    let files = pending.appending(path: "Files")
    try makeDirectory(files)
    let store = AttachmentStore(directory: files)
    var references: [AttachmentRef] = []
    for item in selection {
      try Task.checkCancellation()
      let attachment: LocalAttachment
      switch item {
      case .image(let image):
        attachment = try await store.stage(
          data: image.data, name: image.name, mediaType: image.mediaType)
      case .file(let file): attachment = try await store.adopt(file)
      }
      references.append(attachment.reference)
      try synchronize(attachment.url.deletingLastPathComponent())
    }
    guard Set(references.map(\.id)).count == references.count else {
      throw SharedDraftError.invalidBatch
    }
    try synchronize(pending.appending(path: "Files"))
    let manifest = Manifest(id: id, created: Date(), note: note, attachments: references)
    let encoded = try JSONEncoder().encode(manifest)
    // Escaping can expand a valid note beyond the consumer's encoded-file budget.
    guard encoded.count <= Self.maximumManifestBytes else { throw SharedDraftError.invalidBatch }
    try write(encoded, to: pending.appending(path: "batch.json"))
    try synchronize(pending)
    try Task.checkCancellation()
    try FileManager.default.moveItem(at: pending, to: target)
    try synchronize(directory)
    return id
  }

  /// The kernel lock covers adoption, durable host persistence, then acknowledgement.
  /// No waiting thread, stale lease, or in-memory claim survives a process crash.
  /// A busy caller should retry on its next activation/import opportunity.
  /// If persistence throws, stable adopted copies remain for retry: the callback
  /// may have saved before failing. Only the host's durable draft owner can GC them.
  @discardableResult public func consumeNext(
    into store: AttachmentStore,
    persist: @Sendable (SharedDraftBatch) async throws -> Void
  ) async throws -> Bool {
    try Task.checkCancellation()
    let lock = try acquire()
    defer { try? lock.close() }
    try recover()
    let manifests = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil
    ).compactMap { url -> Manifest? in
      guard let id = UUID(uuidString: url.lastPathComponent) else { return nil }
      return try read(id)
    }.sorted {
      $0.created == $1.created ? $0.id.uuidString < $1.id.uuidString : $0.created < $1.created
    }
    guard let manifest = manifests.first else { return false }
    let source = AttachmentStore(directory: batchURL(manifest.id).appending(path: "Files"))
    // Verify every source before copying. The durable queue remains the owner on failure.
    var originals: [LocalAttachment] = []
    for reference in manifest.attachments {
      guard let attachment = try await source.existing(reference) else {
        throw SharedDraftError.invalidBatch
      }
      originals.append(attachment)
    }
    var adopted: [LocalAttachment] = []
    for original in originals {
      try Task.checkCancellation()
      adopted.append(try await store.adopt(original))
    }
    try Task.checkCancellation()
    try await persist(SharedDraftBatch(id: manifest.id, note: manifest.note, attachments: adopted))
    // Even cancellation after a successful durable save must finish acknowledgement.
    // A crash here replays the same IDs, so the host's saved batch ledger dedupes it.
    try write(Data(), to: receipt(manifest.id))
    try synchronize(directory.appending(path: "Receipts"))
    try FileManager.default.removeItem(at: batchURL(manifest.id))
    try synchronize(directory)
    return true
  }

  private struct Manifest: Codable {
    let id: UUID
    let created: Date
    let note: String
    let attachments: [AttachmentRef]
  }

  private func batchURL(_ id: UUID) -> URL { directory.appending(path: id.uuidString) }
  private func receipt(_ id: UUID) -> URL {
    directory.appending(path: "Receipts").appending(path: id.uuidString)
  }
  private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

  private func read(_ id: UUID) throws -> Manifest {
    let url = batchURL(id).appending(path: "batch.json")
    let input = try FileHandle(forReadingFrom: url)
    defer { try? input.close() }
    let data = try input.read(upToCount: Self.maximumManifestBytes + 1) ?? Data()
    guard data.count <= Self.maximumManifestBytes else { throw SharedDraftError.invalidBatch }
    let manifest = try JSONDecoder().decode(Manifest.self, from: data)
    guard manifest.id == id, manifest.note.utf8.count <= 64 * 1024,
      (0...AttachmentLimits.maximumCount).contains(manifest.attachments.count),
      !manifest.attachments.isEmpty
        || !manifest.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      Set(manifest.attachments.map(\.id)).count == manifest.attachments.count
    else { throw SharedDraftError.invalidBatch }
    return manifest
  }

  private func acquire() throws -> FileHandle {
    try makeDirectory(directory)
    try makeDirectory(directory.appending(path: "Receipts"))
    let fd = open(directory.appending(path: ".lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      let code = errno
      try? handle.close()
      if code == EWOULDBLOCK { throw SharedDraftError.busy }
      throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
    }
    return handle
  }

  private func recover() throws {
    // All producers/consumers hold the same lock. Only unpublished partials and
    // batches with durable acknowledgement receipts may be removed here.
    for url in try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    {
      if url.pathExtension == "partial",
        UUID(uuidString: url.deletingPathExtension().lastPathComponent) != nil
      {
        try FileManager.default.removeItem(at: url)
      } else if let id = UUID(uuidString: url.lastPathComponent), exists(receipt(id)) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }

  private func makeDirectory(_ url: URL) throws {
    var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
    #if os(iOS)
      attributes[.protectionKey] = FileProtectionType.complete
    #endif
    try FileManager.default.createDirectory(
      at: url, withIntermediateDirectories: true, attributes: attributes)
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  private func write(_ data: Data, to url: URL) throws {
    #if os(iOS)
      try data.write(to: url, options: [.atomic, .completeFileProtection])
    #else
      try data.write(to: url, options: .atomic)
    #endif
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let file = try FileHandle(forWritingTo: url)
    defer { try? file.close() }
    try file.synchronize()
  }

  private func synchronize(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  }
}
