import AgentCore
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
  import PhotosUI
  import QuickLook
#endif

public struct MainChatView: View {
  @State private var model = ChatModel()
  @State private var settings = false
  @State private var followsLatest = true
  @State private var userScrolling = false
  @State private var importingFiles = false
  #if os(iOS)
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var capture = AppScreenshot()
  #endif
  @AppStorage("coordinatorAddress") private var host = ""
  @AppStorage("coordinatorPort") private var port = "43187"
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init() {}
  public var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        connectionBar
        transcript
        if let error = model.error {
          Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(
              .vertical, 8
            )
            .accessibilityLabel("Error. \(error)")
        }
      }
      .background(.background)
      .safeAreaInset(edge: .bottom, spacing: 0) { composer }
      .navigationTitle("Agent")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button("Connection", systemImage: "network") { settings = true }
        }
      }
      .sheet(isPresented: $settings) { connectionSettings }
      .fileImporter(
        isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
      ) { result in
        switch result {
        case .success(let urls): Task { await model.attach(urls: urls) }
        case .failure(let error): model.error = error.localizedDescription
        }
      }
      .dropDestination(for: URL.self) { urls, _ in
        guard !urls.isEmpty else { return false }
        Task { await model.attach(urls: urls) }
        return true
      }
      #if os(iOS)
        .background(ScreenshotAnchor(capture: capture).frame(width: 0, height: 0))
        .quickLookPreview($model.previewURL)
        .onChange(of: selectedPhoto) { _, photo in
          guard let photo else { return }
          Task {
            defer { selectedPhoto = nil }
            await model.attach(photo: photo)
          }
        }
      #endif
      .task {
        // Keep the SwiftUI-owned task alive. Cancellation on removal
        // tears down both the UI subscription and its network owner.
        if host.isEmpty { settings = true } else { await model.connect(host: host, port: port) }
        await model.runUntilCancelled()
      }
      .onChange(of: scenePhase) { _, phase in Task { await model.setActive(phase == .active) } }
    }
  }
  private var connectionBar: some View {
    HStack(spacing: 8) {
      Circle().fill(model.connection == .connected ? .green : .secondary).frame(width: 7, height: 7)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(model.connection.label).font(.caption).foregroundStyle(.primary)
        Text(model.model).font(.caption).fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
      if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Agent is working") }
    }
    .padding(.horizontal).padding(.vertical, 8)
    .background(.bar)
  }
  private var transcript: some View {
    ScrollViewReader { scroll in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          if model.canLoadEarlier {
            Button {
              Task { await model.history() }
            } label: {
              HStack {
                if model.loadingHistory { ProgressView().controlSize(.small) }
                Text("Load earlier messages")
              }
            }
            .disabled(model.loadingHistory).frame(maxWidth: .infinity).padding(.vertical)
          }
          if model.rows.isEmpty {
            Text("No messages yet").font(.callout).foregroundStyle(.primary)
              .frame(maxWidth: .infinity).padding(.vertical, 32)
          }
          ForEach(model.rows) { row in
            MessageRow(
              model: row, retry: { id in Task { await model.retry(id) } },
              restore: { id in Task { await model.restore(id) } },
              preview: { file in Task { await model.preview(file) } })
          }
          Color.clear.frame(height: 1).id("latest")
        }
        .padding().frame(maxWidth: 720).frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .onScrollPhaseChange { _, phase in
        userScrolling = phase == .interacting || phase == .decelerating
      }
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 60
      } action: { _, atBottom in
        // New content changes geometry too. Only a person's scroll should
        // turn off following; initial history must still land at the latest row.
        if userScrolling || atBottom { followsLatest = atBottom }
      }
      .onChange(of: model.revision) { _, _ in
        if followsLatest { scroll.scrollTo("latest", anchor: .bottom) }
      }
      .overlay(alignment: .bottomTrailing) {
        if !followsLatest && !model.rows.isEmpty {
          Button("Latest", systemImage: "arrow.down") {
            followsLatest = true
            if reduceMotion {
              scroll.scrollTo("latest", anchor: .bottom)
            } else {
              withAnimation { scroll.scrollTo("latest", anchor: .bottom) }
            }
          }
          .buttonStyle(.borderedProminent).clipShape(Capsule()).padding()
        }
      }
    }
  }
  private var composer: some View {
    VStack(spacing: 8) {
      if !model.attachments.isEmpty {
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(model.attachments) { file in
              HStack(spacing: 0) {
                AttachmentLabel(reference: file.reference)
                Button("Remove \(file.reference.name)", systemImage: "xmark.circle.fill") {
                  Task { await model.removeAttachment(file) }
                }
                .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                .disabled(model.admitting)
              }
            }
          }
        }
      }
      HStack(alignment: .bottom, spacing: 12) {
        Menu {
          Button("Choose files", systemImage: "folder") { importingFiles = true }
          #if os(iOS)
            PhotosPicker(selection: $selectedPhoto, matching: .images) {
              Label("Choose photo", systemImage: "photo")
            }
          #endif
        } label: {
          Image(systemName: "paperclip").frame(width: 44, height: 44)
        }
        .disabled(
          model.preparingAttachments || model.attachments.count >= AttachmentLimits.maximumCount
        )
        .accessibilityLabel("Attach files or photos")
        TextField("Message the coordinator", text: $model.draft, axis: .vertical)
          .lineLimit(1...8).textFieldStyle(.plain).padding(12)
          .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
          .accessibilityLabel("Message the coordinator")
        Button {
          Task {
            #if os(iOS)
              await model.send(screenshot: capture.png)
            #else
              await model.send()
            #endif
          }
        } label: {
          Group {
            if model.admitting || model.preparingAttachments {
              ProgressView()
            } else {
              Image(systemName: "arrow.up").font(.headline)
            }
          }.frame(width: 44, height: 44)
        }
        .buttonStyle(.borderedProminent).clipShape(Circle())
        .disabled(!model.canSend)
        .accessibilityLabel(model.mode == .steer ? "Send message" : "Queue follow-up")
      }
      HStack {
        Menu {
          ForEach(model.commands, id: \.usage) { command in
            Button {
              model.draft = String(command.usage.prefix(while: { !$0.isWhitespace })) + " "
            } label: {
              Text(command.usage)
              Text(command.description)
            }
          }
        } label: {
          Label("Commands", systemImage: "command").frame(minHeight: 44)
        }
        .tint(.primary)
        Spacer()
        Picker("Delivery", selection: $model.mode) {
          Text("Steer").tag(InputMode.steer)
          Text("Follow-up").tag(InputMode.followUp)
        }
        .pickerStyle(.menu).fixedSize().frame(minHeight: 44).contentShape(Rectangle())
        if model.busy {
          Button("Stop", systemImage: "stop.fill", role: .destructive) {
            Task { await model.interrupt() }
          }.frame(minHeight: 44).contentShape(Rectangle())
        }
      }
      .font(.caption).controlSize(.small)
    }
    .padding().background(.bar)
  }
  private var connectionSettings: some View {
    NavigationStack {
      Form {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            Text("Tailscale address").font(.subheadline)
            TextField("", text: $host, prompt: Text("machine.example.ts.net"), axis: .vertical)
              #if os(iOS)
                .keyboardType(.URL).textInputAutocapitalization(.never)
              #endif
              .lineLimit(1...3).fixedSize(horizontal: false, vertical: true)
              .autocorrectionDisabled().accessibilityIdentifier("coordinatorAddress")
              .accessibilityLabel("Tailscale address")
          }
          LabeledContent("Port") {
            TextField("", text: $port, prompt: Text("43187"))
              #if os(iOS)
                .keyboardType(.numberPad)
              #endif
              .accessibilityIdentifier("coordinatorPort")
          }
        }
        if let error = model.error { Text(error).foregroundStyle(.red) }
        Button("Connect") {
          Task {
            await model.connect(host: host, port: port)
            if model.error == nil { settings = false }
          }
        }.disabled(!validAddress)
        Button("Disconnect", role: .destructive) {
          Task { await model.stop() }
          settings = false
        }.disabled(model.connection == .disconnected)
      }
      .navigationTitle("Connection")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { settings = false }.accessibilityIdentifier("dismissConnection")
        }
      }
    }
  }
  private var validAddress: Bool {
    guard let port = UInt16(port) else { return false }
    return
      (try? CoordinatorAddress(
        host: host.trimmingCharacters(in: .whitespacesAndNewlines), port: port)) != nil
  }
}

