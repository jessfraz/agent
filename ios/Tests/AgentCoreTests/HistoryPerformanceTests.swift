import Foundation
import Testing

@testable import AgentCore

private func measuredMessages(_ range: Range<Int>) -> [HistoryMessage] {
  range.map { index in
    let role: HistoryRole = index.isMultiple(of: 4) ? .user : .final
    let text =
      role == .user
      ? "Check the native build and summarize result \(index)."
      : """
      ### Result \(index)

      The native client keeps **saved messages** on the coordinator and prepares this page for display.
      A [reference](https://example.invalid) and `inline code` remain readable alongside ordinary prose.

      ```swift
      let result = \(index)
      ```

      | Check | Result |
      | --- | --- |
      | Native build | Passed |
      | History | Cursor paged |
      """
    return HistoryMessage(
      continuation: false, entryId: "measured-\(index)", finalChunk: true, role: role,
      text: text, tool: nil)
  }
}

private func milliseconds(_ duration: Duration) -> String {
  let components = duration.components
  return String(
    format: "%.3f",
    Double(components.seconds) * 1_000 + Double(components.attoseconds) / 1_000_000_000_000_000)
}

private struct PreparationSample {
  let firstPage: Duration
  let history: Duration
  let stream: Duration
  let pageCount: Int
  let chunkCount: Int
  let streamBytes: Int
  let snapshotCount: Int
}

private func exercisePreparation() -> PreparationSample {
  let clock = ContinuousClock()
  var transcript = Transcript()
  var pageTimes: [Duration] = []
  var publishedHistory: [ChatRow] = []
  // Read the most recent page first, then advance older cursors one page at a time.
  for start in stride(from: 500, through: 0, by: -20) {
    let messages = measuredMessages(start..<(start + 20))
    let requestID = start == 500 ? nil : UUID()
    let began = clock.now
    transcript.history(
      .init(messages: Array(messages.prefix(10)), nextCursor: nil, pageComplete: false),
      olderPage: start != 500, requestID: requestID)
    transcript.history(
      .init(
        messages: Array(messages.suffix(10)), nextCursor: "before-\(start)", pageComplete: true),
      olderPage: start != 500, requestID: requestID)
    publishedHistory = transcript.rows
    pageTimes.append(began.duration(to: clock.now))
    #expect(publishedHistory.count <= Transcript.maximumRows)
  }
  #expect(transcript.rows.count == Transcript.maximumRows)
  #expect(transcript.rows.compactMap(\.entryID) == (0..<500).map { "measured-\($0)" })
  let canonicalIDs = transcript.rows.map(\.id)
  transcript.history(
    .init(messages: measuredMessages(0..<20), nextCursor: nil, pageComplete: true),
    olderPage: true, requestID: UUID())
  #expect(transcript.rows.map(\.id) == canonicalIDs)

  let chunks =
    ["# Measured answer\n\n"]
    + (0..<100).map { "Detail \($0): **typed** content and `inline code`.\n\n" }
    + ["```swift\nlet count = 100\n```"]
  let streamBegan = clock.now
  var published: [ChatRow] = []
  var observed: [ChatRow] = []
  for (index, chunk) in chunks.enumerated() {
    transcript.response(chunk)
    // Observe frequent bursts, retaining the last snapshot as the UI does.
    // The session already publishes at 50 ms, rather than after every delta.
    if (index + 1).isMultiple(of: 4) {
      published = transcript.rows
      if let row = published.last { observed.append(row) }
    }
  }
  published = transcript.rows
  if let row = published.last { observed.append(row) }
  let streamTime = streamBegan.duration(to: clock.now)
  for row in observed {
    #expect(row.blocks == RichText.parse(row.text))
    #expect(row.id == observed.first?.id)
  }
  let answer = NativeEventAnswer(entryId: "measured-answer", text: chunks.joined())
  transcript.answer(answer)
  transcript.answer(answer)
  #expect(transcript.rows.count == Transcript.maximumRows)
  #expect(transcript.rows.filter { $0.entryID == answer.entryId }.count == 1)
  #expect(transcript.rows.last?.text == answer.text)
  #expect(
    transcript.rows.last?.blocks.contains(.code("let count = 100", language: "swift")) == true)
  #expect(transcript.rows.reduce(0) { $0 + $1.text.utf8.count } <= Transcript.maximumTextBytes)
  #expect(Set(transcript.rows.map(\.id)).count == transcript.rows.count)

  return PreparationSample(
    firstPage: pageTimes[0], history: pageTimes.reduce(Duration.zero, +), stream: streamTime,
    pageCount: pageTimes.count, chunkCount: chunks.count, streamBytes: answer.text.utf8.count,
    snapshotCount: observed.count)
}

