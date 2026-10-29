import Foundation
import Testing

@testable import AgentCore

@Test func selectedFilesAreCopiedHashedAndRetainedIndependentlyOfTheDraft() async throws {
  let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let source = root.appending(path: "Notes.txt")
  try Data("Original".utf8).write(to: source)
  let drafts = AttachmentStore(directory: root.appending(path: "Drafts"))
  let outbox = AttachmentStore(directory: root.appending(path: "Outbox"))
  let selected = try await drafts.stage(url: source)
  try Data("Changed after selection".utf8).write(to: source)
  let retained = try await outbox.adopt(selected)
  try await drafts.remove(selected)
  #expect(try Data(contentsOf: retained.url) == Data("Original".utf8))
  #expect(retained.reference == selected.reference)
  #expect(retained.reference.mediaType == "text/plain")
  try Data("Corrupt".utf8).write(to: retained.url)
  await #expect(throws: AttachmentError.self) { try await outbox.adopt(retained) }
  #expect(FileManager.default.fileExists(atPath: retained.url.path))
}

@Test func oversizedAndEscapingFilesAreRejectedWithoutLeavingPartialCopies() async throws {
  let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let source = root.appending(path: "Large.bin")
  #expect(FileManager.default.createFile(atPath: source.path, contents: nil))
  let handle = try FileHandle(forWritingTo: source)
  try handle.truncate(atOffset: UInt64(AttachmentLimits.maximumBytes + 1))
  try handle.close()
  let store = AttachmentStore(directory: root.appending(path: "Drafts"))
  await #expect(throws: AttachmentError.self) { try await store.stage(url: source) }
  await #expect(throws: AttachmentError.self) {
    try await store.stage(data: Data(), name: "../Escape.txt", mediaType: "text/plain")
  }
  await #expect(throws: AttachmentError.self) {
    try await store.stage(
      data: Data(), name: String(repeating: "x", count: AttachmentLimits.maximumNameBytes + 1),
      mediaType: "text/plain")
  }
  #expect(!FileManager.default.fileExists(atPath: root.appending(path: "Drafts").path))
}

@Test func magicDNSResolvesAgainAndNeverConnectsOutsideTheTailnet() throws {
  let address = try CoordinatorAddress(host: "Coordinator.Example.ts.net.")
  #expect(address.host == "coordinator.example.ts.net")
  #expect(try address.resolvedHost { _ in ["100.64.1.2"] } == "100.64.1.2")
  #expect(try address.resolvedHost { _ in ["100.64.1.3"] } == "100.64.1.3")
  for answers in [[], ["192.168.1.1"], ["100.64.1.2", "8.8.8.8"], ["100.064.1.2"]] {
    #expect(throws: ConnectionError.self) { try address.resolvedHost { _ in answers } }
  }
  for host in ["coordinator.example.com", "coordinator..ts.net", "-bad.example.ts.net", "ts.net"] {
    #expect(throws: ConnectionError.self) { try CoordinatorAddress(host: host) }
  }
}
