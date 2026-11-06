import Foundation
import Testing

@testable import AgentCore

@Test func toolBodySurvivesNativeWireLiveHistoryAndChunks() throws {
  let first = HistoryMessage(
    continuation: false, entryId: "result", finalChunk: false,
    presentation: .command(.init(command: "printf fixture", durationMs: 12, exitCode: 7)),
    role: .tool, text: "First output\n",
    tool: .init(callId: "command", name: "exec", status: .failed))
  let last = HistoryMessage(
    continuation: true, entryId: "result", finalChunk: true, role: .tool,
    text: "Last output", tool: first.tool)
  var live = Transcript()
  live.activity(.toolStarted(.init(callId: "command", name: "exec")))
  for message in [first, last] {
    let bytes = try JSONEncoder().encode(NativeEvent.message(.init(message: message)))
    guard case .message(let value) = try JSONDecoder().decode(NativeEvent.self, from: bytes) else {
      Issue.record("Expected a native message")
      return
    }
    live.message(value.message)
  }
  live.activity(.toolFinished(.init(callId: "command", name: "exec")))
  #expect(live.rows.count == 1)
  #expect(live.rows.first?.text == "First output\nLast output")
  #expect(live.rows.first?.tool?.status == .failed)
  var reopened = Transcript()
  for (index, message) in [first, last].enumerated() {
    let bytes = try JSONEncoder().encode(
      NativeEvent.history(.init(messages: [message], nextCursor: nil, pageComplete: index == 1)))
    guard case .history(let value) = try JSONDecoder().decode(NativeEvent.self, from: bytes) else {
      Issue.record("Expected native history")
      return
    }
    reopened.history(value)
  }
  #expect(reopened.rows == live.rows)
}

@Test func delayedPlacementAdoptsCanonicalHistoryOrderWithoutMovingRepliesBelowTheirAnswers() {
  var transcript = Transcript()
  let first = NativeRequestSubmit(
    inputId: "11111111-1111-4111-8111-111111111111", mode: .steer, text: "Identical reply")
  let second = NativeRequestSubmit(
    inputId: "22222222-2222-4222-8222-222222222222", mode: .steer, text: "Identical reply")
  transcript.pending(first, delivery: .sending)
  transcript.pending(second, delivery: .sending)
  let inputs = transcript.rows.map(\.id)
  transcript.reconnect()
  let page = NativeEventHistory(
    messages: [
      .init(
        continuation: false, entryId: "first-user", finalChunk: true, role: .user, text: first.text),
      .init(
        continuation: false, entryId: "first-answer", finalChunk: true, role: .final,
        text: "First answer"),
      .init(
        continuation: false, entryId: "notice", finalChunk: true, role: .notice,
        text: "A durable notice"),
      .init(
        continuation: false, entryId: "second-user", finalChunk: true, role: .user,
        text: second.text),
      .init(
        continuation: false, entryId: "second-user", finalChunk: true, role: .user,
        text: "Another canonical block"),
      .init(
        continuation: false, entryId: "second-answer", finalChunk: true, role: .final,
        text: "Second answer"),
    ], nextCursor: nil, pageComplete: true)
  transcript.history(page)
  // Acknowledgement order is not conversational order, and text is not identity.
  transcript.delivery(second.inputId, .saved, entryID: "second-user")
  transcript.delivery(first.inputId, .saved, entryID: "first-user")
  #expect(
    transcript.rows.map(\.text) == [
      first.text, "First answer", "A durable notice", second.text, "Another canonical block",
      "Second answer",
    ])
  #expect(transcript.rows.filter { $0.inputID != nil }.map(\.id) == inputs)
  #expect(Set(transcript.rows.map(\.id)).count == transcript.rows.count)
  let settled = transcript.rows
  transcript.history(page)
  #expect(transcript.rows == settled)
}

@Test func lateNativeFinalsUseNumericCausalIDsWithoutSortingLegacyIDs() {
  var transcript = Transcript()
  for (id, role, text) in [("1", HistoryRole.user, "First"), ("10", .user, "Followup")] {
    transcript.message(
      .init(continuation: false, entryId: id, finalChunk: true, role: role, text: text))
  }
  transcript.answer(.init(entryId: "2", text: "Late answer"))
  transcript.message(
    .init(continuation: false, entryId: "3", finalChunk: true, role: .final, text: "Late final"))
  transcript.message(
    .init(continuation: false, entryId: "3", finalChunk: true, role: .final, text: "Second block"))
  #expect(
    transcript.rows.map(\.text) == [
      "First", "Late answer", "Late final", "Second block", "Followup",
    ])
  for id in ["legacy-1", "0", "-1", "+2", "02", "18446744073709551616"] {
    transcript.answer(.init(entryId: id, text: id))
  }
  #expect(
    Array(transcript.rows.suffix(6)).map(\.text) == [
      "legacy-1", "0", "-1", "+2", "02", "18446744073709551616",
    ])
}

