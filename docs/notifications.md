# iPhone notifications

The coordinator sends an alert for a new completed main-chat reply or an
explicitly published user notice. Tools, progress, receipts, compaction,
imported conversations and history replay do not trigger alerts. Legacy notices
stay readable without becoming push notifications.

Alerts preview the actual reply or published notice, with basic Markdown
formatting removed and long text truncated. Reasoning, tool output and internal
notice references stay out of the preview. Conversation/message IDs open the
existing main chat. An open main chat suppresses foreground banners; the app
has no persistent background socket.

## One-time setup

1. Enable **Push Notifications** for the app's explicit App ID in the Apple
   developer account. Build with that team's provisioning profile. The app
   already declares the push entitlement; unsigned simulator builds do not
   provision an account or prove real delivery.
2. Create an APNs signing key for the app and environment. Keep the `.p8` key in
   the credential manager, with an owner-only runtime copy on the coordinator
   outside the Nix store. Record its Key ID and the developer Team ID.
3. Add this to the coordinator's private, local `config.toml`. Use the installed
   app's actual bundle identifier as `topic`.

   ```toml
   [apns]
   team_id = "TEAM000001"
   key_id = "KEY0000001"
   topic = "dev.example.Agent"
   key_file = "~/.config/agent/apns/AuthKey.p8"
   environment = "production"
   ```

   The key must be a regular file owned by the service user with owner-only
   permissions, such as `0600`.
   APNs settings are excluded from managed settings and machine announcements.
   Keep both configuration and key outside repositories and the Nix store.
   Restart the coordinator after configuring it.
4. Install and open the signed app on the iPhone. Main-chat updates are enabled
   by default; allow Apple's notification prompt. Connect to the coordinator
   over Tailscale to register the device automatically.

Debug signing uses Apple's development entitlement and requires
`environment = "sandbox"`. TestFlight and Release signing use production.
The coordinator needs outbound HTTPS access to APNs; no public inbound service
is required. Notification delivery uses Apple, while opening the conversation
still uses the trusted Tailscale connection.

## Delivery and recovery

Device tokens are registered again through the trusted connection and are not
saved on the phone. The coordinator retains registrations and delivery state in
private Pi storage. Disabling alerts removes that installation; token changes
supersede its queued deliveries. Enrollment starts at the current conversation
boundary, without alerting for old history.

Turn alerts off in **Connection → Notifications**. That choice and a denied
permission remain off across launches, without repeated permission prompts.
To enable alerts after denying permission, allow Beep Boop notifications in iPhone
Settings and turn **Main-chat updates** back on in Beep Boop.

Each installation/message pair has one durable delivery identity. APNs
acceptance is not proof that the phone displayed an alert. A lost provider
receipt remains uncertain and is not blindly resent, including after restart.
Known temporary rejections retry through Pi's durable scheduler with backoff.
Delivery expires after 24 hours; APNs can retain an accepted alert while the
phone is briefly offline. Internal/control annotations suppress queued alerts;
they cannot retract an alert Apple already accepted.
Apple and the operating system do not provide an exactly-once display guarantee.

See Apple's [registration guide](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)
and [provider authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
for the account and signing steps.
