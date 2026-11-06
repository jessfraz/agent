import Darwin
import Foundation

private enum ComposerDraftError: Error, LocalizedError {
  case invalidRecord, tooLarge, staleOwner
  var errorDescription: String? {
    switch self {
    case .invalidRecord: "The saved unsent draft could not be verified. It was preserved."
    case .tooLarge: "The unsent draft is too large to save. Shorten its text before retrying."
    case .staleOwner:
      "A newer unsent draft was saved by another owner. Reopen the composer before editing the saved draft."
    }
  }
}

public struct ComposerDraft: Sendable, Equatable {
  public var text: String
  public var mode: InputMode
  public var attachments: [LocalAttachment]
  public var consumedTransfers: Set<UUID>
  public var feedbackScreenshotID: String?
  public init(
    text: String = "", mode: InputMode = .steer, attachments: [LocalAttachment] = [],
    consumedTransfers: Set<UUID> = [], feedbackScreenshotID: String? = nil
  ) {
    self.text = text
    self.mode = mode
    self.attachments = attachments
    self.consumedTransfers = consumedTransfers
    self.feedbackScreenshotID = feedbackScreenshotID
  }
}

/// One atomic record owns the unsent note, file references and transfer UUIDs.
/// A queued save of an older editor revision may never overwrite a newer save.
/// Each composer owner uses its own store instance.
public actor ComposerDraftStore {
  private struct Record: Codable {
    let revision: UInt64
    let text: String
    let mode: InputMode
    let attachments: [AttachmentRef]
    let consumedTransfers: Set<UUID>
    let feedbackScreenshotID: String?
  }
  private static let maximumRecordBytes = 512 * 1024
  private let url: URL
  private var savedRevision: UInt64?
  private var savedData: Data?
  private var needsSynchronization = false
  public init(url: URL) { self.url = url }

  public func load(from store: AttachmentStore) async throws -> (
    draft: ComposerDraft, revision: UInt64
  ) {
    guard let data = try contents() else { return (ComposerDraft(), 0) }
    let record = try JSONDecoder().decode(Record.self, from: data)
    guard record.attachments.count <= AttachmentLimits.maximumCount,
      Set(record.attachments.map(\.id)).count == record.attachments.count,
      record.feedbackScreenshotID.map({ id in record.attachments.contains { $0.id == id } }) ?? true
    else { throw ComposerDraftError.invalidRecord }
    var files: [LocalAttachment] = []
    for reference in record.attachments {
      guard let file = try await store.existing(reference) else { throw AttachmentError.changed }
      files.append(file)
    }
    // Rehydration awaits another actor. Do not adopt an older record if a
    // different owner changed the metadata while its files were verified.
    guard try contents() == data else { throw ComposerDraftError.staleOwner }
    savedData = data
    savedRevision = max(savedRevision ?? record.revision, record.revision)
    return (
      ComposerDraft(
        text: record.text, mode: record.mode, attachments: files,
        consumedTransfers: record.consumedTransfers,
        feedbackScreenshotID: record.feedbackScreenshotID), record.revision
    )
  }

  /// Returns false only when a newer complete record already owns the disk.
  @discardableResult public func save(_ draft: ComposerDraft, revision: UInt64) throws -> Bool {
    guard draft.attachments.count <= AttachmentLimits.maximumCount else {
      throw AttachmentError.tooMany
    }
    guard Set(draft.attachments.map(\.id)).count == draft.attachments.count,
      draft.feedbackScreenshotID.map({ id in draft.attachments.contains { $0.id == id } }) ?? true
    else { throw ComposerDraftError.invalidRecord }
    let record = Record(
      revision: revision, text: draft.text, mode: draft.mode,
      attachments: draft.attachments.map(\.reference), consumedTransfers: draft.consumedTransfers,
      feedbackScreenshotID: draft.feedbackScreenshotID)
    let data = try JSONEncoder().encode(record)
    guard data.count <= Self.maximumRecordBytes else { throw ComposerDraftError.tooLarge }
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    // Different scenes may have different store instances. Refuse stale owners
    // rather than silently overwriting another scene's unsent draft.
    let lockFD = open(url.appendingPathExtension("lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard lockFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(lockFD) }
    guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw SharedDraftError.busy }
    guard try contents() == savedData else {
      throw ComposerDraftError.staleOwner
    }
    if let savedRevision, revision < savedRevision {
      if needsSynchronization { try synchronize(directory) }
      return false
    }
    #if os(iOS)
      try data.write(to: url, options: [.atomic, .completeFileProtection])
    #else
      try data.write(to: url, options: .atomic)
    #endif
    // The atomic rename has happened even if a later protection/fsync step fails.
    // Remember ownership and the newer record so an older queued save cannot
    // roll it back, and a retry can finish durability before acknowledging a share.
    savedRevision = revision
    savedData = data
    needsSynchronization = true
    try synchronize(directory)
    return true
  }

  private func synchronize(_ directory: URL) throws {
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    var ownedURL = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try ownedURL.setResourceValues(values)
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    try file.synchronize()
    let fd = open(directory.path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    needsSynchronization = false
  }

  private func contents() throws -> Data? {
    do {
      let file = try FileHandle(forReadingFrom: url)
      defer { try? file.close() }
      let data = try file.read(upToCount: Self.maximumRecordBytes + 1) ?? Data()
      guard data.count <= Self.maximumRecordBytes else { throw ComposerDraftError.invalidRecord }
      return data
    } catch let error as CocoaError
      where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile
    { return nil }
  }

}
