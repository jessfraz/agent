# Roadmap

Remaining work. The [architecture](architecture.md) describes ownership and
recovery; [history](history.md) describes import and retrieval.

## Finish the current pass

- [ ] Finish Codex catch-up and vector indexing, reconcile source coverage, and
  verify real searches. Missing files stay explicit gaps.
- [ ] Verify chat admission, steering, interruption, reopening and scrolling
  against a large live corpus while background work runs.
- [ ] Pin and activate scheduled-chat reuse and recovery through Global Nix;
  verify repeated runs reuse one chat and previously failed job lanes advance.
- [x] Ship private lifecycle logs, `/machines`, local usage-reset times and
  countdowns, and the remaining viewport correction.

## Inputs and automation

- [ ] `/goal` for persistent objectives, visible progress, pause/resume and
  completion tied to a verified outcome.
- [x] Ship hosted web search and page retrieval with source links for supported
  OpenAI models. The existing ChatGPT login has passed an isolated search,
  open-page and find-in-page check. Other providers need their own integration.
- [ ] Unattended Chrome browser tools as the last fallback after APIs and CLIs,
  using the selected host's existing signed-in profile, with owned tabs and
  interruption receipts. Authorization must survive new tasks and service or
  browser restarts without recurring consent clicks. Browser screenshot
  attachments remain unsupported.
- [x] A phone client for the main conversation, using the same submission,
  steering and queueing path as the CLI. The native iPhone app fulfills the
  planned WhatsApp/iMessage client use case.
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
  noise, malicious source instructions, duplicate events and source failures.
- [x] CLI startup and retained-history first-render benchmarks, with paired
  baseline comparisons and a separate CI regression gate.
- [ ] Benchmarks for input admission, first visible activity, steering/stop,
  long-history scrolling, search and import contention. Separate application
  delay from model latency; track CPU, RAM and token use.
- [x] Nightly operational log review through scheduled jobs, with coordinator
  collection, retained summaries and explicit coverage gaps.
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

The pinned Pi Durable package already supplies the foundation. These are
integration opportunities, not claims that the corresponding app UI exists.

| Upstream capability | Application use |
| --- | --- |
| Durable conversations, submissions and task checkpoints | Already used for history and execution; retain their native identities. |
| Steering, follow-ups, abort and compaction | Already used; keep transport and UI behavior aligned with them. |
| Durable sleeps and wake notifications | Use for scheduled work rather than another scheduler. |
| Typed telemetry and usage totals | Wire native phases and metrics into diagnostics and status. |
| Image readers and preparation workers | Reuse for image attachments; the app still owns file transfer. |
| Forks, child tasks and task graphs | Use for branching and richer session controls. |
| Deferred tool search and code mode | Evaluate if they reduce tool-context size or round trips. Tool search is not conversation search. |

See [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
and [Pi telemetry](https://github.com/earendil-works/pi/tree/main/packages/telemetry).
Upstream interfaces are experimental; verify the pinned API before adopting one.
