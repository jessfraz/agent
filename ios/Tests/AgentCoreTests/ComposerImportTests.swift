import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import AgentCore
@testable import AgentUI

@Suite @MainActor struct SelectedComposerImports {
  private func root() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func selectedImage(_ root: URL) throws -> NSItemProvider {
    let context = try #require(
      CGContext(
        data: nil, width: 12, height: 8, bitsPerComponent: 8, bytesPerRow: 48,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 12, height: 8))
    let data = NSMutableData()
    let destination = try #require(
      CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
    try #require(CGImageDestinationFinalize(destination))
    let url = root.appending(path: "Selected.png")
    try (data as Data).write(to: url)
    let provider = NSItemProvider()
    provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all)
    { done in
      done(url, false, nil)
      return nil
    }
    provider.registerDataRepresentation(
      forTypeIdentifier: UTType.plainText.identifier, visibility: .all
    ) { done in
      Issue.record("Import read an unrelated representation")
      done(Data("unrelated".utf8), nil)
      return nil
    }
    return provider
  }

  @Test func selectedImageUsesAttachmentStoreWithoutSendingOrReplacingExistingDraft() async throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = AttachmentStore(directory: root.appending(path: "Draft"))
    let calls = ImportSubmissions()
    let model = ChatModel(draftStore: store) { _, _, _ in
      await calls.submitted()
      return true
    }
    model.connection = .connected
    model.draft = "Keep the note with this image."
    await model.attach(data: Data("Existing file".utf8), name: "Notes.txt", mediaType: "text/plain")
    let existing = try #require(model.attachments.first)
    await model.attach(providers: [try selectedImage(root)])
    #expect(model.draft == "Keep the note with this image.")
    #expect(model.attachments.count == 2)
    #expect(model.attachments.first == existing)
    #expect(await calls.count == 0)
    let image = try #require(model.attachments.last)
    #expect(image.reference.mediaType == "image/jpeg")
    let bytes = try Data(contentsOf: image.url)
    let decoded = try #require(CGImageSourceCreateWithData(bytes as CFData, nil))
    #expect(CGImageSourceGetType(decoded) == UTType.jpeg.identifier as CFString)
    #expect(CGImageSourceGetCount(decoded) == 1)
    await model.removeAttachment(image)
    #expect(model.attachments == [existing])
    #expect(!FileManager.default.fileExists(atPath: image.url.path))
    #expect(try Data(contentsOf: existing.url) == Data("Existing file".utf8))
    #expect(model.draft == "Keep the note with this image.")
  }

  @Test func failedSelectionDoesNotPartiallyImportOrLoseTheNoteAndExistingFiles() async throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appending(path: "Draft")
    let model = ChatModel(draftStore: AttachmentStore(directory: directory))
    model.draft = "Unchanged note"
    await model.attach(data: Data("Kept".utf8), name: "Notes.txt", mediaType: "text/plain")
    let existing = model.attachments
    let before = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    await model.attach(providers: [try selectedImage(root), NSItemProvider()])
    #expect(model.draft == "Unchanged note")
    #expect(model.attachments == existing)
    #expect(model.error != nil)
    #expect(!model.preparingAttachments)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() == before)
  }

  @Test func cancellationReleasesTheImportAndKeepsTheCurrentDraft() async throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let model = ChatModel(draftStore: AttachmentStore(directory: root.appending(path: "Draft")))
    model.draft = "Keep this while a provider is cancelled."
    let entered = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    defer { entered.continuation.finish() }
    let provider = NSItemProvider()
    provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all)
    { done in
      let progress = Progress(totalUnitCount: 1)
      progress.cancellationHandler = { done(nil, false, CancellationError()) }
      entered.continuation.yield(())
      return progress
    }
    let task = Task { await model.attach(providers: [provider]) }
    for await _ in entered.stream { break }
    task.cancel()
    await task.value
    #expect(!model.preparingAttachments)
    #expect(model.attachments.isEmpty)
    #expect(model.draft == "Keep this while a provider is cancelled.")
    #expect(model.error == nil)
  }
}

private actor ImportSubmissions {
  private(set) var count = 0
  func submitted() { count += 1 }
}
