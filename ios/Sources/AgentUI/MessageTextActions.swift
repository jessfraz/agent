import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

extension View {
  func messageTextActions(_ text: String) -> some View {
    modifier(MessageTextActions(text: text))
  }
}

private struct MessageTextActions: ViewModifier {
  private struct Selection: Identifiable {
    let id = UUID()
    let text: String
  }

  let text: String
  @State private var selection: Selection?

  func body(content: Content) -> some View {
    content
      .contentShape(Rectangle())
      .contextMenu {
        Button("Copy message", systemImage: "doc.on.doc") {
          #if os(iOS)
            UIPasteboard.general.string = text
          #elseif os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
          #endif
        }.disabled(text.isEmpty)
        Button("Select text", systemImage: "text.cursor") {
          // A streaming update must not change the range beneath native handles.
          selection = Selection(text: text)
        }.disabled(text.isEmpty)
        ShareLink(item: text) { Label("Share text", systemImage: "square.and.arrow.up") }
      }
      .sheet(item: $selection) { snapshot in
        NavigationStack {
          MessageSelectionText(text: snapshot.text)
            .navigationTitle("Select text")
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("Done") { selection = nil }
              }
            }
        }
      }
  }
}

#if os(iOS)
  // SwiftUI Text on iOS 26 and earlier offers whole-view actions, not range
  // selection. Keep a real native selection surface without replacing the
  // lazily prepared transcript renderer or the live composer's editor.
  private struct MessageSelectionText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
      let view = UITextView()
      view.isEditable = false
      view.isSelectable = true
      view.alwaysBounceVertical = true
      view.font = .preferredFont(forTextStyle: .body)
      view.adjustsFontForContentSizeCategory = true
      view.textColor = .label
      view.backgroundColor = .systemBackground
      view.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
      view.accessibilityIdentifier = "Selectable message text"
      return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
      if view.text != text { view.text = text }
    }
  }
#else
  private struct MessageSelectionText: View {
    let text: String
    var body: some View {
      ScrollView { Text(text).textSelection(.enabled).padding() }
        .frame(minWidth: 320, minHeight: 320)
    }
  }
#endif
