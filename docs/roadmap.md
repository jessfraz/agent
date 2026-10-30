# Roadmap

Remaining work. The [architecture](architecture.md) describes ownership and
recovery; [history](history.md) describes import and retrieval.

## Finish the current pass

- [ ] Finish Codex catch-up and vector indexing, reconcile source coverage, and
  verify real searches. Missing files stay explicit gaps.
- [ ] Verify chat admission, steering, interruption, reopening and scrolling
  against a large live corpus while background work runs.
- [x] Pin and activate scheduled-chat reuse, recovery and shared worktree
  controls through Global Nix. Background, CLI and main-agent collection have
  passed live checks, preserving active and dirty work.
- [x] Verify failed scheduled occurrences settle after recovery on their
  existing tasks, clearing scheduler errors while preserving unresolved work.
- [ ] Verify chat reuse and native worktree inventory display live.
- [x] Ship private lifecycle logs, `/machines`, local usage-reset times and
  countdowns, and the remaining viewport correction.

## Inputs and automation

- [ ] `/goal` for persistent objectives, visible progress, pause/resume and
  completion tied to a verified outcome.
- [x] Ship hosted web search and page retrieval with source links for supported
  OpenAI models. The existing ChatGPT login has passed an isolated search,
  open-page and find-in-page check. Other providers need their own integration.
- [ ] Verify unattended Chrome tasks through completed sign-in and real task
  outcomes in the selected host's existing profile. Native CDP and private
  1Password CLI reads and independent page initialization are implemented.
  Packaged runtimes passed fresh password/TOTP sign-in on both macOS hosts.
  Remaining deployment acceptance includes service restarts, OS reboots,
  ordinary browser relaunch, no recurring consent, owned tab cleanup and
  interruption recovery with autofill enabled.
- [ ] Deliver browser screenshot attachments.
- [x] A phone client for the main conversation, using the same submission,
  steering and queueing path as the CLI. The native iPhone app fulfills the
  planned WhatsApp/iMessage client use case.
- [ ] Enable iPhone alerts for completed main-chat replies and explicit
  `notify_user` notices, including mid-job requests. The durable delivery path
  is implemented; Apple provisioning and real-phone delivery remain to verify.
  See [notification setup](notifications.md).
- [ ] Direct coordination between task sessions: durable messages with delivery
  receipts, steering or queueing, and references to shared work. Reuse existing
  task inboxes and workers.
- [ ] Voice input through a transcription provider interface.
- [x] File/photo attachments on iOS and dragged files in the terminal, retained
  with the conversation and delivered to Pi on the selected execution host.
- [ ] Paste image attachments from the clipboard.
- [x] Scheduled jobs through the existing coordinator background process and
  task follow-through path. Reuse durable timers; persist occurrence identities
  so restarts and retries cannot run a job twice.
- [x] Reuse each scheduled job's Rex chat and Pi conversation across timer and
  manual runs, preserving each admitted run's prompt, model and identity.
- [x] Shared worktree inventory through the CLI and `/worktrees`, including
  native chat clients.

## Retrieval, learning and proof

- [ ] ChatGPT conversation import from a verified export, with resumable,
  idempotent ingestion and attachment coverage.
- [ ] Representative query plans and benchmarks for native state, full-text
  search, vector search and hydration. Measure before changing index technology.
- [ ] Private retrieval evals: paraphrases, exact references, similar threads,
  rich older context versus sparse recent context, and incomplete coverage.
  Track recall, wrong-thread selection and latency.
- [ ] End-to-end loop-closing tests and model evals: incoming reply → relevant
  existing task → resumed worker → action → verified outcome. Cover unrelated
  noise, exchanges already handled by the user, malicious source instructions,
  duplicate events and source failures.
- [x] CLI startup and retained-history first-render benchmarks, with paired
  baseline comparisons and a separate CI regression gate.
- [ ] Benchmarks for input admission, first visible activity, steering/stop,
  long-history scrolling, search and import contention. Separate application
  delay from model latency; track CPU, RAM and token use.
- [x] Nightly operational log review through scheduled jobs, with coordinator
  collection, retained task summaries and explicit coverage gaps. Repeat a
  review through the [scheduled-job run command](setup.md#scheduled-jobs).
- [ ] Dreams and Dreams evals: inspect private logs nightly and propose useful
  improvements as reviewable diffs with before/after evidence. Learned changes
  take effect only after approval of that diff.
- [ ] Connect Pi's native telemetry to the same diagnostics. Show token use,
  cache hits and estimated cost for every chat, separately from subscription
  quota; keep estimates distinct from billed amounts.
- [ ] Benchmark deferred tool discovery before adopting it for larger toolsets.

## Recovery

- [ ] Reconcile Rex server restarts, terminal exits and reconnects without
  duplicate sessions or lost pending inputs.
- [ ] Tested coordinator backups and restoration, including retained assets.
- [ ] Replicated coordinator state and failover, retaining one active owner so
  additional coordinators do not duplicate work or external effects.

## Reuse upstream

Verified against Pi Durable 1.4.0 and Agent's current source. Source integration
and deployment are tracked separately above.

| Upstream capability | Status | Application use and remaining work |
| --- | --- | --- |
| Durable conversations, submissions and task checkpoints | In use | Native Harness, SQLite storage and checkpointed documents own history and execution. |
| Steering, follow-ups, abort and compaction | In use | Native input modes, abort and compaction events drive chat. |
| Durable sleeps and wake notifications | In use | Sources, resources and jobs share Pi's persisted sleeps and scheduler. |
| Typed telemetry and usage totals | Partial | Pi records usage, but Agent does not expose its totals or install a telemetry adapter. Wire these into diagnostics and status. |
| Image preparation workers | In use | Pi's Photon worker prepares attached images for native model input. Agent owns transfer and storage. |
| Image-aware file readers | Not enabled | Agent owns its host file tools; reuse Pi's image-aware reads when extending them. |
| Forks, child tasks and task graphs | Partial | Pi executes native model/tool task trees. Agent delegates use separate conversations; forks and graph views are not integrated. Evaluate native ownership while preserving delegates' durable lifetimes and Rex bindings. |
| Deferred tool search and code mode | Not enabled | Benchmark upstream extensions against the current role-specific toolsets; adopt when they reduce total tokens or round trips. Tool search is separate from conversation search. |

See [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
and [Pi telemetry](https://github.com/earendil-works/pi/tree/main/packages/telemetry).
Upstream interfaces are experimental; verify the pinned API before adopting one.
