import Foundation

public enum RichBlock: Sendable, Equatable {
  case prose(AttributedString)
  case heading(AttributedString, level: Int)
  case code(String, language: String)
  case quote(AttributedString)
  case divider
  case table([[AttributedString]])
}

/// Parsing happens on the session actor, never in a SwiftUI body or on MainActor.
public enum RichText {
  public static func parse(_ text: String) -> [RichBlock] {
    let lines = text.components(separatedBy: "\n")
    var blocks: [RichBlock] = []
    var paragraph: [String] = []
    var code: [String]?
    var language = ""
    var fence = ""
    var table: [[AttributedString]] = []
    func inline(_ value: String) -> AttributedString {
      (try? AttributedString(
        markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(value)
    }
    func flush() {
      if !paragraph.isEmpty {
        blocks.append(.prose(inline(paragraph.joined(separator: "\n"))))
        paragraph = []
      }
      if !table.isEmpty {
        blocks.append(.table(table))
        table = []
      }
    }
    for line in lines {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if code != nil {
        if trimmed.hasPrefix(fence) {
          blocks.append(.code(code?.joined(separator: "\n") ?? "", language: language))
          code = nil
        } else {
          code?.append(line)
        }
        continue
      }
      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        flush()
        fence = String(trimmed.prefix(3))
        language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        code = []
        continue
      }
      if trimmed.hasPrefix("|") && trimmed.hasSuffix("|") {
        if !paragraph.isEmpty {
          blocks.append(.prose(inline(paragraph.joined(separator: "\n"))))
          paragraph = []
        }
        let cells = trimmed.dropFirst().dropLast().components(separatedBy: "|").map {
          $0.trimmingCharacters(in: .whitespaces)
        }
        if !cells.allSatisfy({ !$0.isEmpty && $0.allSatisfy { "-: ".contains($0) } }) {
          table.append(cells.map(inline))
        }
        continue
      }
      if !table.isEmpty { flush() }
      let heading = trimmed.prefix(while: { $0 == "#" }).count
      if (1...6).contains(heading) && trimmed.dropFirst(heading).first == " " {
        flush()
        blocks.append(.heading(inline(String(trimmed.dropFirst(heading + 1))), level: heading))
      } else if trimmed.hasPrefix("> ") {
        flush()
        blocks.append(.quote(inline(String(trimmed.dropFirst(2)))))
      } else if ["---", "***", "___"].contains(trimmed) {
        flush()
        blocks.append(.divider)
      } else if trimmed.isEmpty {
        flush()
      } else {
        paragraph.append(line)
      }
    }
    if let code { blocks.append(.code(code.joined(separator: "\n"), language: language)) }
    flush()
    return blocks
  }
}
