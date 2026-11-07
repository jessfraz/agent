import Foundation
import OSLog
import UniformTypeIdentifiers

public struct SharedDraftContent: Sendable {
  public let note: String
  public let attachments: [LocalAttachment]
  public init(note: String, attachments: [LocalAttachment]) {
    self.note = note
    self.attachments = attachments
  }
}

/// Copies each selected representation before its provider's callback ends.
/// The caller owns this temporary store until the durable inbox accepts it.
public enum SharedDraftImport {
  @MainActor public static func load(
    _ items: [NSExtensionItem], into store: AttachmentStore
  ) async throws -> SharedDraftContent {
    let providers = items.flatMap { $0.attachments ?? [] }
    #if DEBUG
      let types = providers.flatMap(\.registeredTypeIdentifiers).joined(separator: ",")
      Logger(subsystem: "dev.beep-boop", category: "ShareImport").debug(
        "Preparing share: text items \(items.filter { $0.attributedContentText != nil }.count), types \(types.prefix(1024), privacy: .public)"
      )
    #endif
    guard providers.count <= AttachmentLimits.maximumCount else { throw AttachmentError.tooMany }
    var notes: [String] = []
    var files: [LocalAttachment] = []
    func append(_ text: String) throws {
      guard !text.isEmpty, !notes.contains(text) else { return }
      guard text.utf8.count + notes.reduce(0, { $0 + $1.utf8.count + 2 }) <= 64 * 1024 else {
        throw SharedDraftError.invalidBatch
      }
      notes.append(text)
    }
    do {
      for item in items {
        if let text = item.attributedContentText?.string { try append(text) }
        for provider in item.attachments ?? [] {
          try Task.checkCancellation()
          if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            for image in try await ItemProviderImages.load([provider]) {
              files.append(
                try await store.stage(
                  data: image.data, name: image.name, mediaType: image.mediaType))
            }
          } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            let file = try await ItemProviderLoad<ImportedFile>.read { load in
              provider.loadObject(ofClass: URL.self) { value, error in
                guard !load.isCancelled else { return }
                do {
                  guard error == nil, let value else { throw AttachmentError.invalidFile }
                  load.finish(.success(try readFile(value)))
                } catch { load.finish(.failure(error)) }
              }
            }
            files.append(
              try await store.stage(data: file.data, name: file.name, mediaType: file.type))
          } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            try append(try await readText(provider, type: UTType.url.identifier))
          } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            let type =
              provider.registeredTypeIdentifiers.first {
                UTType($0)?.conforms(to: .plainText) == true
              } ?? UTType.plainText.identifier
            try append(try await readText(provider, type: type))
          } else if let type = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .data) == true
          }) {
            let file = try await ItemProviderLoad<ImportedFile>.read { load in
              provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                guard !load.isCancelled else { return }
                do {
                  guard error == nil, let url else { throw AttachmentError.invalidFile }
                  load.finish(.success(try readFile(url)))
                } catch { load.finish(.failure(error)) }
              }
            }
            files.append(
              try await store.stage(data: file.data, name: file.name, mediaType: file.type))
          } else {
            throw AttachmentError.invalidFile
          }
        }
      }
      try Task.checkCancellation()
      return SharedDraftContent(note: notes.joined(separator: "\n\n"), attachments: files)
    } catch {
      let failure = error as NSError
      Logger(subsystem: "dev.beep-boop", category: "ShareImport").error(
        "Shared-item import failed: \(failure.domain, privacy: .public) code \(failure.code)")
      for file in files { try? await store.remove(file) }
      throw error
    }
  }

  private struct ImportedFile: Sendable {
    let data: Data
    let name: String
    let type: String
  }

  @MainActor private static func readText(_ provider: NSItemProvider, type: String) async throws
    -> String
  {
    try await ItemProviderLoad<String>.read { load in
      // ShareLink and other Transferable writers supply data representations;
      // they need not implement NSString/NSURL object decoding across processes.
      provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
        guard !load.isCancelled else { return }
        do {
          guard error == nil, let data, data.count <= 64 * 1024 else {
            throw AttachmentError.invalidFile
          }
          let text: String?
          if data.starts(with: Data("bplist00".utf8)) {
            if UTType(type)?.conforms(to: .url) == true,
              try PropertyListSerialization.propertyList(from: data, format: nil) is NSArray
            {
              // NSURL owns its provider array format, including relative URLs.
              text = try NSURL.object(withItemProviderData: data, typeIdentifier: type)
                .absoluteString
            } else {
              // Foundation's cross-process provider bridge may archive its
              // string/URL. Decode only those classes, never arbitrary objects.
              let value = try NSKeyedUnarchiver.unarchivedObject(
                ofClasses: [NSString.self, NSURL.self], from: data)
              text = (value as? String) ?? (value as? URL)?.absoluteString
            }
          } else {
            text = String(
              data: data,
              encoding: UTType(type)?.conforms(to: .utf16PlainText) == true ? .utf16 : .utf8)
          }
          guard let text else { throw AttachmentError.invalidFile }
          load.finish(.success(text))
        } catch {
          let failure = error as NSError?
          Logger(subsystem: "dev.beep-boop", category: "ShareImport").error(
            "Shared text representation \(type, privacy: .public): \(data?.count ?? 0) bytes, error \(failure?.domain ?? "none", privacy: .public) code \(failure?.code ?? 0)"
          )
          load.finish(.failure(error))
        }
      }
    }
  }

  private static func readFile(_ url: URL) throws -> ImportedFile {
    guard url.isFileURL else { throw AttachmentError.invalidFile }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true else { throw AttachmentError.invalidFile }
    guard (values.fileSize ?? Int.max) <= AttachmentLimits.maximumBytes else {
      throw AttachmentError.tooLarge
    }
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    let data = try file.read(upToCount: AttachmentLimits.maximumBytes + 1) ?? Data()
    guard data.count <= AttachmentLimits.maximumBytes else { throw AttachmentError.tooLarge }
    return ImportedFile(
      data: data, name: url.lastPathComponent,
      type: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        ?? "application/octet-stream")
  }
}