struct MessageRow: View {
  let model: RowModel
  let retry: (String) -> Void
  let restore: (String) -> Void
  let preview: (AttachmentRef) -> Void
  @State private var expanded = false
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .callout) private var toolIconSize = 20

  init(
    model: RowModel, retry: @escaping (String) -> Void, restore: @escaping (String) -> Void,
    preview: @escaping (AttachmentRef) -> Void = { _ in }
  ) {
    self.model = model
    self.retry = retry
    self.restore = restore
    self.preview = preview
  }

  var body: some View {
    VStack(alignment: isUser ? .trailing : .leading, spacing: 8) {
      content
        .padding(isUser ? 14 : 0)
        .background(
          isUser ? AnyShapeStyle(Color.accentColor.opacity(0.12)) : AnyShapeStyle(.clear),
          in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .frame(
          maxWidth: isUser && !typeSize.isAccessibilitySize ? 520 : .infinity,
          alignment: isUser ? .trailing : .leading)
      if let delivery = model.row.delivery {
        Label(delivery.rawValue, systemImage: delivery.symbol)
          .font(.caption.weight(.medium)).foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if model.row.delivery == .uncertain, let id = model.row.inputID {
        Button {
          retry(id)
        } label: {
          Label("Check / retry", systemImage: "arrow.clockwise")
            .lineLimit(nil).fixedSize(horizontal: false, vertical: true).frame(minHeight: 44)
        }
        .font(.callout).buttonStyle(.plain)
        .accessibilityHint(
          "Checks the original message ID and retries without creating another message.")
      }
      if model.row.delivery == .rejected, let id = model.row.inputID {
        Button {
          restore(id)
        } label: {
          Label("Restore to composer", systemImage: "arrow.uturn.backward")
            .lineLimit(nil).fixedSize(horizontal: false, vertical: true).frame(minHeight: 44)
        }.font(.callout).buttonStyle(.plain)
      }
    }
    .padding(.leading, isUser && !typeSize.isAccessibilitySize ? 32 : 0)
    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    .accessibilityElement(children: .contain).accessibilityLabel(title)
    .contextMenu {
      ShareLink(item: model.row.text) { Label("Share text", systemImage: "square.and.arrow.up") }
    }
  }
  private var isUser: Bool { model.row.role == .user }
  private var showsHeader: Bool {
    switch model.row.role {
    case .commentary, .partialAnswer, .notice: true
    case .user, .assistant, .final, .thinking, .tool: false
    }
  }
  private var content: some View {
    VStack(alignment: .leading, spacing: 8) {
      if showsHeader {
        Label(title, systemImage: symbol).font(.caption.weight(.semibold)).foregroundStyle(
          .secondary)
      }
      if let tool = model.row.tool {
        HStack {
          Group {
            if tool.status == .running {
              ProgressView().controlSize(.small)
            } else {
              Image(systemName: tool.status == .failed ? "xmark.circle" : "checkmark.circle")
                .foregroundStyle(tool.status == .failed ? .red : .secondary)
            }
          }
          .frame(width: toolIconSize, height: toolIconSize).accessibilityHidden(true)
          Text(tool.name).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
          Text(tool.status.rawValue.capitalized).font(.caption.weight(.medium))
        }
        .accessibilityElement(children: .combine)
      } else if model.row.role == .thinking {
        DisclosureGroup(isExpanded: $expanded) {
          RichMessage(blocks: model.row.blocks).foregroundStyle(.secondary)
        } label: {
          Label("Reasoning", systemImage: "sparkle").font(.callout)
            .frame(minHeight: 44)
        }
      } else {
        RichMessage(
          blocks: model.row.blocks, textStyle: model.row.role == .commentary ? .callout : .body)
      }
      ForEach(model.row.attachments, id: \.id) { reference in
        Button {
          preview(reference)
        } label: {
          AttachmentLabel(reference: reference)
        }
        .buttonStyle(.plain).accessibilityHint("Download and preview attachment")
      }
    }
  }
  private var title: String {
    switch model.row.role {
    case .user: "You"
    case .assistant, .final: "Agent"
    case .commentary: "Update"
    case .partialAnswer: "Partial answer"
    case .notice: "Notice"
    case .thinking: "Reasoning"
    case .tool: "Tool"
    }
  }
  private var symbol: String {
    switch model.row.role {
    case .user: "person"
    case .thinking: "sparkle"
    case .tool: "terminal"
    case .notice: "info.circle"
    default: "bubble.left"
    }
  }
}

extension Delivery {
  fileprivate var symbol: String {
    switch self {
    case .sending: "clock"
    case .saved: "checkmark.circle"
    case .uncertain: "questionmark.circle"
    case .rejected: "exclamationmark.triangle"
    }
  }
}

private struct RichMessage: View {
  let blocks: [RichBlock]
  var textStyle: Font = .body
  @ScaledMetric(relativeTo: .body) private var leading = 3
  @ScaledMetric(relativeTo: .body) private var columnSpacing = 16
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(blocks.indices, id: \.self) { index in
        switch blocks[index] {
        case .prose(let text):
          Text(text).font(textStyle).lineSpacing(leading).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        case .heading(let text, let level):
          Text(text).font(level <= 2 ? .title3 : .headline).accessibilityAddTraits(.isHeader)
            .textSelection(.enabled)
        case .quote(let text):
          Text(text).font(textStyle).lineSpacing(leading).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true).padding(.leading, 12)
            .overlay(alignment: .leading) {
              RoundedRectangle(cornerRadius: 2).fill(.secondary).frame(width: 3)
            }
        case .divider: Divider()
        case .code(let code, let language):
          VStack(alignment: .leading, spacing: 8) {
            if !language.isEmpty { Text(language).font(.caption).foregroundStyle(.secondary) }
            ScrollView(.horizontal) {
              Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
            }
          }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        case .table(let rows):
          ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: columnSpacing, verticalSpacing: 10) {
              ForEach(rows.indices, id: \.self) { row in
                GridRow {
                  ForEach(rows[row].indices, id: \.self) { column in
                    Text(rows[row][column]).fontWeight(row == 0 ? .semibold : .regular)
                      .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                  }
                }
                if row == 0 {
                  GridRow {
                    Divider().gridCellColumns(rows[row].count).gridCellUnsizedAxes(.horizontal)
                  }
                }
              }
            }.padding(12)
          }.background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
      }
    }
  }
}
