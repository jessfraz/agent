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
}

private func exercisePreparation() -> PreparationSample {
  let clock = ContinuousClock()
  var transcript = Transcript()
  var pageTimes: [Duration] = []
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
    pageTimes.append(began.duration(to: clock.now))
    #expect(transcript.rows.count <= Transcript.maximumRows)
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
  for chunk in chunks { transcript.response(chunk) }
  let streamTime = streamBegan.duration(to: clock.now)
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
    pageCount: pageTimes.count, chunkCount: chunks.count, streamBytes: answer.text.utf8.count)
}

@Test func pagedHistoryAndStreamingPreparationRemainBoundedAndKeepCanonicalIdentity() {
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
    One warmup followed by \(samples.count) measured iterations; CI gates each sample median.
    Cursor-style history: \(workload.pageCount) pages of 20 messages, each split across two frames, retained window 500 rows.
    Stream: \(workload.chunkCount) chunks, \(workload.streamBytes) UTF-8 bytes, one canonical answer.
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
}
