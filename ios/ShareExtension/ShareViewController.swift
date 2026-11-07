import AgentCore
import Observation
import SwiftUI
import UIKit

@MainActor final class ShareViewController: UIViewController {
  private var model: ShareDraftModel?

  override func viewDidLoad() {
    super.viewDidLoad()
    let model = ShareDraftModel(context: extensionContext)
    self.model = model
    let content = UIHostingController(rootView: ShareDraftView(model: model))
    addChild(content)
    content.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(content.view)
    NSLayoutConstraint.activate([
      content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      content.view.topAnchor.constraint(equalTo: view.topAnchor),
      content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    content.didMove(toParent: self)
    model.load()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    model?.cancel()
  }
}

@Observable @MainActor private final class ShareDraftModel {
  enum Phase { case loading, ready, saving, retry }
  var phase = Phase.loading
  var note = ""
  var attachments: [LocalAttachment] = []
  var error: String?
  private let context: NSExtensionContext?
  private let transferID = UUID()
  private let directory = FileManager.default.temporaryDirectory.appending(
    path: "Share-\(UUID().uuidString)", directoryHint: .isDirectory)
  private var operation: Task<Void, Never>?
  private var transfer: SharedDraftContent?
  private var completed = false

  init(context: NSExtensionContext?) { self.context = context }

  var canSave: Bool {
    (phase == .ready || phase == .retry) && note.utf8.count <= 64 * 1024
      && (!attachments.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
  }

  func load() {
    guard operation == nil, !completed else { return }
    cleanup()
    phase = .loading
    error = nil
    operation = Task {
      defer {
        operation = nil
        if completed { cleanup() }
      }
      do {
        guard let items = context?.inputItems as? [NSExtensionItem] else {
          throw AttachmentError.invalidFile
        }
        let content = try await SharedDraftImport.load(
          items, into: AttachmentStore(directory: directory))
        try Task.checkCancellation()
        note = content.note
        attachments = content.attachments
        phase = .ready
      } catch {
        if !(error is CancellationError) { self.error = error.localizedDescription }
      }
    }
  }

  func save() {
    guard canSave, operation == nil, !completed else { return }
    let content = transfer ?? SharedDraftContent(note: note, attachments: attachments)
    // Publication can precede an I/O error. Retrying this UUID must preserve
    // the exact first attempt, including the note edited in this extension.
    transfer = content
    note = content.note
    phase = .saving
    error = nil
    operation = Task {
      defer {
        operation = nil
        if completed { cleanup() }
      }
      do {
        let inbox = try SharedDraftInbox.configured()
        try await inbox.enqueue(
          attachments: content.attachments, note: content.note, id: transferID)
        // A published batch belongs to the inbox, even if this extension closes.
        guard !completed else { return }
        completed = true
        context?.completeRequest(returningItems: [])
      } catch {
        phase = .retry
        if !(error is CancellationError) { self.error = error.localizedDescription }
      }
    }
  }

  func cancel() {
    guard !completed else { return }
    completed = true
    operation?.cancel()
    if operation == nil { cleanup() }
    context?.cancelRequest(withError: CocoaError(.userCancelled))
  }

  private func cleanup() { try? FileManager.default.removeItem(at: directory) }
}

private struct ShareDraftView: View {
  @Bindable var model: ShareDraftModel

  var body: some View {
    NavigationStack {
      Form {
        if model.phase == .loading {
          if model.error == nil { ProgressView("Preparing shared items…") }
        } else {
          Section("Note") {
            TextEditor(text: $model.note).frame(minHeight: 120)
              .accessibilityLabel("Shared note")
              .disabled(model.phase != .ready)
          }
          if !model.attachments.isEmpty {
            Section("Attachments") {
              ForEach(model.attachments) { file in
                Label(file.reference.name, systemImage: "paperclip")
              }
            }
          }
        }
        if let error = model.error {
          Text(error).foregroundStyle(.red)
          if model.phase == .loading { Button("Try again", action: model.load) }
        }
        Text("Adds to the unsent draft in Beep Boop. Nothing is sent.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      .navigationTitle("Add to draft")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: model.cancel) }
        ToolbarItem(placement: .confirmationAction) {
          if model.phase == .saving {
            ProgressView().accessibilityLabel("Saving draft")
          } else {
            Button(model.phase == .retry ? "Retry save" : "Save draft", action: model.save)
              .disabled(!model.canSave)
          }
        }
      }
    }
  }
}
