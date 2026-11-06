import AgentCore
import SwiftUI

struct ConversationSettingsView: View {
  let model: ChatModel

  var body: some View {
    Form {
      if !model.settingsSupported {
        Text("Conversation settings are not advertised by this connection.")
      } else if let settings = model.conversationSettings {
        Section {
          LabeledContent("Configured", value: description(settings.configured.model))
          LabeledContent("Effective", value: settings.effective.map(description) ?? "Unknown")
          Text(
            "The active turn may have captured a different selection. Unknown is not the configured default."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
        Section {
          Picker(
            "Model",
            selection: Binding(
              get: { key(settings.configured.model) },
              set: { value in
                guard let option = settings.configured.catalog.first(where: { key($0) == value })
                else { return }
                change(.setModel(.init(modelId: option.modelId, provider: option.provider)))
              }
            )
          ) {
            if !settings.configured.catalog.contains(where: {
              key($0) == key(settings.configured.model)
            }) {
              Text(settings.configured.model.modelId).tag(key(settings.configured.model))
            }
            ForEach(settings.configured.catalog, id: \.settingsKey) { option in
              Text("\(option.name) · \(option.provider.rawValue)").tag(key(option))
            }
          }
          .pickerStyle(.menu).accessibilityIdentifier("conversationModelPicker")
          if let option = settings.configured.catalog.first(where: {
            key($0) == key(settings.configured.model)
          }) {
            Picker(
              "Reasoning",
              selection: Binding(
                get: { settings.configured.model.reasoning?.rawValue ?? "provider_default" },
                set: { value in
                  if value == "provider_default" {
                    change(.setReasoning(.init(reasoning: nil)))
                  } else if let reasoning = Reasoning(rawValue: value),
                    option.reasoning.contains(reasoning)
                  {
                    change(.setReasoning(.init(reasoning: reasoning)))
                  }
                }
              )
            ) {
              Text("Provider default").tag("provider_default")
              if let saved = settings.configured.model.reasoning, !option.reasoning.contains(saved)
              {
                Text("\(saved.selectionLabel) (not supported)").tag(saved.rawValue).disabled(true)
              }
              ForEach(option.reasoning, id: \.rawValue) { reasoning in
                Text(reasoning.selectionLabel).tag(reasoning.rawValue)
              }
            }
            .pickerStyle(.menu).accessibilityIdentifier("conversationReasoningPicker")
            Toggle(
              "Fast",
              isOn: Binding(
                get: { settings.configured.model.fast },
                set: { change(.setFast(.init(mode: $0 ? .on : .off))) }
              )
            )
            .disabled(!option.fast).accessibilityIdentifier("conversationFastToggle")
            if !option.fast { Text("Fast is not supported by this model.").font(.footnote) }
          } else {
            Text("Model capabilities have not been reported.").font(.footnote)
          }
        }
        .disabled(model.settingsBusy || model.connection != .connected)
      } else if model.settingsBusy {
        ProgressView("Loading conversation settings")
      }
      if let error = model.settingsError {
        Text(error).foregroundStyle(.red).accessibilityIdentifier("conversationSettingsError")
      }
      Button("Refresh") { Task { await model.refreshSettings() } }
        .disabled(model.settingsBusy || !model.settingsSupported || model.connection != .connected)
    }
    .navigationTitle("Conversation settings")
    .task(id: model.settingsSupported && model.connection == .connected) {
      await model.refreshSettings()
    }
  }
  private func change(_ change: ConversationChange) {
    Task { await model.refreshSettings(change: change) }
  }
  private func key(_ selection: ModelSelection) -> String {
    "\(selection.provider.rawValue)/\(selection.modelId)"
  }
  private func key(_ option: ModelOption) -> String {
    "\(option.provider.rawValue)/\(option.modelId)"
  }
  private func description(_ selection: ModelSelection) -> String {
    "\(selection.provider.rawValue)/\(selection.modelId) · \(selection.reasoning?.selectionLabel ?? "Provider default") · Fast \(selection.fast ? "on" : "off")"
  }
}

extension Reasoning {
  var selectionLabel: String {
    switch self {
    case .off: "Off (legacy)"
    case .minimal: "Minimal"
    case .low: "Low"
    case .medium: "Medium"
    case .high: "High"
    case .xhigh: "Extra High"
    case .max: "Max"
    }
  }
}

extension ModelOption {
  fileprivate var settingsKey: String { "\(provider.rawValue)/\(modelId)" }
}
