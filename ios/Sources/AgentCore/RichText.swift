import Foundation

public enum RichBlock: Sendable, Equatable {
  case prose(AttributedString)
  case heading(AttributedString, level: Int)
  case code(String, language: String)
  case quote(AttributedString)
  case listItem(AttributedString, marker: String, depth: Int)
  case divider
  case table([[AttributedString]])
}

/// Foundation owns Markdown syntax. Preparation stays on the session actor.
public enum RichText {
  public static func parse(_ text: String) -> [RichBlock] {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
    guard let parsed = try? AttributedString(markdown: text) else {
      return [.prose(AttributedString(text))]
    }
    var blocks: [RichBlock] = []
    var leafID: Int?
    var leafIntent: PresentationIntent?
    var leafText = AttributedString()
    var markedListItems: Set<Int> = []
    var tableID: Int?
    var tableRows: [[AttributedString]] = []
    func flushLeaf() {
      if !leafText.characters.isEmpty {
        blocks.append(block(leafText, intent: leafIntent, markedListItems: &markedListItems))
      }
      leafID = nil
      leafIntent = nil
      leafText = AttributedString()
    }
    func flushTable() {
      if !tableRows.isEmpty { blocks.append(.table(tableRows)) }
      tableID = nil
      tableRows = []
    }
    for (intent, range) in parsed.runs[\.presentationIntent] {
      var value = AttributedString(parsed[range])
      value.presentationIntent = nil
      if #available(iOS 26, macOS 26, *) { value.listItemDelimiter = nil }
      // Foundation represents soft line breaks as attributed spaces. Preserve
      // the model's line boundaries while retaining all other inline styling.
      let breaks: [(Bool, Range<AttributedString.Index>)] = value.runs[\.inlinePresentationIntent]
        .compactMap { flags, range in
          guard let flags, flags.contains(.softBreak) || flags.contains(.lineBreak) else {
            return nil
          }
          return (flags.contains(.softBreak), range)
        }
      for (soft, range) in breaks.reversed() {
        if soft {
          value.replaceSubrange(range, with: AttributedString("\n"))
        } else {
          value[range].inlinePresentationIntent = nil
        }
      }
      if let component = intent?.components.first(where: {
        if case .table = $0.kind { return true }
        return false
      }), case .table(let columns) = component.kind {
        flushLeaf()
        if tableID != component.identity {
          flushTable()
          tableID = component.identity
        }
        var row = 0
        var column = 0
        for part in intent?.components ?? [] {
          if case .tableRow(let index) = part.kind { row = index }
          if case .tableCell(let index) = part.kind { column = index }
        }
        guard row >= 0, columns.indices.contains(column) else {
          flushTable()
          blocks.append(.prose(value))
          continue
        }
        // Empty cells have no attributed runs; native row/column indexes keep
        // their positions, including an entirely empty row before later data.
        while tableRows.count <= row {
          tableRows.append(Array(repeating: AttributedString(), count: columns.count))
        }
        tableRows[row][column].append(value)
        continue
      }
      flushTable()
      let identity = intent?.components.first?.identity
      if leafID != identity {
        flushLeaf()
        leafID = identity
        leafIntent = intent
      }
      leafText.append(value)
    }
    flushLeaf()
    flushTable()
    return blocks
  }

  private static func block(
    _ text: AttributedString, intent: PresentationIntent?, markedListItems: inout Set<Int>
  ) -> RichBlock {
    let components = intent?.components ?? []
    switch components.first?.kind {
    case .header(let level): return .heading(text, level: level)
    case .codeBlock(let language):
      var code = String(text.characters)
      if code.hasSuffix("\n") { code.removeLast() }
      return .code(code, language: language ?? "")
    case .thematicBreak: return .divider
    default: break
    }
    var ordinal: Int?
    var itemID: Int?
    var ordered: Bool?
    var depth = -1
    for component in components {
      switch component.kind {
      case .listItem(let index):
        if ordinal == nil {
          ordinal = index
          itemID = component.identity
        }
      case .orderedList:
        if ordered == nil { ordered = true }
        depth += 1
      case .unorderedList:
        if ordered == nil { ordered = false }
        depth += 1
      default: break
      }
    }
    if let ordinal, let ordered, let itemID {
      let marker = markedListItems.insert(itemID).inserted ? (ordered ? "\(ordinal)." : "•") : ""
      return .listItem(text, marker: marker, depth: max(depth, 0))
    }
    if components.contains(where: { $0.kind == .blockQuote }) { return .quote(text) }
    return .prose(text)
  }
}
