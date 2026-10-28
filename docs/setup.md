# Setup

Install [Rex](https://www.superlogical.com/rex) and Tailscale on each execution
machine. Connect them to the same authorized tailnet. Provider CLIs keep their
own accounts and credentials; agent does not duplicate that setup.

## Coordinator

Choose one machine that stays on. It owns conversations, shared settings,
background intake and the main agent.

```sh
nix profile add github:jessfraz/agent
agent init
agent serve
```

`agent init` creates `~/.config/agent/config.toml` with private permissions and
refuses to overwrite an existing file.

`agent serve` listens on the native Tailscale interface at port 43187 and a
private local Unix socket. Leave it running, then use another terminal:

```sh
agent login
agent status
agent chat
```

Start the service before login. Otherwise the CLI starts a local-only daemon,
which owns the same database and prevents a second coordinator from starting.
A Nix service also satisfies this ordering. `agent login` opens ChatGPT
sign-in; complete any identity check in the browser. Credentials are stored
privately and refreshed by the app. No Codex credential copying is required.

ChatGPT is the default provider. A signed-out chat reports `Not signed in to
ChatGPT. Run agent login.` Other Pi providers can use their supported
environment or ambient credentials. Agent does not provide an interactive
login flow for every provider.

## Worker or CLI client

On another execution machine:

```sh
nix profile add github:jessfraz/agent
agent init --coordinator tailscale://100.64.0.10
agent serve
```

Replace the invented address with the coordinator's native Tailscale IPv4
address. The port is optional. The worker announces its native Rex identity
and local launch paths, and keeps a reverse connection to the coordinator.
Rex host labels and endpoints are reused when present in its shared host
inventory; a machine can also announce its own native Rex metadata. There is
no second host list to maintain in agent settings.

Use `agent chat` from any directory in another terminal. It always reaches the
configured coordinator. Caller project information accompanies the request;
shared context and conversation storage stay on the coordinator. `agent nodes`
shows registered machines and which are online.

`agent` opens that same saved main conversation. Recent messages appear on
startup; `/history` reads older pages and `/exit` detaches. Task sessions open
directly into an interactive `Chat` tab. Reply there or through the main agent;
both use the same task conversation. Named child tabs return results while
remaining available for follow-ups. Live activity shows tool names and exposed
provider thinking text.

TTY sessions use a Markdown TUI with model, reasoning, directory and activity
status. Enter steers active work; Tab queues a separate follow-up turn. Queued
messages run in order. Esc stops, and Shift+Enter or Alt+Enter inserts a newline.
Pi's compaction shows as **Compacting context**; current instructions reload
before the next model round.
Select transcript text with the terminal's normal copy/paste controls;
PgUp/PgDn scroll the transcript. `/history` or Ctrl+R loads older messages, and
`/exit` detaches. Use `agent --no-tui chat` for plain output or `agent --json chat`
for protocol events.

`/feedback <description>` saves private diagnostics and starts a background
repair worker on the originating machine. A repair started inside Rex uses a
named terminal in that folder; later reports reuse the repair task. From a raw
CLI, the first report creates its repair session. Results appear in the saved
main chat. `agent feedback latest` and `agent feedback show <id>` read captures;
they are never uploaded automatically.

Import existing local Codex conversations after both services are connected:

```sh
agent import codex
agent import status
agent history search "supplier fabrication question"
agent history read CONVERSATION_ID
agent history open CONVERSATION_ID
```

The import creates no Rex sessions. Rerun the same command to resume partial
reads and catch up changed conversations. `--host NAME` limits an import to a
registered host. An unavailable source is reported as partial coverage, not
silently skipped. [History](history.md) describes storage and retrieval.

A CLI-only client uses the same `agent init --coordinator ...` command and
skips the service. Phone access is the Rex phone CLI connected to one of these
machines, running the same `agent chat` command.

If the coordinator is unavailable, chat reports the failure. If a worker goes
offline, its tasks remain assigned to it. The MVP does not transfer live work
or synchronize the database between machines.

## Trust

Both ends verify native Tailscale peer identity. The listener never binds to a
LAN or wildcard address. By default, authorized untagged devices belonging to
the same user are accepted. For a tagged server, set `trusted_nodes` on both
ends to the exact stable node IDs allowed to connect. A nonempty list replaces
the default same-user rule.

When a machine has both GUI and system Tailscale daemons, set
`tailscale_socket` to the intended daemon's socket. Identity checks and
connections use that selection. Rex's embedded Tailscale identity is distinct
from the native daemon identity used by agent.

## Settings and sources

The commented [coordinator example](../examples/coordinator.toml) is parsed by
the same strict configuration loader as the CLI and exercised in tests. The
[client example](../examples/client.toml) is sufficient for workers and
terminals. Configuration is TOML, not JSON.

Set `context_repositories = ["~/context"]` on the coordinator to make an
existing private Git repository available to every chat. Agent loads its
`AGENTS.md` and offers bounded read/search tools for relevant files. It does
not change the caller's working directory or require clients to copy the repo.

`[model]` controls defaults for new work. `provider` and `reasoning` are typed;
Pi validates the model ID. Omit reasoning to use the provider's default.
`fast = true` requests OpenAI priority service where supported; unsupported
choices fail explicitly. See the official
[fast-mode guide](https://developers.openai.com/api/docs/guides/fast-mode).
Existing tasks keep their saved selection.

Sources are optional `[[sources]]` entries. Set `enabled = false` to skip a feed
without even discovering its accounts. An empty list disables external intake;
internal task outcomes remain available.

| Source | Existing authenticated tools |
| --- | --- |
| `google` | Switchboard Google namespaces and `gws` |
| `google_calendar` | Switchboard Google namespaces and `gws` |
| `github` | Switchboard GitHub namespaces and `gh` |
| `slack` | Configured read-only CLI command |
| `messages` | Switchboard Messages namespaces, or local macOS `messages` |

Omitting `namespaces` discovers all configured accounts for that provider.
An explicit selection never falls back to another account. Slack additionally
needs its account and command prefix. The source command must be available in
the service's PATH. `agent sources` reports coverage and checkpoints; an access
failure is not an empty inbox.

Messages reads run headlessly through the local Rex Server, using its macOS
Full Disk Access grant. Enable access for Rex Server once in System Settings;
agent binaries do not need their own grant. No sessions or terminals are created
for polling. The agent's literal `messages doctor`, `messages chats`, and
`messages read` commands, including their Switchboard equivalents, use the
same reader. Their working directory, deadline, diagnostics and output limits
are preserved. Commands run directly in an unrelated shell still use that
shell's macOS permission context.

With Messages enabled, the coordinator installs the small Rex action module at
startup, and workers check it when connecting using the coordinator's settings.
Existing Rex configuration is preserved; an unchanged module causes no reload.
Setup can also be run explicitly:

```sh
agent rex install
```

If Rex configuration is managed elsewhere, include `require('agent_messages')`
through that owner. The command reports any setup failure and preserves the
existing configuration; other sources and chat can continue.

`agent usage` reads quota from the installed, signed-in Codex app-server. Its
reported account should match the intended plan. This integration does not
expose a separate quota for agent, and requires Codex independently.

## nix-darwin service

The flake exports `darwinModules.default`. Import it and reference a private
configuration file that already exists outside the Nix store:

```nix
{
  imports = [ inputs.agent.darwinModules.default ];
  services.agent = {
    enable = true;
    role = "coordinator"; # Use "worker" on the other machines.
    configFile = "/Users/example/.config/agent/config.toml";
    workingDirectory = "/Users/example";
    extraPackages = [ pkgs.gh pkgs.tailscale ];
  };
}
```

Include Rex, Switchboard and enabled provider CLIs in `extraPackages` as well.
The worker's TOML must set `coordinator`; the coordinator's must omit it.
Model settings, source configuration, credentials and context stay in private
runtime files. Restart the service after changing its settings.

For generated preferences, `agent config apply preferences.toml` updates only
the supplied model, context repositories, sources or polling interval in the
existing private configuration. Connection and trust settings remain local.
Invalid preferences leave the file untouched; repeated applications are a
no-op. This allows Nix to manage shared preferences without publishing machine
connection details or credentials.
