# CLI performance

The separate **CLI performance** CI job compares a change with its pull request
base or previous main commit on the same runner. It builds both in release mode,
alternates baseline and candidate launches, and saves every timing in JSON.

The clock starts before launching the real CLI through the existing PTY fixture.
It stops when a sentence from persisted conversation history appears in the
terminal's visible cells. A `vt100` screen parser applies cursor movement,
clearing and wrapping. A menu, composer, ANSI-stripped byte match, or text already
scrolled offscreen does not satisfy the measurement.

Current scenarios open the chief's 40-message history with cold and warm
coordinators, and resume a saved 5,000-message conversation. The corpus also
contains 3,000 unrelated saved discussions. All use real Pi/SQLite storage,
the coordinator, native history pagination and the regular TUI. Each version
runs its own Rust
coordinator and TypeScript runtime. Seeding and coordinator startup
are outside the timed interval. Every CLI launch is fresh. The cold scenario
also starts a fresh service for each sample; other scenarios retain theirs.
The first pair warms the services and is recorded but excluded from the gate.
The isolated environment exposes only Node on PATH, and provider requests are
rejected. No model, credentials, network provider or Rex is involved. `/resume`
opens saved history and `/exit` closes each sample; no model prompt is submitted.

Seven measured pairs run per scenario. Each candidate gets the greater of a
25% or 20-millisecond allowance over its paired baseline. CI fails when the
median fraction of that budget exceeds 1. Pairing prevents uneven runner
stalls from turning separate medians into a false regression.
There are no automatic retries or discarded slow samples. A missing conversation
or failed CLI also fails the job. `performance/results.json` contains the raw
samples and thresholds. A JSONL file retains completed samples if a later run
fails; a failure JSON records the error.

Run locally after building both revisions' runtime and CLI:

```sh
nix develop --command cargo build --release --bin beep-boop \
  --example terminal-fixture --example cli-performance
nix develop --command target/release/examples/cli-performance \
  --baseline /path/to/base/target/release/beep-boop \
  --baseline-runtime /path/to/base/runtime/dist/src/bridge.js \
  --candidate target/release/beep-boop \
  --candidate-runtime runtime/dist/src/bridge.js \
  --terminal target/release/examples/terminal-fixture \
  --seed runtime/dist/test/fixtures/performance.js \
  --output performance/results.json
```

Add a scenario to the typed `Scenario` enum in `examples/cli_performance.rs` and
seed its synthetic retained data in `runtime/test/fixtures/performance.ts`.
The paired sampling and regression gate apply to every enum variant. Keep
conversation text synthetic and test the real path the scenario is measuring.

The same job measures native search and cached indexing against 16,384
file-backed chunks with 1,024-dimensional synthetic vectors. Dense retrieval,
full-text retrieval with hydration, and vector-cache reuse have separate paired
measurements. Seeding and inference stay outside the clock; each sample checks
ranking, hydrated text and provenance against the other revision. Query samples
contain eight lookups; cached-index samples contain four updates. The same
paired-budget gate applies. Both reports use schema 2 and retain the raw
medians alongside the paired budget score. Native results are in
`performance/search.json` and JSONL.

Run that comparison after building both runtimes:

```sh
nix develop .#ci --command node runtime/dist/test/fixtures/search-performance.js \
  --baseline /path/to/base/runtime/dist/src/search.js \
  --candidate runtime/dist/src/search.js \
  --output performance/search.json
```

Add native scenarios to `runtime/test/fixtures/search-performance.ts`. Keep
setup outside timing and verify the actual result as well as its latency.
These synthetic measurements complement live corpus latency and retrieval
recall checks.

## Source journal

Source decisions use Pi's native deltas. Rewriting a full retained journal on
each decision blocks unrelated settings reads on the shared commit queue.
The runtime regression verifies bounded persisted decision bytes, concurrent
settings reads, atomic decisions, original versions and replay after reopening.
It covers the former 64-delta checkpoint boundary. CI uses a 4 MiB synthetic
journal; the same test accepts a larger qualification corpus:

```sh
nix develop .#ci --command env AGENT_SOURCE_JOURNAL_BYTES=366639229 \
  node --test runtime/dist/test/source-journal-performance.test.js
```

Local qualification with 366.7 MB of synthetic evidence reduced a settings read
beside a decision from 1,603 ms to 5.6 ms. At 65 decisions, the read took 5.3 ms
and cold replay took 224 ms. These timings are observations, not CI thresholds;
CI rejects a decision that rewrites the corpus instead of a bounded delta.

The delta tail grows until a future compaction mechanism is provided. Replay
cost beyond the qualified tail remains unmeasured; initial creation still
writes a complete base. No schema or data migration is required.
