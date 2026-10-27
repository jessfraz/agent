# agent

An agent, regrettably.

A Rust CLI around [Pi Durable](https://github.com/earendil-works/pi), using a
ChatGPT plan and existing provider CLIs. Personal configuration and runtime
data stay outside the repository.

The first slice provides app-owned ChatGPT sign-in, persistent conversation
storage, quota reads through an installed Codex account, and mail reads across
configured Switchboard Google accounts. Rex task routing is being added next.

```text
  agent CLI -> Rust owner -> typed protocol -> Pi Durable -> local SQLite
                   |                              |
            existing provider CLIs        ChatGPT plan connection
```

Rust owns the wire types and generates TypeScript bindings and JSON schemas.
Pi owns conversation storage and model turns. A small OIDC adapter validates
identity tokens, retains the issued client registration, and refreshes the
app's own credentials. It never copies Codex credentials or falls back to an
API key. `agent usage` reads account quota through Codex's supported app-server;
it labels that source and reports the app-specific allowance as unavailable.

Run locally:

```sh
nix develop
make build
target/debug/agent login
target/debug/agent chat
target/debug/agent usage
target/debug/agent mail accounts
target/debug/agent mail search 'newer_than:1d'
```

`nix run` builds the packaged CLI and Pi runtime. Install the same package on
each device. Google access uses existing Switchboard configuration and sessions;
account identifiers and provider credentials do not belong in this repository.
Mail cursors are account-specific, and failed reads retain their coverage gaps.

The CLI loads `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md`, plus scoped project
instructions, before each turn. It reads those private files in place. State
lives in the OS application-data directory, or an explicit `--state-dir`, with
private permissions and a writer lock inherited by the Pi child.

The MVP will add named Rex task workers and durable mail follow-through, with
existing task lookup before creation. One selected coordinator owns the store;
cross-device replication, takeover, history import and reviewed learning come
later. Do not run simultaneous coordinators over a copied SQLite database.
See the [remaining MVP design](docs/architecture.md).

Run `make runtime check` inside the Nix shell. Tests use local issuers and
synthetic accounts; CI never needs personal credentials.
