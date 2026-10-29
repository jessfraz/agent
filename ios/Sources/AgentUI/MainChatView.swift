import AgentCore
import SwiftUI

public struct MainChatView: View {
  @State private var model = ChatModel()
  @State private var settings = false
  @State private var followsLatest = true
  @State private var userScrolling = false
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
        Text(model.connection.label).font(.caption).foregroundStyle(.secondary)
        Text(model.model).font(.caption).lineLimit(2)
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
            ContentUnavailableView(
              "Main conversation", systemImage: "bubble.left.and.bubble.right",
              description: Text(
                "Connect to the existing coordinator. Conversations and work stay on the coordinator."
              ))
          }
          ForEach(model.rows) { row in
            MessageRow(
              model: row, retry: { id in Task { await model.retry(id) } },
              restore: { id in Task { await model.restore(id) } })
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
      HStack(alignment: .bottom, spacing: 12) {
        TextField("Message the coordinator", text: $model.draft, axis: .vertical)
          .lineLimit(1...8).textFieldStyle(.plain).padding(12)
          .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
          .accessibilityLabel("Message the coordinator")
        Button {
          Task { await model.send() }
        } label: {
          Image(systemName: "arrow.up").font(.headline).frame(width: 44, height: 44)
        }
        .buttonStyle(.borderedProminent).clipShape(Circle())
        .disabled(
          model.admitting || model.connection != .connected
            || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
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
          Label("Commands", systemImage: "command")
        }
        Spacer()
        Picker("Delivery", selection: $model.mode) {
          Text("Steer").tag(InputMode.steer)
          Text("Follow-up").tag(InputMode.followUp)
        }
        .pickerStyle(.menu).fixedSize()
        if model.busy {
          Button("Stop", systemImage: "stop.fill", role: .destructive) {
            Task { await model.interrupt() }
          }
        }
      }
      .font(.caption).controlSize(.small)
    }
    .padding().background(.bar)
  }
  private var connectionSettings: some View {
    NavigationStack {
      Form {
        Section("Coordinator") {
          TextField("Tailscale IPv4 address", text: $host)
            #if os(iOS)
              .keyboardType(.decimalPad).textInputAutocapitalization(.never)
            #endif
            .autocorrectionDisabled()
          TextField("Port", text: $port)
            #if os(iOS)
              .keyboardType(.numberPad)
            #endif
        }
        Section {
          Text(
            "Tailscale must be connected on this device. The coordinator verifies the peer using its existing trust policy. No agent or model credentials belong on this phone."
          )
          Text("Attachments, notifications, and voice input are not part of this version.")
        }
        if let error = model.error { Text(error).foregroundStyle(.red) }
        Button("Connect") {
          Task {
            await model.connect(host: host, port: port)
            if model.error == nil { settings = false }
          }
        }
        Button("Disconnect", role: .destructive) {
          Task { await model.stop() }
          settings = false
        }
      }
      .navigationTitle("Connection")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { settings = false } }
      }
    }
  }
}

struct MessageRow: View {
  let model: RowModel
  let retry: (String) -> Void
  let restore: (String) -> Void
  @State private var expanded = false
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .callout) private var toolIconSize = 20

  init(model: RowModel, retry: @escaping (String) -> Void, restore: @escaping (String) -> Void) {
    self.model = model
    self.retry = retry
    self.restore = restore
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
        .font(.callout).buttonStyle(.bordered)
        .accessibilityHint(
          "Checks the original message ID and retries without creating another message.")
      }
      if model.row.delivery == .rejected, let id = model.row.inputID {
        Button {
          restore(id)
        } label: {
          Label("Restore to composer", systemImage: "arrow.uturn.backward")
            .lineLimit(nil).fixedSize(horizontal: false, vertical: true).frame(minHeight: 44)
        }.font(.callout).buttonStyle(.bordered)
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
            Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 10) {
              ForEach(rows.indices, id: \.self) { row in
                GridRow {
                  ForEach(rows[row].indices, id: \.self) { column in
                    Text(rows[row][column]).fontWeight(row == 0 ? .semibold : .regular)
                      .textSelection(.enabled)
                  }
                }
                if row == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
              }
            }.padding(12)
          }.background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
      }
    }
  }
}
