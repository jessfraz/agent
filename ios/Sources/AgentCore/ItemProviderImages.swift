import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A bounded image prepared for the existing attachment pipeline, not a provider-owned URL.
public struct ImportedImage: Sendable {
  public let data: Data
  public let name = "Image.jpg"
  public let mediaType = "image/jpeg"
}

public enum ItemProviderImages {
  /// Only the supplied providers are read. One representation per selection is imported.
  /// Temporary URLs are read and normalized before NSItemProvider's callback returns.
  @MainActor public static func load(_ providers: [NSItemProvider]) async throws -> [ImportedImage]
  {
    guard !providers.isEmpty else { throw AttachmentError.invalidFile }
    guard providers.count <= AttachmentLimits.maximumCount else { throw AttachmentError.tooMany }
    var images: [ImportedImage] = []
    for provider in providers {
      try Task.checkCancellation()
      guard
        let type = provider.registeredTypeIdentifiers.first(where: {
          UTType($0)?.conforms(to: .image) == true
        })
      else { throw AttachmentError.invalidFile }
      let load = ImageProviderLoad()
      let image = try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          guard load.begin(continuation) else { return }
          let progress = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
            guard !load.isCancelled else { return }
            do {
              guard error == nil, let url else { throw AttachmentError.invalidFile }
              let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
              guard values.isRegularFile == true else { throw AttachmentError.invalidFile }
              guard (values.fileSize ?? Int.max) <= AttachmentLimits.maximumBytes else {
                throw AttachmentError.tooLarge
              }
              let input = try FileHandle(forReadingFrom: url)
              defer { try? input.close() }
              let data = try input.read(upToCount: AttachmentLimits.maximumBytes + 1) ?? Data()
              guard data.count <= AttachmentLimits.maximumBytes else {
                throw AttachmentError.tooLarge
              }
              load.finish(.success(try prepare(data)))
            } catch { load.finish(.failure(error)) }
          }
          load.setProgress(progress)
        }
      } onCancel: {
        load.cancel()
      }
      try Task.checkCancellation()
      images.append(image)
    }
    return images
  }

  private static func prepare(_ data: Data) throws -> ImportedImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 3072,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    else { throw AttachmentError.invalidFile }
    let encoded = NSMutableData()
    guard
      let output = CGImageDestinationCreateWithData(
        encoded, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw AttachmentError.invalidFile }
    CGImageDestinationAddImage(
      output, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
    guard CGImageDestinationFinalize(output) else { throw AttachmentError.invalidFile }
    guard encoded.length <= AttachmentLimits.maximumBytes else { throw AttachmentError.tooLarge }
    return ImportedImage(data: encoded as Data)
  }
}

/// The callback and task cancellation can win in either order, including before progress exists.
private final class ImageProviderLoad: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<ImportedImage, any Error>?
  private var progress: Progress?
  private var cancelled = false

  var isCancelled: Bool { lock.withLock { cancelled } }
  func begin(_ continuation: CheckedContinuation<ImportedImage, any Error>) -> Bool {
    let started = lock.withLock {
      if cancelled { return false }
      self.continuation = continuation
      return true
    }
    if !started { continuation.resume(throwing: CancellationError()) }
    return started
  }
  func setProgress(_ progress: Progress) {
    let cancel = lock.withLock {
      self.progress = progress
      return cancelled
    }
    if cancel { progress.cancel() }
  }
  func finish(_ result: Result<ImportedImage, any Error>) {
    let continuation = lock.withLock {
      let owned = self.continuation
      self.continuation = nil
      return owned
    }
    continuation?.resume(with: result)
  }
  func cancel() {
    let owned = lock.withLock {
      cancelled = true
      let owned = (continuation, progress)
      continuation = nil
      return owned
    }
    owned.0?.resume(throwing: CancellationError())
    owned.1?.cancel()
  }
}
