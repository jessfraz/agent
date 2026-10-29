# CLI performance

The separate **CLI performance** CI job compares a change with its pull request
base or previous main commit on the same runner. It builds both in release mode,
alternates baseline and candidate launches, and saves every timing in JSON.

The clock starts before launching the real CLI through the existing PTY fixture.
It stops when a sentence from persisted conversation history appears in the
terminal's visible cells. A `vt100` screen parser applies cursor movement,
clearing and wrapping. A menu, composer, ANSI-stripped byte match, or text already
scrolled offscreen does not satisfy the measurement.

Current scenarios open the chief's 40-message history and resume a saved
5,000-message conversation. Both use real Pi/SQLite storage, the coordinator,
native history pagination and the regular TUI. Each version runs its own Rust
coordinator and TypeScript runtime. Seeding and coordinator startup
are outside the timed interval. Every CLI launch is fresh; services stay running.
The first pair warms the services and is recorded but excluded from the gate.
The isolated environment exposes only Node on PATH, and provider requests are
rejected. No model, credentials, network provider or Rex is involved. `/resume`
opens saved history and `/exit` closes each sample; no model prompt is submitted.

Seven measured pairs run per scenario. CI fails when the candidate's median
exceeds both 125% of the baseline median and the baseline plus 20 milliseconds.
There are no automatic retries or discarded slow samples. A missing conversation
or failed CLI also fails the job. `performance/results.json` contains the raw
samples and thresholds. A JSONL file retains completed samples if a later run
fails; a failure JSON records the error.

Run locally after building both revisions' runtime and CLI:

```sh
nix develop --command cargo build --release --bin agent \
  --example terminal-fixture --example cli-performance
nix develop --command target/release/examples/cli-performance \
  --baseline /path/to/base/target/release/agent \
  --baseline-runtime /path/to/base/runtime/dist/src/bridge.js \
  --candidate target/release/agent \
  --candidate-runtime runtime/dist/src/bridge.js \
  --terminal target/release/examples/terminal-fixture \
  --seed runtime/dist/test/fixtures/performance.js \
  --output performance/results.json
```

Add a scenario to the typed `Scenario` enum in `examples/cli_performance.rs` and
seed its synthetic retained data in `runtime/test/fixtures/performance.ts`.
The paired sampling and regression gate apply to every enum variant. Keep
conversation text synthetic and test the real path the scenario is measuring.