@Test func lateNativeFinalDoesNotMoveBeforeTheOriginalCoalescedToolCall() {
  var transcript = Transcript()
  transcript.message(
    .init(
      continuation: false, entryId: "3", finalChunk: true, role: .tool, text: "Call",
      tool: .init(callId: "call", name: "exec", status: .running)))
  transcript.message(
    .init(
      continuation: false, entryId: "9", finalChunk: true, role: .tool, text: "Result",
      tool: .init(callId: "call", name: "exec", status: .finished)))
  transcript.message(
    .init(continuation: false, entryId: "7", finalChunk: true, role: .user, text: "Followup"))
  transcript.answer(.init(entryId: "5", text: "Late final"))
  #expect(transcript.rows.map(\.text) == ["Result", "Late final", "Followup"])
  #expect(transcript.rows.first?.entryID == "9")
}

@Test func nativePlacementOrdersAnInputEvenWhenItsUserBlockIsOutsideHistory() {
  var transcript = Transcript()
  transcript.pending(.init(inputId: "original", mode: .steer, text: "Sent A"), delivery: .uncertain)
  transcript.history(
    .init(
      messages: [
        .init(continuation: false, entryId: "2", finalChunk: true, role: .final, text: "Reply to A")
      ], nextCursor: nil, pageComplete: true))
  transcript.delivery("original", .saved, entryID: "1")
  #expect(transcript.rows.map(\.text) == ["Sent A", "Reply to A"])
  #expect(transcript.rows.first?.id == "input:original")
}

@Test func deliveryReceiptsSurviveReconnectWithoutInventingConfirmation() {
  for known in [Delivery.saved, .rejected, .uncertain] {
    var transcript = Transcript()
    let input = NativeRequestSubmit(inputId: "original", mode: .steer, text: "Original")
    transcript.pending(input, delivery: .sending)
    transcript.delivery(input.inputId, known)
    for _ in 0..<3 {
      transcript.delivery(input.inputId, .uncertain)
      transcript.reconnect()
      transcript.pending(input, delivery: .uncertain)
      transcript.history(.init(messages: [], nextCursor: nil, pageComplete: true))
      #expect(transcript.rows.first?.delivery == known)
      #expect(transcript.rows.first?.inputID == input.inputId)
    }
    // Only an explicit later receipt, not reconnecting, changes this state.
    transcript.delivery(input.inputId, .saved, entryID: "10")
    transcript.delivery(input.inputId, .saved)
    transcript.delivery(input.inputId, .uncertain)
    transcript.pending(input, delivery: .uncertain)
    #expect(transcript.rows.count == 1)
    #expect(transcript.rows.first?.entryID == "10")
    #expect(transcript.rows.first?.delivery == .saved)
  }
}

@Test func repairedNativeAnswerKeepsAllSameIDActivityAndDeduplicatesOnlyVisibleAnswers() {
  for role in [HistoryRole.thinking, .tool, .commentary] {
    var transcript = Transcript()
    let retained = HistoryMessage(
      continuation: false, entryId: "20", finalChunk: true,
      role: role, text: role == .commentary ? " \n\t " : "Retained provider content",
      tool: role == .tool ? .init(callId: "call", name: "exec", status: .finished) : nil)
    transcript.history(.init(messages: [retained], nextCursor: nil, pageComplete: true))
    transcript.answer(.init(entryId: "20", text: "Repaired final"))
    transcript.answer(.init(entryId: "20", text: "Repaired final"))
    transcript.message(
      .init(
        continuation: false, entryId: "20", finalChunk: true,
        role: .final, text: "Repaired final"))
    #expect(transcript.rows.map(\.text) == [retained.text, "Repaired final"])
    #expect(Set(transcript.rows.map(\.id)).count == 2)
  }
  for role in [HistoryRole.assistant, .final, .commentary] {
    var transcript = Transcript()
    transcript.history(
      .init(
        messages: [
          .init(
            continuation: false, entryId: "20", finalChunk: true,
            role: role, text: "Real nonblank reply")
        ], nextCursor: nil, pageComplete: true))
    transcript.answer(.init(entryId: "20", text: "Must not duplicate the real reply"))
    #expect(transcript.rows.map(\.text) == ["Real nonblank reply"])
  }
}
