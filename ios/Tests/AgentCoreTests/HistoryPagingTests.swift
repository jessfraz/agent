import Foundation
import Testing

@testable import AgentCore

private func page(_ id: String, role: HistoryRole = .tool, next: String?) -> NativeEventHistory {
  .init(
    messages: [
      .init(
        continuation: false, entryId: id, finalChunk: true, role: role,
        text: role == .tool ? "Synthetic command output" : "Earlier conversation context",
        tool: role == .tool ? .init(callId: id, name: "exec", status: .finished) : nil)
    ], nextCursor: next, pageComplete: true)
}

@Test(.timeLimit(.minutes(1)))
func earlierHistoryCoalescesActivityPagesAndKeepsOneOwnerAcrossOtherControls() async throws {
  try await withCoordinator { session, fixture, _ in
    var overlapping = page("first-tool", next: "two")
    overlapping.messages += page("latest", role: .final, next: nil).messages
    await fixture.replyToHistory(
      initial: page("latest", role: .final, next: "one"),
      pages: [
        "one": overlapping, "two": page("second-tool", next: "three"),
        "three": page("earlier-user", role: .user, next: "four"),
        "four": page("not-requested", role: .final, next: nil),
      ])
    await fixture.holdHistory("one")
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    let first = Task { await session.loadEarlier() }
    for await _ in fixture.observedHistory { break }
    await session.interrupt()
    await session.loadEarlier()
    #expect(await fixture.historyRequests() == ["one"])
    await fixture.releaseHistory()
    await first.value
    for await update in session.updates
    where !update.loadingHistory && update.rows.contains(where: { $0.entryID == "first-tool" }) {
      #expect(update.rows.contains(where: { $0.entryID == "earlier-user" }))
      #expect(update.olderCursor == "four")
      #expect(Set(update.rows.map(\.id)).count == update.rows.count)
      break
    }
    #expect(await fixture.historyRequests() == ["one", "two", "three"])
  }
}

@Test(.timeLimit(.minutes(1)))
func earlierHistoryCancellationReleasesOwnershipWithoutAdvancing() async throws {
  try await withCoordinator { session, fixture, _ in
    await fixture.replyToHistory(
      initial: page("latest", role: .final, next: "one"),
      pages: ["one": page("earlier-user", role: .user, next: nil)])
    await fixture.holdHistory("one")
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    let loading = Task { await session.loadEarlier() }
    for await _ in fixture.observedHistory { break }
    loading.cancel()
    await loading.value
    for await update in session.updates where !update.loadingHistory {
      #expect(update.olderCursor == "one")
      #expect(!update.rows.contains { $0.entryID == "earlier-user" })
      break
    }
    await fixture.releaseHistory()
    await session.loadEarlier()
    for await update in session.updates where !update.loadingHistory && update.olderCursor == nil {
      #expect(update.rows.contains { $0.entryID == "earlier-user" })
      break
    }
    #expect(await fixture.historyRequests() == ["one", "one"])
  }
}

@Test(.timeLimit(.minutes(1)))
func earlierHistoryStopsAtTheBatchBoundAndRejectsRepeatedCursors() async throws {
  for repeating in [false, true] {
    try await withCoordinator { session, fixture, _ in
      let pages = Dictionary(
        uniqueKeysWithValues: (1...9).map { index in
          ("page-\(index)", page("tool-\(index)", next: repeating ? "page-1" : "page-\(index + 1)"))
        })
      await fixture.replyToHistory(
        initial: page("latest", role: .final, next: "page-1"), pages: pages)
      await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
      for await update in session.updates where update.connection == .connected { break }
      await session.loadEarlier()
      for await update in session.updates
      where !update.loadingHistory && update.rows.contains(where: { $0.entryID == "tool-1" }) {
        #expect(update.olderCursor == (repeating ? "page-1" : "page-9"))
        if repeating { #expect(update.error?.contains("advance") == true) }
        break
      }
      #expect(
        await fixture.historyRequests() == (repeating ? ["page-1"] : (1...8).map { "page-\($0)" }))
    }
  }
}

@Test(.timeLimit(.minutes(1)), arguments: [false, true])
func earlierHistoryRespectsRowAndTextBatchLimits(largeText: Bool) async throws {
  try await withCoordinator { session, fixture, _ in
    let count = largeText ? 1 : 300
    let text = largeText ? String(repeating: "x", count: 2 * 1024 * 1024 + 1) : ""
    let pages = Dictionary(
      uniqueKeysWithValues: (1...3).map { index in
        (
          "page-\(index)",
          NativeEventHistory(
            messages: (0..<count).map { row in
              .init(
                continuation: false, entryId: "tool-\(index)-\(row)", finalChunk: true,
                role: .tool, text: text,
                tool: .init(callId: "call-\(index)-\(row)", name: "exec", status: .finished))
            }, nextCursor: "page-\(index + 1)", pageComplete: true)
        )
      })
    await fixture.replyToHistory(
      initial: page("latest", role: .final, next: "page-1"), pages: pages)
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    await session.loadEarlier()
    for await update in session.updates
    where !update.loadingHistory && update.olderCursor == "page-3" {
      #expect(update.rows.count <= Transcript.maximumRows)
      #expect(update.rows.reduce(0) { $0 + $1.text.utf8.count } <= Transcript.maximumTextBytes)
      #expect(update.rows.contains { $0.entryID == "latest" })
      break
    }
    #expect(await fixture.historyRequests() == ["page-1", "page-2"])
  }
}

