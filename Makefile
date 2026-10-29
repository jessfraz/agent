.PHONY: bindings runtime build check

bindings:
	TS_RS_IMPORT_EXTENSION=js cargo run --bin export-protocol

runtime: bindings
	npm --prefix runtime ci --ignore-scripts
	npm --prefix runtime run build

build: runtime
	cargo build

check: runtime
	cargo fmt --check
	cargo clippy --all --benches --tests --examples --all-features -- -D warnings
	cargo build --example terminal-fixture
	cargo build --example browser_fixture
	cargo test
	npm --prefix runtime test
