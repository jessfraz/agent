import AgentCore
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
  import PhotosUI
  import QuickLook
#endif

public struct MainChatView: View {
  @State private var model: ChatModel
  @State private var activityExpansion = ActivityExpansion()
  private let managesConnection: Bool
  private let detailLoader: ToolDetailsLoader?
  private let initialScrollTarget: String?
  private let notifications: AppNotifications?
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
  @Environment(\.colorScheme) private var colorScheme

  public init(notifications: AppNotifications? = nil) {
    _model = State(initialValue: ChatModel())
    managesConnection = true
    detailLoader = nil
    initialScrollTarget = nil
    self.notifications = notifications
  }
  // Previews and hosted rendering use the real screen with a seeded model,
  // without taking ownership of a live connection or the user's saved address.
  init(
    model: ChatModel, expansion: ActivityExpansion = ActivityExpansion(),
    details: ToolDetailsLoader? = nil, initialScrollTarget: String? = nil
  ) {
    _model = State(initialValue: model)
    _activityExpansion = State(initialValue: expansion)
    managesConnection = false
    detailLoader = details
    self.initialScrollTarget = initialScrollTarget
    notifications = nil
    _followsLatest = State(initialValue: initialScrollTarget == nil)
  }
  public var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if model.connection == .connecting || model.connection == .reconnecting {
          HStack(spacing: 8) {
            ProgressView().controlSize(.mini)
            Text(model.connection.label).font(.footnote).foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16).padding(.vertical, 8)
        }
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
        .toolbarBackground(Color(uiColor: .systemBackground), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
      #endif
      .toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 1) {
            Text("Agent").font(.headline)
            Text(model.model.split(separator: "/").last.map(String.init) ?? model.model)
              .font(.caption).foregroundStyle(.primary.opacity(0.65)).lineLimit(1)
          }.accessibilityElement(children: .combine)
        }
        ToolbarItem(placement: .primaryAction) {
          Button("Connection", systemImage: "slider.horizontal.3") { settings = true }
            .tint(.primary)
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
        guard managesConnection else { return }
        // Keep the SwiftUI-owned task alive. Cancellation on removal
        // tears down both the UI subscription and its network owner.
        if host.isEmpty { settings = true } else { await model.connect(host: host, port: port) }
        await model.runUntilCancelled()
      }
      .onChange(of: scenePhase) { _, phase in
        notifications?.mainVisible = phase == .active && !settings
        if managesConnection { Task { await model.setActive(phase == .active) } }
      }
      .onAppear { notifications?.mainVisible = scenePhase == .active && !settings }
      .onDisappear { notifications?.mainVisible = false }
      .onChange(of: settings) { _, presented in
        notifications?.mainVisible = scenePhase == .active && !presented
      }
      .onChange(of: model.connection) { _, state in
        if state == .connected, let registration = notifications?.registration {
          Task { await model.connectNotifications(registration) }
        }
      }
      .onChange(of: notifications?.openedTarget) { _, target in
        if target != nil {
          settings = false
          followsLatest = true
        }
      }
    }
  }
  private var transcript: some View {
    ScrollViewReader { scroll in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
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
          ForEach(TranscriptItem.grouped(model.rows)) { item in
            switch item {
            case .message(let row):
              MessageRow(
                model: row, retry: { id in Task { await model.retry(id) } },
                restore: { id in Task { await model.restore(id) } },
                preview: { file in Task { await model.preview(file) } })
            case .activity(let group):
              ActivityGroupView(
                group: group, expansion: $activityExpansion, details: loadDetails,
                onExpand: { followsLatest = false })
            }
          }
          if model.busy {
            HStack(spacing: 8) {
              ProgressView().controlSize(.mini)
              Text("Working…").font(.footnote).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
              .accessibilityLabel("Agent is working")
          }
          Color.clear.frame(height: 1).id("latest")
        }
        .padding().frame(maxWidth: 720).frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(initialScrollTarget == nil ? .bottom : .top, for: .initialOffset)
      .task {
        if let initialScrollTarget {
          await Task.yield()
          scroll.scrollTo(initialScrollTarget, anchor: .top)
        }
      }
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
      .onChange(of: notifications?.openedTarget) { _, target in
        if target != nil { scroll.scrollTo("latest", anchor: .bottom) }
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
          .buttonStyle(.borderedProminent).tint(.primary)
          .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
          .clipShape(Capsule()).padding()
        }
      }
    }
  }
  private func loadDetails(_ row: ChatRow) async throws -> ToolDetails {
    if let detailLoader { return try await detailLoader(row) }
    return try await model.toolDetails(for: row)
  }
  private var showsStop: Bool {
    model.busy && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && model.attachments.isEmpty
  }
  private var composer: some View {
    VStack(spacing: 6) {
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
      HStack(alignment: .bottom, spacing: 4) {
        Menu {
          Section("Attachments") {
            Button("Choose files", systemImage: "folder") { importingFiles = true }
            #if os(iOS)
              PhotosPicker(selection: $selectedPhoto, matching: .images) {
                Label("Choose photo", systemImage: "photo")
              }
            #endif
          }.disabled(
            model.preparingAttachments || model.attachments.count >= AttachmentLimits.maximumCount)
          Menu("Commands", systemImage: "command") {
            ForEach(model.commands, id: \.usage) { command in
              Button {
                model.draft = String(command.usage.prefix(while: { !$0.isWhitespace })) + " "
              } label: {
                Text(command.usage)
                Text(command.description)
              }
            }
          }.disabled(model.commands.isEmpty)
          Picker("Delivery", selection: $model.mode) {
            Text("Steer").tag(InputMode.steer)
            Text("Follow-up").tag(InputMode.followUp)
          }.pickerStyle(.inline)
          if model.busy {
            Button("Stop response", systemImage: "stop.fill") { Task { await model.interrupt() } }
          }
        } label: {
          Image(systemName: "plus").font(.system(size: 19, weight: .regular))
            .frame(width: 44, height: 44).contentShape(Circle())
        }
        .tint(.primary).accessibilityLabel("Add attachments or commands")
        .accessibilityIdentifier("composerMenu")
        TextField(
          model.mode == .steer ? "Message Agent" : "Queue a follow-up", text: $model.draft,
          axis: .vertical
        )
        .lineLimit(1...6).textFieldStyle(.plain).padding(.vertical, 11).padding(.horizontal, 2)
        .accessibilityLabel("Message the coordinator").accessibilityIdentifier(
          "Message the coordinator")
        Button {
          let stop = showsStop
          Task {
            if stop {
              await model.interrupt()
            } else {
              #if os(iOS)
                await model.send(screenshot: capture.png)
              #else
                await model.send()
              #endif
            }
          }
        } label: {
          Group {
            if model.admitting || model.preparingAttachments {
              ProgressView().tint(colorScheme == .dark ? .black : .white)
            } else {
              Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                .font(.system(size: 15, weight: .semibold))
            }
          }
          .foregroundStyle(.background).frame(width: 32, height: 32)
          .background(.primary, in: Circle()).opacity(showsStop || model.canSend ? 1 : 0.25)
          .frame(width: 44, height: 44).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(showsStop ? model.connection != .connected : !model.canSend)
        .accessibilityLabel(
          showsStop ? "Stop response" : model.mode == .steer ? "Send message" : "Queue follow-up")
      }
      .padding(5)
      .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 26))
      .overlay {
        RoundedRectangle(cornerRadius: 26).strokeBorder(.primary.opacity(0.12), lineWidth: 0.5)
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 8).background(.background)
  }
  private var connectionSettings: some View {
    NavigationStack {
      Form {
        Section {
          LabeledContent("Status", value: model.connection.label)
          LabeledContent("Model", value: model.model)
        }
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
        if let registration = notifications?.registration {
          Section {
            Toggle(
              "Main-chat updates",
              isOn: Binding(
                get: { registration.enabled },
                set: { value in Task { await registration.setEnabled(value) } }
              )
            )
            .disabled(registration.busy || model.connection != .connected)
            if let error = registration.error {
              Text(error).font(.footnote).foregroundStyle(.red)
              if !registration.enabled, registration.registered {
                Button("Retry removing this device") {
                  Task { await registration.setEnabled(false) }
                }.disabled(registration.busy)
              }
            } else if !registration.configured {
              Text("APNs setup is required on the coordinator.").font(.footnote)
            } else if registration.enabled, !registration.registered {
              Text("Waiting for this device's Apple registration.").font(.footnote)
            }
          } header: {
            Text("Notifications").foregroundStyle(Color.primary)
          }
        }
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
          isUser ? AnyShapeStyle(Color.primary.opacity(0.07)) : AnyShapeStyle(.clear),
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
    model.row.role == .notice
  }
  private var content: some View {
    VStack(alignment: .leading, spacing: 8) {
      if showsHeader {
        Label(title, systemImage: symbol).font(.caption.weight(.semibold)).foregroundStyle(
          .secondary)
      }
      if model.row.tool != nil || model.row.role == .thinking {
        ActivityItemView(
          model: model, expanded: $expanded,
          details: { row in .unavailable(.init(callId: row.tool?.callId ?? "")) })
      } else {
        RichMessage(blocks: model.row.blocks)
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

struct RichMessage: View {
  let blocks: [RichBlock]
  var textStyle: Font = .body
  var compact = false
  @ScaledMetric(relativeTo: .body) private var leading = 3
  @ScaledMetric(relativeTo: .body) private var columnSpacing = 16
  @ScaledMetric(relativeTo: .body) private var listIndent = 16
  @ScaledMetric(relativeTo: .body) private var listMarkerWidth = 24
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(blocks.indices, id: \.self) { index in
        switch blocks[index] {
        case .prose(let text):
          Text(text).font(textStyle).lineSpacing(leading).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        case .heading(let text, let level):
          Text(text).font(compact ? textStyle : level <= 2 ? .title3 : .headline)
            .accessibilityAddTraits(.isHeader)
            .textSelection(.enabled)
        case .quote(let text):
          Text(text).font(textStyle).lineSpacing(leading).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true).padding(.leading, 12)
            .overlay(alignment: .leading) {
              RoundedRectangle(cornerRadius: 2).fill(.secondary).frame(width: 3)
            }
        case .listItem(let text, let marker, let depth):
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).frame(minWidth: listMarkerWidth, alignment: .trailing)
            Text(text).lineSpacing(leading).textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
          }
          .font(textStyle).padding(.leading, CGFloat(depth) * listIndent)
          .accessibilityElement(children: .combine)
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
    .frame(maxWidth: .infinity, alignment: .leading).multilineTextAlignment(.leading)
  }
}
