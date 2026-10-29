import CryptoKit
import Foundation
import UniformTypeIdentifiers

public struct LocalAttachment: Identifiable, Sendable, Equatable {
  public let reference: AttachmentRef
  public let url: URL
  public var id: String { reference.id }
}

public enum AttachmentError: Error, LocalizedError, Sendable {
  case tooLarge, tooMany, invalidFile, changed, invalidResponse
  case unavailable(String)
  public var errorDescription: String? {
    switch self {
    case .tooLarge: "Attachments must be at most 16 MiB each."
    case .tooMany: "Attach at most 8 files per message."
    case .invalidFile: "Choose a regular file with a valid filename."
    case .changed: "The attachment changed or could not be verified. Attach it again."
    case .invalidResponse: "The coordinator did not confirm the attachment correctly."
    case .unavailable(let message): message
    }
  }
}

/// Immutable private copies keep file-picker access and later retries independent.
public actor AttachmentStore {
  private let directory: URL
  public init(directory: URL) { self.directory = directory }

  public func stage(url: URL) throws -> LocalAttachment {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true else { throw AttachmentError.invalidFile }
    guard (values.fileSize ?? Int.max) <= AttachmentLimits.maximumBytes else {
      throw AttachmentError.tooLarge
    }
    let input = try FileHandle(forReadingFrom: url)
    defer { try? input.close() }
    let type =
      UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
      ?? "application/octet-stream"
    return try write(name: url.lastPathComponent, mediaType: type) {
      try input.read(upToCount: AttachmentLimits.chunkBytes) ?? Data()
    }
  }

  public func stage(data: Data, name: String, mediaType: String) throws -> LocalAttachment {
    guard data.count <= AttachmentLimits.maximumBytes else { throw AttachmentError.tooLarge }
    var offset = 0
    return try write(name: name, mediaType: mediaType) {
      let end = min(offset + AttachmentLimits.chunkBytes, data.count)
      defer { offset = end }
      return data.subdata(in: offset..<end)
    }
  }

  func adopt(_ attachment: LocalAttachment) throws -> LocalAttachment {
    let target = try local(attachment.reference)
    if FileManager.default.fileExists(atPath: target.url.path) {
      try verify(target)
      return target
    }
    let input = try FileHandle(forReadingFrom: attachment.url)
    defer { try? input.close() }
    let saved = try write(
      name: attachment.reference.name, mediaType: attachment.reference.mediaType,
      id: attachment.id
    ) { try input.read(upToCount: AttachmentLimits.chunkBytes) ?? Data() }
    guard saved.reference == attachment.reference else {
      try? remove(saved)
      throw AttachmentError.changed
    }
    return saved
  }

  func duplicate(_ attachment: LocalAttachment) throws -> LocalAttachment {
    var reference = attachment.reference
    reference.id = UUID().uuidString
    return try adopt(LocalAttachment(reference: reference, url: attachment.url))
  }

  func local(_ reference: AttachmentRef) throws -> LocalAttachment {
    guard UUID(uuidString: reference.id) != nil, validName(reference.name),
      (0...AttachmentLimits.maximumBytes).contains(reference.sizeBytes)
    else { throw AttachmentError.invalidFile }
    return LocalAttachment(
      reference: reference,
      url: directory.appending(path: reference.id).appending(path: reference.name))
  }

  func existing(_ reference: AttachmentRef) throws -> LocalAttachment? {
    let file = try local(reference)
    guard FileManager.default.fileExists(atPath: file.url.path) else { return nil }
    try verify(file)
    return file
  }

  func receive(_ data: Data, reference: AttachmentRef) throws -> LocalAttachment {
    if let file = try existing(reference) { return file }
    var offset = 0
    let file = try write(name: reference.name, mediaType: reference.mediaType, id: reference.id) {
      let end = min(offset + AttachmentLimits.chunkBytes, data.count)
      defer { offset = end }
      return data.subdata(in: offset..<end)
    }
    guard file.reference == reference else {
      try? remove(file)
      throw AttachmentError.changed
    }
    return file
  }

  public func remove(_ attachment: LocalAttachment) throws {
    let owned = try local(attachment.reference)
    guard owned.url == attachment.url else { return }
    let folder = owned.url.deletingLastPathComponent()
    if FileManager.default.fileExists(atPath: folder.path) {
      try FileManager.default.removeItem(at: folder)
    }
  }

  private func validName(_ name: String) -> Bool {
    !name.isEmpty && name != "." && name != ".."
      && name.utf8.count <= AttachmentLimits.maximumNameBytes
      && !name.contains("/") && !name.contains("\\")
      && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
  }

  private func write(
    name: String, mediaType: String, id: String = UUID().uuidString,
    read: () throws -> Data
  ) throws -> LocalAttachment {
    guard validName(name), UUID(uuidString: id) != nil else { throw AttachmentError.invalidFile }
    let folder = directory.appending(path: id)
    try FileManager.default.createDirectory(
      at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var finished = false
    defer { if !finished { try? FileManager.default.removeItem(at: folder) } }
    var protectedFolder = folder
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try protectedFolder.setResourceValues(resources)
    let temporary = folder.appending(path: ".\(UUID().uuidString).partial")
    var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
    #if os(iOS)
      attributes[.protectionKey] = FileProtectionType.complete
    #endif
    guard
      FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: attributes)
    else { throw AttachmentError.invalidFile }
    defer { try? FileManager.default.removeItem(at: temporary) }
    let output = try FileHandle(forWritingTo: temporary)
    defer { try? output.close() }
    var digest = SHA256()
    var size = 0
    while true {
      let chunk = try read()
      if chunk.isEmpty { break }
      size += chunk.count
      guard size <= AttachmentLimits.maximumBytes else { throw AttachmentError.tooLarge }
      digest.update(data: chunk)
      try output.write(contentsOf: chunk)
    }
    try output.synchronize()
    let reference = AttachmentRef(
      id: id, mediaType: mediaType, name: name,
      sha256: digest.finalize().map { String(format: "%02x", $0) }.joined(), sizeBytes: size)
    let attachment = try local(reference)
    try FileManager.default.moveItem(at: temporary, to: attachment.url)
    finished = true
    return attachment
  }

  private func verify(_ attachment: LocalAttachment) throws {
    let input = try FileHandle(forReadingFrom: attachment.url)
    defer { try? input.close() }
    var size = 0
    var digest = SHA256()
    while let chunk = try input.read(upToCount: AttachmentLimits.chunkBytes), !chunk.isEmpty {
      size += chunk.count
      guard size <= attachment.reference.sizeBytes else { throw AttachmentError.changed }
      digest.update(data: chunk)
    }
    guard size == attachment.reference.sizeBytes,
      digest.finalize().map({ String(format: "%02x", $0) }).joined() == attachment.reference.sha256
    else { throw AttachmentError.changed }
  }
}
