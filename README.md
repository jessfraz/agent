# agent

An agent, regrettably.

A Rust CLI around [Pi Durable](https://github.com/earendil-works/pi), with
ChatGPT plan sign-in, persistent conversations and workers in
[Rex](https://www.superlogical.com/rex). One main conversation finds existing
work before starting another task.

```text
  phone CLI / laptop CLI / desktop CLI
                    |
          selected coordinator
          Pi Durable + SQLite
            /             \
     desktop Rex        laptop Rex
     task session       task session
     + Implementation   + Implementation
     + Review           + Checks
     + Checks

  mail / Slack -> durable inbox -> related task -> brief update
```

Each task gets one named Rex session on the machine doing the work. Its
subagents get named terminals inside that session. The main chat receives
results, so switching between task chats is optional. Phone access uses the
existing Rex phone CLI.

Rex owns terminals and sessions. The coordinator owns conversations, tasks and
background intake. Only one machine runs the coordinator; the others connect
to it over Tailscale.

```sh
nix profile add github:jessfraz/agent
agent login
agent chat
agent usage
agent tasks list
agent sources
agent mail accounts
```

Install the same package on both machines. Put private configuration in
`~/.config/agent/config.json`, using [this example](examples/config.json) as a
starting point. On the coordinator, run `agent serve --tailnet-port 43187`.
Other machines set `coordinator` to its `tailscale://IP:43187` address. Both
ends require Tailscale; the listener binds only to its native Tailscale
interface. By default, only authorized, untagged devices of the same user are
trusted. Tagged servers use an explicit `trusted_nodes` list of Tailscale stable
node IDs on both ends. A nonempty list replaces same-user trust. Existing SSH
hosts are also supported.
Set `tailscale_socket` when a machine has both GUI and system daemons;
the explicit socket selects the daemon used for every identity check.

Rex, Tailscale and provider CLIs remain separately installed. Google accounts
come from Switchboard; selecting the Google source with `namespaces: null`
discovers all configured Google namespaces. Slack uses a configured read-only
CLI command. Calendar and GitHub sources use the existing `gws` and `gh` CLIs
through Switchboard. Remove an entry from `sources` to disable it; an empty list
disables intake. Failed reads remain visible as coverage gaps. Only the selected
coordinator polls sources and owns conversation state.

The CLI reads `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md`, then scoped
project instructions, before user turns and worker startup. Credentials,
configuration and conversation data stay outside this repository. `agent usage`
reads the installed Codex account's quota; it cannot report a separate allowance
for this app.

Owned worktrees have a durable inventory: `agent resources list` shows them;
`agent resources collect` uses the installed guarded `git cleanup` workflow.
Collection requires merged, clean, inactive work and preserves held or partial
results for inspection. Tasks can own multiple worktrees; the inventory groups
them by task and retains each checkout's path, host and cleanup state. An
unavailable cleanup helper leaves work held.
The coordinator checks every five minutes; other hosts run `agent maintain`
against that coordinator to collect their local resources.

The [architecture](docs/architecture.md) covers ownership, source intake and
later recovery, import, speech input and reviewed learning. The
[nix-darwin module](nix/module.nix) runs the coordinator as a user service.

For development:

```sh
nix develop
make runtime check
nix build
```

Rust generates the runtime's TypeScript bindings and JSON schemas. CI runs
behavior tests and package builds on Linux and macOS without personal accounts.
