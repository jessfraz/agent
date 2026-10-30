# Native coordinator client

A SwiftUI client for the coordinator's main conversation. The coordinator owns
Pi, history, models, tools and Rex workers. The app connects through the existing
authenticated NDJSON-over-Tailscale service.

## Build and connect

1. Build the matching coordinator and run `make bindings` from the repository
   root. The native protocol is additive but requires this coordinator version.
   Existing coordinator setup is described in [setup](../docs/setup.md).
2. Open `Agent.xcodeproj` in full Xcode with an iOS 18-or-newer SDK. The `Agent`
   scheme uses this directory's local Swift package without dependencies. For a
   device build, choose a development team and use a bundle ID registered to it.
   Simulator builds do not require signing.
3. Connect Tailscale on the device. The coordinator must authorize its peer
   through the existing same-user, pinned-user or pinned-node policy. A pinned
   human account admits its authorized, untagged devices automatically.
   Tagged devices require their own pinned node identity. Tailnet network policy
   must also permit the coordinator port. See [trust configuration](../docs/setup.md#trust).
4. Enter the coordinator's full MagicDNS name (`machine.example.ts.net`) and
   port, normally `43187`, in Connection. Numeric Tailscale IPv4 addresses also
   work. Each connection resolves the name again and pins a validated tailnet
   address, so IP changes do not require editing the setting. Ordinary LAN
   addresses and IPv6 addresses are unsupported. Transport binds the active
   point-to-point interface's Tailscale IPv4 source address.

## Install on an iPhone

Install Apple's TestFlight app, accept the invitation to the private internal
group, install Agent, and enable **Automatic Updates**. Connect Tailscale before
opening Agent. Internal testing requires no public App Store release; builds
expire after 90 days.

The [Xcode Cloud workflow](ci_scripts/README.md) watches `main`, requires native
tests, archives for internal testing only, and distributes to the private group.
Apple manages signing. The linked setup covers repository access, build numbers
and the first verified upload. `TestFlightExport.plist` supports a manual
internal-only upload when needed.

Optional main-chat alerts require the one-time
[APNs setup](../docs/notifications.md).
Enable **Main-chat updates** in Connection after configuring the coordinator.

For a direct development install, sign in to the developer account in Xcode
Settings, connect the phone, and select it as the `Agent` scheme's run
destination. Choose the team under Signing & Capabilities. Enable Developer
Mode if requested, then Run.

## Behavior and data

- Saved history, streamed answer text, provider-exposed thinking, tool status,
  commentary, durable notices and compaction state use native views. Markdown
  uses Foundation's parser, with native headings, quotes, lists, code blocks and
  tables. Changed rows are prepared once per published snapshot, outside SwiftUI
  bodies. Complete messages use at most four parsing workers, joined before
  publication. Rendering and incoming pages
  are bounded; display truncation does not alter coordinator history.
- Startup reads a bounded recent page. Older history is cursor-paged through
  **Load earlier messages**; the phone never downloads the whole conversation
  before it becomes usable. At most 500 rows and 4 MiB of display text remain
  in memory. The coordinator retains the full history.
- Consecutive tool calls and thinking share a compact disclosure. Progress
  messages stay visible. Expand activity to read the returned reasoning text
  or inspect a command's arguments, output, errors and status.
- Tool details are read on demand from Pi's stored call and result. Each text
  section is limited to 32 KiB; missing content and truncation are shown.
  History pages carry tool identity and status without the full output.
- Slash parsing and execution use the shared Rust command parser and backend
  handlers. The phone menu lists only supported controls. `/resume` remains a
  TUI-only saved-conversation view; it never starts work from this app.
- Messages and feedback, including immutable attachment copies, are saved to a
  per-endpoint outbox before transmission. On iOS it
  uses complete file protection and is excluded from backup. History stays in
  memory; there is no separate phone conversation database.
- Transient network loss reconnects automatically. Disconnect, suspension and
  view removal release owned connections. Returning reconnects and reconciles
  the original input IDs. Uncertain writes are never automatically replayed.
  **Check / retry** retains the same ID;
  terminal rejection retains the original until **Restore to composer**.
- Do not restore an uncertain submission as a new message to bypass checking its
  original ID. Coordinator admission may already have succeeded.
- Use the **+** menu for files, photos, commands and delivery mode, or drop files
  onto the chat. Up to
  eight files of 16 MiB each use the shared chunked attachment protocol. Photos
  are resized and encoded as JPEG. History includes file metadata; bytes are
  downloaded and verified only when opening a preview.
- `/feedback` captures the current app window before sending and includes it
  with the report. Failed admission keeps that exact screenshot for retry.
  Pi's existing adapter handles model image input; other files remain available
  to agent tools on the execution host. No provider requests originate on iOS.

## Validation

```sh
make bindings
swift test --package-path ios
swift test --package-path ios --configuration release \
  --filter pagedHistoryAndStreamingPreparationRemainBoundedAndKeepCanonicalIdentity
xcodebuild -project ios/Agent.xcodeproj -scheme Agent \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath target/ios-app CODE_SIGNING_ALLOWED=NO build
```

Run these from the repository root, with full Xcode selected for Apple checks.
Rust owns the native wire types. The existing bindings exporter generates
`Generated.swift` and schema-covering fixtures, decoded and reserialized by
Rust's actual serde implementation. Swift tests consume those fixtures and
exercise real loopback framing, outbox reconciliation, composer admission and
owned connection cleanup. Rendering tests capture the production message rows
in light, dark and large-text appearance using invented content. Markdown
regressions assert code-fence boundaries, escaped pipes, table cells, inline
styles, link destinations, list numbering/nesting and line breaks. The gallery
includes all heading levels, lists/tasks, wide tables, Unicode and unfinished
code fences. PNGs support manual and Claude review; automatic assertions cover
content, successful native rendering and Dynamic Type height growth. Full-chat
captures cover grouped activity, opened reasoning and command details alongside
the real header and composer. Screenshots are review artifacts, not golden-image
comparisons.
Nested block-container layout, remote image previews, math and diagrams remain
outside this renderer. To retain the review images,
pass `--attachments-path /absolute/existing/directory` to `swift test`.
`bash ios/scripts/check.sh` runs strict Swift lint, macOS tests, the unsigned
app build, package tests on iOS and app-hosted rendering tests. It requires an
installed compatible iOS runtime and cleans up only its own simulator.
CI runs the `host` and `simulator` phases in parallel; both must pass. The
default local command runs both phases, or pass either name to check it alone.
The `Agent` scheme's hosted tests also check that accessibility text sizes
expand the message layout. History preparation benchmarks exercise the real
`Transcript` and rich-text parser with invented content. The timing tests run
alone in Release configuration on macOS and iOS; Debug tests retain the same
ordering, memory and identity checks without timing unoptimized code alongside
unrelated tests. After one warmup, five
iterations produce median CI gates: 20 ms for the first 20-entry page, 250 ms for
26 older pages reaching the 500-row window, and 500 ms for 102 streamed chunks
(about 5 KiB). Test attachments retain every sample and budget. These limits
leave headroom for CI variation and catch substantial regressions; they exclude
network latency, decoding, SwiftUI drawing and device frame pacing. Ordering,
memory bounds and durable identity are also asserted.
Runtime tests exercise the actual Pi/bridge with
synthetic external model responses and host effects, never real accounts.
