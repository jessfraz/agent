import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import AgentCore
@testable import AgentUI

@Suite struct SharedDraftInboxTests {
  private func temporaryRoot() throws -> URL {
    let base =
      ProcessInfo.processInfo.environment["AGENT_SHARE_TEST_ROOT"].map {
        URL(fileURLWithPath: $0, isDirectory: true)
      } ?? FileManager.default.temporaryDirectory
    let root = base.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func png() throws -> Data {
    let context = try #require(
      CGContext(
        data: nil, width: 12, height: 8, bitsPerComponent: 8, bytesPerRow: 48,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 12, height: 8))
    let image = try #require(context.makeImage())
    let data = NSMutableData()
    let output = try #require(
      CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(output, image, nil)
    #expect(CGImageDestinationFinalize(output))
    return data as Data
  }

  @MainActor private func images(_ root: URL, count: Int = 1) async throws -> [ImportedImage] {
    let url = root.appending(path: "Selected.png")
    try png().write(to: url)
    let providers = (0..<count).map { _ in
      let provider = NSItemProvider()
      provider.registerFileRepresentation(
        forTypeIdentifier: UTType.png.identifier, visibility: .all
      ) { done in
        done(url, false, nil)
        return nil
      }
      return provider
    }
    return try await ItemProviderImages.load(providers)
  }