@Test func pagedHistoryAndStreamingPreparationRemainBoundedAndKeepCanonicalIdentity() {
  #if DEBUG
    // Debug runs still cover identity, ordering and bounds. Time the shipped
    // configuration in a separate process so other tests cannot compete with it.
    _ = exercisePreparation()
  #else
    // A warmup and sample medians reduce initialization and scheduling noise.
    // These CI budgets leave several times the measured preparation cost as
    // headroom; they catch substantial regressions, not 1% changes or frame pacing.
    _ = exercisePreparation()
    let samples = (0..<5).map { _ in exercisePreparation() }
    let firstPageMedian = samples.map(\.firstPage).sorted()[samples.count / 2]
    let historyMedian = samples.map(\.history).sorted()[samples.count / 2]
    let streamMedian = samples.map(\.stream).sorted()[samples.count / 2]
    let firstPageBudget: Duration = .milliseconds(20)
    let historyBudget: Duration = .milliseconds(250)
    let streamBudget: Duration = .milliseconds(500)
    let workload = samples[0]
    let report = """
      Native transcript preparation, invented content, ContinuousClock elapsed time.
      Release configuration. OS: \(ProcessInfo.processInfo.operatingSystemVersionString); CPUs: \(ProcessInfo.processInfo.processorCount).
      One warmup followed by \(samples.count) measured iterations; CI gates each sample median.
      Cursor-style history: \(workload.pageCount) pages of 20 messages, each split across two frames, retained window 500 rows.
      Stream: \(workload.chunkCount) chunks, \(workload.streamBytes) UTF-8 bytes, \(workload.snapshotCount) observed snapshots, one canonical answer.
      Observes every four deltas and the final prefix; every observed block matches fresh Foundation preparation.
      First-page samples (ms): \(samples.map { milliseconds($0.firstPage) }.joined(separator: ", ")).
      All-page samples (ms): \(samples.map { milliseconds($0.history) }.joined(separator: ", ")).
      Stream samples (ms): \(samples.map { milliseconds($0.stream) }.joined(separator: ", ")).
      First 20-entry page median: \(milliseconds(firstPageMedian)) ms; budget: \(milliseconds(firstPageBudget)) ms.
      All-page median: \(milliseconds(historyMedian)) ms; budget: \(milliseconds(historyBudget)) ms.
      Stream median: \(milliseconds(streamMedian)) ms; budget: \(milliseconds(streamBudget)) ms.
      Includes actual Transcript and RichText preparation. Excludes network, JSON decoding, SwiftUI layout and device frame pacing.
      Budgets have headroom for CI variation and gate substantial preparation regressions, not every small slowdown.
      """
    Attachment.record(report, named: "native-history-performance.txt")
    print(report)
    #expect(
      firstPageMedian <= firstPageBudget,
      "20-entry page preparation exceeded its CI regression budget.")
    #expect(
      historyMedian <= historyBudget,
      "Cursor-paged history preparation exceeded its CI regression budget.")
    #expect(
      streamMedian <= streamBudget,
      "Stream preparation exceeded its CI regression budget.")
  #endif
}

@Test func streamedSnapshotsKeepCurrentMarkdownAndEarlierSnapshotsImmutable() throws {
  var transcript = Transcript()
  let bursts = [
    ["# 日本語\n\n", "First **bold", "** paragraph.\n\n"],
    ["| A | B |\n", "| --- | --- |\n", "| 左\\|右 | β |\n\n"],
    ["```swift\n", "let value = \"🦀\"\n", "```"],
  ]
  var text = ""
  var snapshots: [ChatRow] = []
  for burst in bursts {
    for chunk in burst {
      text += chunk
      transcript.response(chunk)
    }
    let row = try #require(transcript.rows.last)
    #expect(row.text == text)
    #expect(row.blocks == RichText.parse(text))
    snapshots.append(row)
  }
  #expect(snapshots.map(\.id).allSatisfy { $0 == snapshots.first?.id })
  #expect(snapshots.first?.text == bursts[0].joined())
  #expect(snapshots.first?.blocks == RichText.parse(bursts[0].joined()))
  #expect(snapshots.last?.blocks.contains(.code("let value = \"🦀\"", language: "swift")) == true)
}

@Test func streamedThinkingPreparesAtSnapshotsAndReconnectDiscardsItsPendingPreparation() throws {
  var transcript = Transcript()
  transcript.activity(.thinking(.init(text: "First **")))
  transcript.activity(.thinking(.init(text: "thought**\n\n- Check saved data")))
  let first = try #require(transcript.rows.last)
  #expect(first.blocks == RichText.parse(first.text))
  transcript.activity(.thinking(.init(text: "\n- Check the live worker")))
  transcript.reconnect()
  #expect(transcript.rows.isEmpty)
  transcript.response("```swift\n")
  transcript.response("let count = 1")
  transcript.answer(.init(entryId: "saved-answer", text: "Finished **answer**."))
  let answer = try #require(transcript.rows.last)
  #expect(answer.text == "Finished **answer**.")
  #expect(answer.blocks == RichText.parse(answer.text))
  #expect(transcript.rows.count == 1)
}

@Test func historySnapshotsKeepIndependentMarkdownScopesAndCanonicalOrder() {
  let texts = (0..<40).map { index in
    switch index % 5 {
    case 0: "# 日本語 \(index)\n\nA **bold** line.\nAnother `line`."
    case 1: "A [reference][target] remains unresolved in this message."
    case 2: "[target]: https://example.invalid/\(index)"
    case 3: "```swift\nlet value = \"🦀 \(index)\""
    default: "| A | B |\n| --- | --- |\n| 左\\|右 | β \(index) |"
    }
  }
  var transcript = Transcript()
  transcript.history(
    .init(
      messages: texts.enumerated().map { index, text in
        .init(
          continuation: false, entryId: "scope-\(index)", finalChunk: true, role: .final,
          text: text)
      }, nextCursor: nil, pageComplete: true))
  let snapshot = transcript.rows
  #expect(snapshot.map(\.text) == texts)
  #expect(snapshot.compactMap(\.entryID) == (0..<40).map { "scope-\($0)" })
  #expect(snapshot.map(\.blocks) == texts.map(RichText.parse))
  #expect(snapshot[2].blocks.isEmpty)
  #expect(snapshot[3].blocks == [.code("let value = \"🦀 3\"", language: "swift")])
}