@Test(.timeLimit(.minutes(1)))
func latestHistoryReplacesAnOlderWindowAndKeepsConcurrentLiveMessages() async throws {
  try await withCoordinator { session, fixture, _ in
    let recent = (0..<20).map { index in
      HistoryMessage(
        continuation: false, entryId: "recent-\(index)", finalChunk: true,
        role: .final, text: "Recent conversation \(index)")
    }
    let pages = Dictionary(
      uniqueKeysWithValues: (1...2).map { index in
        (
          "page-\(index)",
          NativeEventHistory(
            messages: (0..<300).map { row in
              .init(
                continuation: false, entryId: "old-\(index)-\(row)", finalChunk: true,
                role: .tool, text: "",
                tool: .init(callId: "old-\(index)-\(row)", name: "exec", status: .finished))
            }, nextCursor: "page-\(index + 1)", pageComplete: true)
        )
      })
    await fixture.replyToHistory(
      initial: .init(messages: recent, nextCursor: "page-1", pageComplete: true), pages: pages)
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    await session.loadEarlier()
    for await update in session.updates
    where !update.loadingHistory && update.olderCursor == "page-3" {
      #expect(update.rows.contains { $0.entryID == "recent-0" })
      #expect(!update.rows.contains { $0.entryID == "recent-19" })
      #expect(!update.includesLatest)
      break
    }
    await fixture.replyToLatest(
      .init(messages: recent, nextCursor: "latest-older", pageComplete: true))
    try await fixture.liveMessage(
      .init(
        continuation: false, entryId: "live-start", finalChunk: true,
        role: .tool, text: "", tool: .init(callId: "held-tool", name: "exec", status: .running)))
    for await update in session.updates
    where update.rows.contains(where: { $0.tool?.callId == "held-tool" }) {
      #expect(!update.includesLatest)
      break
    }
    await fixture.holdHistory("<latest>")
    let latest = Task { await session.loadLatest() }
    for await cursor in fixture.observedHistory where cursor == "<latest>" { break }
    try await fixture.liveMessage(
      .init(
        continuation: false, entryId: "live-result", finalChunk: true,
        role: .tool, text: "Completed during history refresh.",
        tool: .init(callId: "held-tool", name: "exec", status: .finished)))
    try await fixture.liveMessage(
      .init(
        continuation: false, entryId: "new-live", finalChunk: true,
        role: .final, text: "This reply arrived while the recent window was loading."))
    for await update in session.updates
    where update.rows.contains(where: { $0.entryID == "new-live" }) {
      #expect(!update.includesLatest)
      break
    }
    await fixture.releaseHistory()
    await latest.value
    for await update in session.updates
    where !update.loadingHistory && update.olderCursor == "latest-older" {
      #expect(
        update.rows.compactMap(\.entryID) == recent.map(\.entryId) + ["live-result", "new-live"])
      #expect(
        update.rows.first(where: { $0.tool?.callId == "held-tool" })?.tool?.status == .finished)
      #expect(update.includesLatest)
      break
    }
    #expect(await fixture.historyRequests() == ["page-1", "page-2", "<latest>"])
  }
}

@Test(.timeLimit(.minutes(1)))
func latestHistoryCancelsAnOlderPageBeforeRefreshing() async throws {
  try await withCoordinator { session, fixture, _ in
    await fixture.replyToHistory(
      initial: page("latest", role: .final, next: "one"),
      pages: [
        "one": page("earlier-user", role: .user, next: nil)
      ])
    await fixture.holdHistory("one")
    await fixture.replyToLatest(page("new-latest", role: .final, next: "new-older"))
    await session.connect(try CoordinatorAddress(host: "100.64.1.2"))
    for await update in session.updates where update.connection == .connected { break }
    let earlier = Task { await session.loadEarlier() }
    for await _ in fixture.observedHistory { break }
    await session.loadLatest()
    await earlier.value
    for await update in session.updates
    where !update.loadingHistory && update.olderCursor == "new-older" {
      #expect(update.rows.compactMap(\.entryID) == ["new-latest"])
      break
    }
    #expect(await fixture.historyRequests() == ["one", "<latest>"])
  }
}
