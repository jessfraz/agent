# Native coordinator client

A SwiftUI client for the existing coordinator's **main conversation**, not a
second agent. The coordinator still owns Pi, history, models, tools and Rex
workers. The app uses the existing authenticated NDJSON-over-Tailscale service;
there is no new HTTP endpoint, public listener or phone-side model credential.

## Build and connect

1. Build the matching coordinator and run `make bindings` from the repository
   root. The native protocol is additive but requires this coordinator version.
   Existing coordinator setup is described in [setup](../docs/setup.md).
2. Open `Agent.xcodeproj` in full Xcode with an iOS 18-or-newer SDK. The `Agent`
   scheme uses this directory's local Swift package without dependencies. For a
   device build, choose a development team and replace the example bundle ID.
   Simulator builds do not require signing.
3. Connect Tailscale on the device. The coordinator must authorize its peer
   through the existing same-user or explicitly pinned stable-peer policy.
   Tagged devices do not inherit same-user authorization. Tailnet network policy
   must also permit the existing coordinator port. No policy changes are made
   by this app.
4. Enter the coordinator's numeric Tailscale IPv4 address and port, normally
   `43187`, in Connection. Hostnames, ordinary LAN addresses and IPv6 addresses
   are intentionally unsupported. Transport binds an active point-to-point
   interface's Tailscale IPv4 source address and has no plain-LAN fallback.

Device signing, VPN routing, system network permissions and background
transitions need validation on a real phone. A macOS Swift package build does
not establish iOS compatibility or on-device security.

## Install on an iPhone

For a direct development install, sign in to the intended developer account in
Xcode Settings, connect the phone, and choose it as the `Agent` scheme's run
destination. Select the team under Signing & Capabilities and use a unique
bundle identifier. Enable Developer Mode on the phone if Xcode requests it,
then Run. Tailscale and coordinator authorization are still required.

For private beta updates, use internal TestFlight:

1. Create an App Store Connect app with the same bundle identifier and archive
   the `Agent` scheme for a physical iOS destination using the intended team.
2. Distribute the archive as **TestFlight Internal Only**. The included
   `TestFlightExport.plist` also uploads a signed archive in internal-only mode;
   it cannot be distributed through external TestFlight or the App Store.
3. Add the intended App Store Connect user to an internal testing group and
   assign the processed build. Install Apple's TestFlight app on the phone,
   accept access to Agent and enable Automatic Updates.
4. For automatic delivery, set up an Xcode Cloud workflow for `Agent` in Xcode,
   connect the repository, test before archiving, and add an internal TestFlight
   distribution action for the group. Repository access and signing stay in
   Apple's account setup; no signing keys belong in this repository.

An App Store version does not need to be published for internal beta testing.
TestFlight builds expire after 90 days, so this is a development beta channel.
See Apple's [internal testing](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
and [Xcode Cloud delivery](https://developer.apple.com/documentation/xcode/distributing-your-xcode-cloud-builds-through-testflight)
instructions. Account agreements and signing must be ready before delivery;
an unsigned simulator build does not establish that readiness.

## Behavior and data

- Saved history, streamed answer text, provider-exposed thinking, tool status,
  commentary, durable notices and compaction state use native views. Markdown
  and code parsing happen outside SwiftUI bodies. Rendering and incoming pages
  are bounded; display truncation does not alter coordinator history.
- Startup reads a bounded recent page. Older history is cursor-paged through
  **Load earlier messages**; the phone never downloads the whole conversation
  before it becomes usable. At most 500 rows and 4 MiB of display text remain
  in memory. The coordinator retains the full history.
- Slash parsing and execution use the shared Rust command parser and backend
  handlers. The phone menu lists only supported controls. `/resume` remains a
  TUI-only saved-conversation view; it never starts work from this app.
- Regular text is saved to a per-endpoint outbox before transmission. On iOS it
  uses complete file protection and is excluded from backup. History stays in
  memory; there is no separate phone conversation database.
- Disconnect, suspension and view removal release owned connections. Returning
  reconnects and reconciles the original input IDs. Uncertain writes are never
  automatically replayed. **Check / retry same message** retains the same ID;
  terminal rejection retains the original until **Restore to composer**.
- Do not restore an uncertain submission as a new message to bypass checking its
  original ID. Coordinator admission may already have succeeded.
- Attachments, push notifications and dedicated voice input are out of scope.
  The normal system keyboard remains available.

## Validation

```sh
make bindings
swift test --package-path ios
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
in light and dark appearance using invented content. To retain these images,
pass `--attachments-path /absolute/existing/directory` to `swift test`.
`bash ios/scripts/check.sh` runs strict Swift lint, macOS tests, the unsigned
app build, package tests on iOS and app-hosted rendering tests. It requires an
installed compatible iOS runtime and cleans up only its own simulator.
The `Agent` scheme's hosted tests also check that accessibility text sizes
expand the message layout. History preparation benchmarks exercise the real
`Transcript` and rich-text parser with invented content. After one warmup, five
iterations produce median CI gates: 20 ms for the first 20-entry page, 250 ms for
26 older pages reaching the 500-row window, and 500 ms for 102 streamed chunks
(about 5 KiB). Test attachments retain every sample and budget. These limits
leave headroom for CI variation and catch substantial regressions; they exclude
network latency, decoding, SwiftUI drawing and device frame pacing. Ordering,
memory bounds and durable identity are also asserted.
Runtime tests exercise the actual Pi/bridge with
synthetic external model responses and host effects, never real accounts.
