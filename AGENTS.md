# Working on agent

Keep the application small and use upstream Pi for model and conversation
machinery. Rust owns application types; generate TypeScript protocol bindings.
Use explicit state and ownership transitions, with errors instead of panics.

Use Nix for development. Run formatting, Clippy and relevant behavioral tests.
Test real producers, consumers and lifecycle boundaries. Keep real accounts,
credentials, transcripts, hostnames and private configuration out of source,
fixtures and documentation. Examples must use invented data.

The product loads user instructions from the configured Codex AGENTS.md at
runtime. Never copy those instructions into this repository.
