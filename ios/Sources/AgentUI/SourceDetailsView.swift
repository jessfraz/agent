import AgentCore
import SwiftUI

struct SourceDetailsView: View {
  let model: ChatModel

  var body: some View {
    Form {
      if model.sources.isEmpty {
        ContentUnavailableView(
          "No source status", systemImage: "network",
          description: Text("Connect to the coordinator to check sources."))
      }
      ForEach(model.sources, id: \.source) { state in
        Section(state.displayName) {
          LabeledContent("Account") {
            Text(verbatim: state.source.account).textSelection(.enabled)
          }
          LabeledContent("Status", value: state.coverage.label)
          LabeledContent("Last checked") {
            if let checked = state.lastChecked {
              Text(checked.formatted(date: .abbreviated, time: .standard))
            } else {
              Text("Not checked")
            }
          }
          if let diagnostic = state.coverage.diagnostic {
            Text(verbatim: diagnostic).font(.callout).textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
    }
    .accessibilityIdentifier("sourceDetails")
    .navigationTitle("Sources")
  }
}
