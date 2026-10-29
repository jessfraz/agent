import AgentCore
import SwiftUI

struct AttachmentLabel: View {
  let reference: AttachmentRef
  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(reference.name).font(.callout).lineLimit(2).truncationMode(.middle)
        Text(
          ByteCountFormatter.string(fromByteCount: Int64(reference.sizeBytes), countStyle: .file)
        )
        .font(.caption).foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: reference.mediaType.hasPrefix("image/") ? "photo" : "doc")
    }
    .padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
  }
}

#if os(iOS)
  import ImageIO
  import CoreTransferable
  import UIKit
  import UniformTypeIdentifiers

  @MainActor final class AppScreenshot {
    weak var anchor: UIView?
    func png() throws -> Data {
      guard let window = anchor?.window else {
        throw AttachmentError.unavailable("The current app view could not be captured.")
      }
      let format = UIGraphicsImageRendererFormat()
      format.scale = min(window.screen.scale, 2)
      format.opaque = true
      var drawn = false
      let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
        drawn = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
      }
      guard drawn, let data = image.pngData() else {
        throw AttachmentError.unavailable("The current app view could not be captured.")
      }
      return data
    }
  }

  struct ScreenshotAnchor: UIViewRepresentable {
    let capture: AppScreenshot
    func makeUIView(context: Context) -> UIView {
      let view = UIView()
      capture.anchor = view
      return view
    }
    func updateUIView(_ view: UIView, context: Context) {}
  }

  struct ImportedPhoto: Transferable, Sendable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
      FileRepresentation(importedContentType: .image) { received in
        guard let source = CGImageSourceCreateWithURL(received.file as CFURL, nil) else {
          throw AttachmentError.invalidFile
        }
        return ImportedPhoto(data: try jpeg(source))
      }
    }
    // Pi accepts JPEG/PNG images. Decode a bounded thumbnail rather than the full photo.
    private static func jpeg(_ source: CGImageSource) throws -> Data {
      guard
        let image = CGImageSourceCreateThumbnailAtIndex(
          source, 0,
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 3072,
            kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary),
        let encoded = UIImage(cgImage: image).jpegData(compressionQuality: 0.9)
      else { throw AttachmentError.invalidFile }
      guard encoded.count <= AttachmentLimits.maximumBytes else { throw AttachmentError.tooLarge }
      return encoded
    }
  }
#endif
