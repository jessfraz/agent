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

The Xcode app target is a development shell, not an App Store distribution
setup. Device signing, VPN routing, system network permissions and background
transitions need validation on a real phone. A macOS Swift package build does
not establish iOS compatibility or on-device security.

## Behavior and data

- Saved history, streamed answer text, provider-exposed thinking, tool status,
  commentary, durable notices and compaction state use native views. Markdown
  and code parsing happen outside SwiftUI bodies. Rendering and incoming pages
  are bounded; display truncation does not alter coordinator history.
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
owned connection cleanup. Runtime tests exercise the actual Pi/bridge with
synthetic external model responses and host effects, never real accounts.