  @Test @MainActor func providerFilesAreOwnedBeforeCallbackEndsAndOnlyOneRepresentationIsRead()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appending(path: "Selected.png")
    try png().write(to: url)
    let provider = NSItemProvider()
    provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all)
    { done in
      done(url, false, nil)
      return nil
    }
    provider.registerDataRepresentation(
      forTypeIdentifier: UTType.plainText.identifier, visibility: .all
    ) { done in
      Issue.record("An unrelated representation was read")
      done(Data("unrelated".utf8), nil)
      return nil
    }
    let imported = try await ItemProviderImages.load([provider])
    try FileManager.default.removeItem(at: url)
    #expect(imported.count == 1)
    let image = try #require(imported.first)
    #expect(image.name == "Image.jpg")
    #expect(image.mediaType == "image/jpeg")
    let source = try #require(CGImageSourceCreateWithData(image.data as CFData, nil))
    #expect(CGImageSourceGetType(source) == UTType.jpeg.identifier as CFString)
    #expect(CGImageSourceGetCount(source) == 1)
    let inbox = SharedDraftInbox(containerURL: root)
    try await inbox.enqueue(images: imported)
    let store = AttachmentStore(directory: root.appending(path: "Draft"))
    let consumed = try await inbox.consumeNext(into: store) { batch in
      let copied = try Data(contentsOf: batch.attachments[0].url)
      #expect(copied == image.data)
    }
    #expect(consumed)
  }

  @Test @MainActor func dataProvidersInvalidImagesUnsupportedTypesAndBounds() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let data = try png()
    let provider = NSItemProvider()
    provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all)
    { done in
      done(data, nil)
      return nil
    }
    #expect(try await ItemProviderImages.load([provider]).count == 1)
    let invalid = NSItemProvider()
    invalid.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) {
      done in
      done(Data("not an image".utf8), nil)
      return nil
    }
    await #expect(throws: AttachmentError.self) {
      try await ItemProviderImages.load([provider, invalid])
    }
    let unsupported = NSItemProvider()
    unsupported.registerDataRepresentation(
      forTypeIdentifier: UTType.plainText.identifier, visibility: .all
    ) { done in
      Issue.record("Unsupported text should not be loaded")
      done(Data(), nil)
      return nil
    }
    await #expect(throws: AttachmentError.self) { try await ItemProviderImages.load([unsupported]) }
    await #expect(throws: AttachmentError.self) { try await ItemProviderImages.load([]) }
    await #expect(throws: AttachmentError.self) {
      try await ItemProviderImages.load(
        Array(repeating: provider, count: AttachmentLimits.maximumCount + 1))
    }
    let oversized = root.appending(path: "TooLarge.png")
    #expect(FileManager.default.createFile(atPath: oversized.path, contents: nil))
    let file = try FileHandle(forWritingTo: oversized)
    try file.truncate(atOffset: UInt64(AttachmentLimits.maximumBytes + 1))
    try file.close()
    let large = NSItemProvider()
    large.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) {
      done in
      done(oversized, false, nil)
      return nil
    }
    await #expect(throws: AttachmentError.self) { try await ItemProviderImages.load([large]) }
  }

  @Test @MainActor func cancellationResumesEvenIfProviderNeverCompletes() async throws {
    let started = AsyncStream<Void>.makeStream()
    let provider = NSItemProvider()
    provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all)
    { _ in
      started.continuation.yield(())
      started.continuation.finish()
      return Progress(totalUnitCount: 1)
    }
    let task = Task { try await ItemProviderImages.load([provider]) }
    for await _ in started.stream { break }
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
  }

  @Test @MainActor
  func escapedNoteBeyondManifestBudgetIsRejectedBeforePublicationAndLaterShareWorks()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let images = try await images(root)
    let inbox = SharedDraftInbox(containerURL: root)
    let rejectedID = UUID()
    let escapedNote = String(repeating: "\n", count: 65_536)
    await #expect(throws: SharedDraftError.self) {
      try await inbox.enqueue(images: images, note: escapedNote, id: rejectedID)
    }
    let queue = root.appending(path: "SharedDraftInbox")
    #expect(
      !FileManager.default.fileExists(atPath: queue.appending(path: rejectedID.uuidString).path))
    let remaining = try FileManager.default.contentsOfDirectory(
      at: queue, includingPropertiesForKeys: nil)
    #expect(!remaining.contains(where: { $0.pathExtension == "partial" }))
    let acceptedNote = "A later invented note\nwith an exact line break."
    let acceptedID = try await inbox.enqueue(images: images, note: acceptedNote)
    let store = AttachmentStore(directory: root.appending(path: "DraftFiles"))
    let consumed = try await inbox.consumeNext(into: store) { batch in
      #expect(batch.id == acceptedID)
      #expect(batch.note == acceptedNote)
      #expect(batch.attachments.count == 1)
      let copied = try Data(contentsOf: batch.attachments[0].url)
      #expect(copied == images[0].data)
    }
    #expect(consumed)
    #expect(
      try await !inbox.consumeNext(into: store) { _ in Issue.record("Unexpected second batch") })
  }

  @Test @MainActor func durableDraftSavePrecedesAckAndRetryKeepsExactTransferIdentity() async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let images = try await images(root, count: 2)
    let inbox = SharedDraftInbox(containerURL: root)
    let id = UUID()
    try await inbox.enqueue(images: images, note: "Optional invented note", id: id)
    try await inbox.enqueue(images: images, note: "Optional invented note", id: id)
    let store = AttachmentStore(directory: root.appending(path: "DraftFiles"))
    let draft = root.appending(path: "draft.json")
    let existing = try await store.stage(
      data: Data("Existing unsent file".utf8), name: "Existing.txt", mediaType: "text/plain")
    try JSONEncoder().encode(
      SavedDraft(
        note: "Existing unsent note", batches: [], files: [existing.reference])
    )
    .write(to: draft)
    // Simulates the app saving successfully, then dying/throwing before acknowledgement.
    await #expect(throws: SimulatedFailure.self) {
      try await inbox.consumeNext(into: store) { batch in
        var saved = try JSONDecoder().decode(SavedDraft.self, from: Data(contentsOf: draft))
        saved.note += "\n\n" + batch.note
        saved.batches.append(batch.id)
        saved.files += batch.attachments.map(\.reference)
        try JSONEncoder().encode(saved).write(to: draft, options: .atomic)
        throw SimulatedFailure()
      }
    }
    // Cold consumer: a new queue/store instance reads the real files, not UI memory.
    let consumed = try await SharedDraftInbox(containerURL: root).consumeNext(
      into: AttachmentStore(directory: root.appending(path: "DraftFiles"))
    ) { batch in
      let saved = try JSONDecoder().decode(SavedDraft.self, from: Data(contentsOf: draft))
      #expect(saved.batches == [batch.id])
      #expect(saved.files == [existing.reference] + batch.attachments.map(\.reference))
      let unchanged = try Data(contentsOf: existing.url)
      #expect(unchanged == Data("Existing unsent file".utf8))
      #expect(saved.note == "Existing unsent note\n\nOptional invented note")
      for file in batch.attachments {
        #expect(FileManager.default.fileExists(atPath: file.url.path))
      }
    }
    #expect(consumed)
    #expect(try await !inbox.consumeNext(into: store) { _ in Issue.record("Duplicate delivery") })
    // Retrying the producer after ack also cannot enqueue that transfer again.
    try await inbox.enqueue(images: images, id: id)
    #expect(try await !inbox.consumeNext(into: store) { _ in Issue.record("Duplicate transfer") })
    // Identical content intentionally shared again is a distinct transfer.
    let second = try await inbox.enqueue(images: images)
    #expect(second != id)
    let consumedSecond = try await inbox.consumeNext(into: store) { batch in
      #expect(batch.id == second)
    }
    #expect(consumedSecond)
  }

  @Test @MainActor func interruptedPublicationCorruptFilesAndCancellationPreserveOwnership()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let images = try await images(root)
    let inbox = SharedDraftInbox(containerURL: root)
    let store = AttachmentStore(directory: root.appending(path: "Draft"))
    let id = try await inbox.enqueue(images: images)
    let queue = root.appending(path: "SharedDraftInbox")
    let attributes = try FileManager.default.attributesOfItem(atPath: queue.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
    #expect(
      try queue.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    #if os(iOS) && !targetEnvironment(simulator)
      #expect(attributes[.protectionKey] as? FileProtectionType == .complete)
    #endif
    let partial = queue.appending(path: "\(UUID().uuidString).partial")
    try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: true)
    try Data("unpublished".utf8).write(to: partial.appending(path: "incomplete"))
    let cancelled = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await inbox.consumeNext(into: store) { _ in Issue.record("Cancelled adoption") }
    }
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    #expect(FileManager.default.fileExists(atPath: queue.appending(path: id.uuidString).path))
    let files = queue.appending(path: id.uuidString).appending(path: "Files")
    let attachmentDir = try #require(
      FileManager.default.contentsOfDirectory(at: files, includingPropertiesForKeys: nil).first)
    let imageURL = attachmentDir.appending(path: "Image.jpg")
    let original = try Data(contentsOf: imageURL)
    try Data("corrupt".utf8).write(to: imageURL)
    await #expect(throws: AttachmentError.self) {
      try await inbox.consumeNext(into: store) { _ in Issue.record("Corrupt import") }
    }
    #expect(!FileManager.default.fileExists(atPath: partial.path))
    #expect(FileManager.default.fileExists(atPath: imageURL.path))
    try original.write(to: imageURL)
    #expect(try await inbox.consumeNext(into: store) { _ in })
    #expect(!FileManager.default.fileExists(atPath: queue.appending(path: id.uuidString).path))
    let cancelledProducer = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await inbox.enqueue(images: images)
    }
    await #expect(throws: CancellationError.self) { try await cancelledProducer.value }
    #expect(
      try await !inbox.consumeNext(into: store) { _ in Issue.record("Cancelled publication") })
    #expect(throws: SharedDraftError.self) { try SharedDraftInbox.configured() }
  }

  @Test @MainActor
  func cancellationAfterDurablePersistenceStillAcknowledgesWithoutDeletingDraftFiles() async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let images = try await images(root)
    let inbox = SharedDraftInbox(containerURL: root)
    let id = try await inbox.enqueue(images: images)
    let store = AttachmentStore(directory: root.appending(path: "Draft"))
    let marker = root.appending(path: "saved-id")
    let consumer = Task {
      try await inbox.consumeNext(into: store) { batch in
        try Data(batch.id.uuidString.utf8).write(to: marker, options: .atomic)
        withUnsafeCurrentTask { $0?.cancel() }
      }
    }
    #expect(try await consumer.value)
    #expect(try Data(contentsOf: marker) == Data(id.uuidString.utf8))
    #expect(
      try await !inbox.consumeNext(into: store) { _ in Issue.record("Replayed committed draft") })
    let adopted = try FileManager.default.contentsOfDirectory(
      at: root.appending(path: "Draft"), includingPropertiesForKeys: nil)
    #expect(adopted.count == 1)
  }

  #if os(macOS)
    @Test @MainActor func crossProcessConsumerCrashReleasesOwnershipWithoutLosingDurableAdoption()
      async throws
    {
      let root = try temporaryRoot()
      defer { try? FileManager.default.removeItem(at: root) }
      let images = try await images(root)
      let inbox = SharedDraftInbox(containerURL: root)
      let id = try await inbox.enqueue(images: images, note: "Invented cross-process note")
      let helper = root.appending(path: "Consumer.swift")
      // A separate executable uses the real queue and AttachmentStore. No copied
      // implementation, child UI, mock provider, or synthetic lock substitutes.
      try #"""
      import Foundation
      import Darwin
      @main struct Consumer {
        static func main() async throws {
          let root = URL(fileURLWithPath: CommandLine.arguments[1])
          let inbox = SharedDraftInbox(containerURL: root)
          let store = AttachmentStore(directory: root.appending(path: "Adopted"))
          try await inbox.consumeNext(into: store) { batch in
            try Data(batch.id.uuidString.utf8).write(to: root.appending(path: "saved-id"), options: .atomic)
            try FileHandle.standardOutput.write(contentsOf: Data("saved\n".utf8))
            while true { pause() }
          }
        }
      }
      """#.write(to: helper, atomically: true, encoding: .utf8)
      let core = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appending(
          path: "Sources/AgentCore")
      let executable = root.appending(path: "consumer")
      let compile = Process()
      compile.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
      compile.arguments =
        ["swiftc", "-swift-version", "6", "-parse-as-library", "-o", executable.path]
        + [
          "Generated.swift", "Attachments.swift", "ItemProviderImages.swift",
          "SharedDraftInbox.swift",
        ].map {
          core.appending(path: $0).path
        } + [helper.path]
      try compile.run()
      compile.waitUntilExit()
      try #require(compile.terminationStatus == 0)
      let child = Process()
      child.executableURL = executable
      child.arguments = [root.path]
      let output = Pipe()
      child.standardOutput = output
      try child.run()
      defer {
        if child.isRunning { child.terminate() }
        child.waitUntilExit()
      }
      let ready = try output.fileHandleForReading.read(upToCount: 6)
      try #require(ready == Data("saved\n".utf8))
      let saved = try Data(contentsOf: root.appending(path: "saved-id"))
      #expect(saved == Data(id.uuidString.utf8))
      let store = AttachmentStore(directory: root.appending(path: "Adopted"))
      await #expect(throws: SharedDraftError.self) {
        try await inbox.consumeNext(into: store) { _ in
          Issue.record("Concurrent consumer acquired ownership")
        }
      }
      // A simultaneous producer must not erase this consumer's source files.
      await #expect(throws: SharedDraftError.self) { try await inbox.enqueue(images: images) }
      child.terminate()
      child.waitUntilExit()
      #expect(child.terminationReason == .uncaughtSignal)
      let consumed = try await SharedDraftInbox(containerURL: root).consumeNext(into: store) {
        batch in
        #expect(batch.id == id)
        let existing = try Data(contentsOf: root.appending(path: "saved-id"))
        #expect(existing == Data(batch.id.uuidString.utf8))
        for file in batch.attachments {
          #expect(FileManager.default.fileExists(atPath: file.url.path))
        }
      }
      #expect(consumed)
      #expect(
        try await !inbox.consumeNext(into: store) { _ in
          Issue.record("Duplicate after crash recovery")
        })
    }
  #endif

  @Test @MainActor
  func atomicComposerRecordPreservesFilesModeFeedbackAndTransferWhileOlderSaveCannotRollItBack()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let image = try await files.stage(data: png(), name: "Feedback.png", mediaType: "image/png")
    let id = UUID()
    let url = root.appending(path: "Composer/draft.json")
    let store = ComposerDraftStore(url: url)
    let current = ComposerDraft(
      text: "/feedback Keep this note", mode: .followUp,
      attachments: [image], consumedTransfers: [id], feedbackScreenshotID: image.id)
    #expect(try await store.save(current, revision: 2))
    #expect(try await !store.save(ComposerDraft(text: "stale"), revision: 1))
    let reopened = try await ComposerDraftStore(url: url).load(from: files)
    #expect(reopened.draft == current)
    #expect(reopened.revision == 2)
    #expect(try Data(contentsOf: image.url) == png())
  }

  @Test @MainActor func differentComposerOwnersCannotSilentlyOverwriteAnUnsentDraft() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appending(path: "Composer/draft.json")
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let first = ComposerDraftStore(url: url)
    let second = ComposerDraftStore(url: url)
    _ = try await first.load(from: files)
    _ = try await second.load(from: files)
    try await first.save(ComposerDraft(text: "First owner's unsent draft"), revision: 1)
    await #expect(throws: (any Error).self) {
      try await second.save(ComposerDraft(text: "Another owner's unsent draft"), revision: 1)
    }
    let reopened = try await ComposerDraftStore(url: url).load(from: files)
    #expect(reopened.draft.text == "First owner's unsent draft")
  }

  @Test @MainActor
  func failedHostSavePreservesTheSharedBatchAndRetryDoesNotAppendItsNoteOrImagesTwice() async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let inbox = SharedDraftInbox(containerURL: root)
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let url = root.appending(path: "Composer/draft.json")
    let model = ChatModel(
      draftStore: files, persistence: ComposerDraftStore(url: url), sharedInbox: inbox,
      admit: { _, _, _ in
        Issue.record("Import must never send")
        return false
      })
    await model.restoreDraft()
    model.connection = .connected
    model.draft = "Already typing"
    await model.attach(
      data: Data("existing file".utf8), name: "Existing.txt", mediaType: "text/plain")
    #expect(await model.saveDraft())
    let original = try #require(model.attachments.first)
    let id = try await inbox.enqueue(images: images(root), note: "Shared note")
    let preserved = root.appending(path: "PreservedComposer")
    try FileManager.default.moveItem(at: url.deletingLastPathComponent(), to: preserved)
    try Data("Not a directory".utf8).write(to: url.deletingLastPathComponent())
    await model.receiveSharedDrafts()
    #expect(model.draft == "Already typing\n\nShared note")
    #expect(model.attachments.count == 2)
    #expect(model.attachments.first == original)
    #expect(model.pendingSharedImport)
    #expect(!model.canSend)
    #expect(!inbox.acknowledged(id))
    #expect(
      FileManager.default.fileExists(
        atPath: root.appending(path: "SharedDraftInbox/\(id.uuidString)").path))
    try FileManager.default.removeItem(at: url.deletingLastPathComponent())
    try FileManager.default.moveItem(at: preserved, to: url.deletingLastPathComponent())
    await model.receiveSharedDrafts()
    #expect(model.draft == "Already typing\n\nShared note")
    #expect(model.attachments.count == 2)
    #expect(Set(model.attachments.map(\.id)).count == 2)
    #expect(!model.pendingSharedImport)
    #expect(inbox.acknowledged(id))
    let reopened = ChatModel(
      draftStore: files, persistence: ComposerDraftStore(url: url), sharedInbox: inbox)
    await reopened.restoreDraft()
    #expect(reopened.draft == model.draft)
    #expect(reopened.attachments == model.attachments)
    let saved = try await ComposerDraftStore(url: url).load(from: files)
    #expect(saved.draft.consumedTransfers.isEmpty)
    #expect(try Data(contentsOf: original.url) == Data("existing file".utf8))
  }

  @Test @MainActor
  func reopeningAfterPersistBeforeAcknowledgementDeduplicatesAndRetiresOnlyTheReceiptedUUID()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let inbox = SharedDraftInbox(containerURL: root)
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let url = root.appending(path: "Composer/draft.json")
    let store = ComposerDraftStore(url: url)
    let id = try await inbox.enqueue(images: images(root), note: "One shared note")
    await #expect(throws: SimulatedFailure.self) {
      try await inbox.consumeNext(into: files) { batch in
        try await store.save(
          ComposerDraft(
            text: batch.note, mode: .followUp,
            attachments: batch.attachments, consumedTransfers: [batch.id]), revision: 1)
        throw SimulatedFailure()
      }
    }
    #expect(!inbox.acknowledged(id))
    let model = ChatModel(
      draftStore: files, persistence: ComposerDraftStore(url: url), sharedInbox: inbox,
      admit: { _, _, _ in
        Issue.record("Recovery must never autosend")
        return false
      })
    await model.restoreDraft()
    #expect(model.draft == "One shared note")
    #expect(model.mode == .followUp)
    #expect(model.attachments.count == 1)
    #expect(inbox.acknowledged(id))
    let saved = try await ComposerDraftStore(url: url).load(from: files)
    #expect(saved.draft.consumedTransfers.isEmpty)
    try await inbox.enqueue(images: images(root), note: "One shared note", id: id)
    await model.receiveSharedDrafts()
    #expect(model.draft == "One shared note")
    #expect(model.attachments.count == 1)
  }

  @Test @MainActor func persistedFeedbackKeepsItsOriginalCaptureAcrossFailedAdmissionAndReopen()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let url = root.appending(path: "Composer/draft.json")
    let model = ChatModel(draftStore: files, persistence: ComposerDraftStore(url: url))
    await model.restoreDraft()
    model.connection = .connected
    model.draft = "/feedback Preserve this exact capture"
    let capture = try png()
    await model.send(screenshot: { capture })
    #expect(await model.saveDraft())
    let original = try #require(model.attachments.first)
    let reopened = ChatModel(draftStore: files, persistence: ComposerDraftStore(url: url))
    await reopened.restoreDraft()
    reopened.connection = .connected
    await reopened.send(screenshot: {
      Issue.record("The saved feedback image must not be recaptured")
      return capture
    })
    #expect(reopened.draft == model.draft)
    #expect(reopened.attachments == [original])
    #expect(try Data(contentsOf: original.url) == capture)
  }

  @Test @MainActor
  func retryRetiresAReceiptedTransferEvenWhenNoReadyBatchRemains() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let inbox = SharedDraftInbox(containerURL: root)
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let url = root.appending(path: "Composer/draft.json")
    let model = ChatModel(
      draftStore: files, persistence: ComposerDraftStore(url: url), sharedInbox: inbox,
      admit: { _, _, _ in
        Issue.record("Recovery must never autosend")
        return false
      })
    await model.restoreDraft()
    model.connection = .connected
    let id = try await inbox.enqueue(images: images(root), note: "Retain this shared note")
    let preserved = root.appending(path: "PreservedComposer")
    try FileManager.default.moveItem(at: url.deletingLastPathComponent(), to: preserved)
    try Data("Not a directory".utf8).write(to: url.deletingLastPathComponent())
    await model.receiveSharedDrafts()
    #expect(model.pendingSharedImport)
    #expect(!model.canSend)
    try FileManager.default.removeItem(at: url.deletingLastPathComponent())
    try FileManager.default.moveItem(at: preserved, to: url.deletingLastPathComponent())
    #expect(await model.saveDraft())
    // Another consumer can finish acknowledgement after this host has already
    // persisted the complete note/files/UUID. Retry must not need a new batch.
    #expect(try await inbox.consumeNext(into: files) { _ in })
    #expect(inbox.acknowledged(id))
    await model.receiveSharedDrafts()
    #expect(!model.pendingSharedImport)
    #expect(model.canSend)
    #expect(model.draft == "Retain this shared note")
    #expect(model.attachments.count == 1)
    let saved = try await ComposerDraftStore(url: url).load(from: files)
    #expect(saved.draft.consumedTransfers.isEmpty)
  }

  @Test @MainActor
  func initialRestorationOwnsTheComposerBeforeAttachmentActionsCanStageAnotherDraft() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let files = AttachmentStore(directory: root.appending(path: "Drafts"))
    let url = root.appending(path: "Composer/draft.json")
    let original = try await files.stage(
      data: Data("saved bytes".utf8), name: "Saved.txt", mediaType: "text/plain")
    try await ComposerDraftStore(url: url).save(
      .init(
        text: "Saved unsent note", mode: .followUp,
        attachments: [original]), revision: 1)
    let model = ChatModel(draftStore: files, persistence: ComposerDraftStore(url: url))
    #expect(!model.draftReady)
    await model.attach(
      data: Data("not yet staged".utf8), name: "Later.txt", mediaType: "text/plain")
    await model.restoreDraft()
    #expect(model.draftReady)
    #expect(model.draft == "Saved unsent note")
    #expect(model.mode == .followUp)
    #expect(model.attachments == [original])
    await model.attach(data: Data("new bytes".utf8), name: "Later.txt", mediaType: "text/plain")
    #expect(model.attachments.count == 2)
    #expect(await model.saveDraft())
    let saved = try await ComposerDraftStore(url: url).load(from: files)
    #expect(saved.draft.attachments == model.attachments)
    #expect(try Data(contentsOf: original.url) == Data("saved bytes".utf8))
  }

  private struct SavedDraft: Codable {
    var note: String
    var batches: [UUID]
    var files: [AttachmentRef]
  }
  private struct SimulatedFailure: Error {}
}
