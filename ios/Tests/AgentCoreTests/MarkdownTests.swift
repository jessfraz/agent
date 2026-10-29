import Foundation
import Testing

@testable import AgentCore

@Suite struct MarkdownTests {
  @Test func longFencePreservesShorterFenceInsideCode() {
    let blocks = RichText.parse("````swift\nfirst\n```\nstill code\n````")

    #expect(blocks == [.code("first\n```\nstill code", language: "swift")])
  }

  @Test func tildeFencePreservesInvalidClosersUntilStreamingFinishes() {
    let blocks = RichText.parse("~~~~text\nfirst\n~~~\n```\n~~~~ trailing text\nstill code")

    #expect(
      blocks == [.code("first\n~~~\n```\n~~~~ trailing text\nstill code", language: "text")])
  }

  @Test func escapedTablePipeStaysInItsCell() {
    let blocks = RichText.parse(
      "| A | B |\n| --- | --- |\n| left\\|right | second |\n| `left\\|right` | code |")
    var code = AttributedString("left|right")
    code.inlinePresentationIntent = .code

    #expect(
      blocks == [
        .table([
          [AttributedString("A"), AttributedString("B")],
          [AttributedString("left|right"), AttributedString("second")],
          [code, AttributedString("code")],
        ])
      ])
  }

  @Test func separatorLookingTableDataIsPreserved() {
    let blocks = RichText.parse("| A | B |\n| --- | --- |\n| - | : |")

    #expect(
      blocks == [
        .table([
          [AttributedString("A"), AttributedString("B")],
          [AttributedString("-"), AttributedString(":")],
        ])
      ])
  }

  @Test func pipeDelimitedProseNeedsTableHeaderSeparator() {
    let source = "| just prose |\n| more prose |"

    #expect(RichText.parse(source) == [.prose(AttributedString(source))])
  }

  @Test func emptyTableCellsKeepTheirColumnPositions() {
    let blocks = RichText.parse("| A | B |\n| --- | --- |\n| | second |\n| first | |")

    #expect(
      blocks == [
        .table([
          [AttributedString("A"), AttributedString("B")],
          [AttributedString(""), AttributedString("second")],
          [AttributedString("first"), AttributedString("")],
        ])
      ])
  }

  @Test func inlineStylesAndLinkDestinationsReachTheRenderer() throws {
    let blocks = RichText.parse(
      "Plain *italic* **bold** ***both*** ~~strike~~ `code` [link](https://example.invalid).")
    #expect(blocks.count == 1)
    guard case .prose(let text) = try #require(blocks.first) else {
      Issue.record("Expected inline formatting in a paragraph")
      return
    }

    #expect(String(text.characters) == "Plain italic bold both strike code link.")
    let italic = try #require(text.range(of: "italic"))
    let bold = try #require(text.range(of: "bold"))
    let both = try #require(text.range(of: "both"))
    let strike = try #require(text.range(of: "strike"))
    let code = try #require(text.range(of: "code"))
    let link = try #require(text.range(of: "link"))
    #expect(text[italic].inlinePresentationIntent == .emphasized)
    #expect(text[bold].inlinePresentationIntent == .stronglyEmphasized)
    #expect(text[both].inlinePresentationIntent == [.emphasized, .stronglyEmphasized])
    #expect(text[strike].inlinePresentationIntent == .strikethrough)
    #expect(text[code].inlinePresentationIntent == .code)
    #expect(text[link].link == URL(string: "https://example.invalid"))
    #expect(text.runs.allSatisfy { $0.presentationIntent == nil })
  }

  @Test func listMarkersAndNestingKeepTheirNativeLayoutSemantics() {
    let blocks = RichText.parse(
      "- first\n  - nested\n- last\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] later")

    #expect(
      blocks == [
        .listItem(AttributedString("first"), marker: "•", depth: 0),
        .listItem(AttributedString("nested"), marker: "•", depth: 1),
        .listItem(AttributedString("last"), marker: "•", depth: 0),
        .listItem(AttributedString("third"), marker: "3.", depth: 0),
        .listItem(AttributedString("fourth"), marker: "4.", depth: 0),
        .listItem(AttributedString("[x] done"), marker: "•", depth: 0),
        .listItem(AttributedString("[ ] later"), marker: "•", depth: 0),
      ])
  }

  @Test func paragraphSoftBreaksRemainReadable() {
    let source = "First line.\nSecond line."

    #expect(RichText.parse(source) == [.prose(AttributedString(source))])
  }

  @Test func emptyCodeFenceDoesNotDisplayItsMarkdownDelimiters() {
    #expect(RichText.parse("```swift\n```").isEmpty)
  }

  @Test func listContinuationParagraphDoesNotAddAnotherBullet() {
    let blocks = RichText.parse("- first paragraph\n\n  second paragraph")

    #expect(
      blocks == [
        .listItem(AttributedString("first paragraph"), marker: "•", depth: 0),
        .listItem(AttributedString("second paragraph"), marker: "", depth: 0),
      ])
  }

  @Test func nativeBlockIntentsKeepHeadingsQuotesAndDividers() {
    let blocks = RichText.parse(
      """
      # First #

      ## Second

      ### Third

      #### Fourth

      ##### Fifth

      ###### Sixth

      Setext
      ------

      > First quoted line.
      > Second quoted line.

      * * *
      """)

    #expect(
      blocks == [
        .heading(AttributedString("First"), level: 1),
        .heading(AttributedString("Second"), level: 2),
        .heading(AttributedString("Third"), level: 3),
        .heading(AttributedString("Fourth"), level: 4),
        .heading(AttributedString("Fifth"), level: 5),
        .heading(AttributedString("Sixth"), level: 6),
        .heading(AttributedString("Setext"), level: 2),
        .quote(AttributedString("First quoted line.\nSecond quoted line.")),
        .divider,
      ])
  }
}
