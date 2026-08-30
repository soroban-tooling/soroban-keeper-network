# Soroban Keeper Network — common developer commands.
# Run `make help` for the list.
#
# IMPORTANT: The `ci` target must remain synchronized with the required CI jobs
# defined in .github/workflows/ci.yml (format, test, build-wasm, sdk-ts, bot,
# indexer — this comment previously listed only the first three, already out
# of sync with `bot` having been required in CI before this file was touched;
# `sdk-ts`, `indexer`, and that pre-existing gap are all reflected here now).
# If CI workflow changes, update this Makefile accordingly, and vice versa.

WASM := target/wasm32-unknown-unknown/release/keeper_registry.wasm

# Where the indexer's database-backed tests look for a Postgres. Unset by
# default: without it those tests skip themselves, so `make ci` stays green on
# a machine with no database. Override to run them for real, e.g.
#   make indexer INDEXER_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/indexer_test
INDEXER_TEST_DATABASE_URL ?=

.PHONY: help build test fmt fmt-check lint wasm optimize clean bot bot-test sdk-ts indexer ci check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Build the workspace
	cargo build

test: ## Run the contract test suite (matches CI)
	cargo test --workspace --locked

fmt: ## Format all Rust code
	cargo fmt --all

fmt-check: ## Check formatting (matches CI)
	cargo fmt --all -- --check

lint: ## Run clippy with warnings denied (stricter than CI)
	cargo clippy --all-targets -- -D warnings

wasm: ## Build the release WASM contract (matches CI)
	cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry

optimize: wasm ## Build and optimize the WASM for deployment
	stellar contract optimize --wasm $(WASM)

bot: ## Run the example keeper bot
	cd examples/keeper-bot && npm start

indexer: ## Format-check, build and test the indexer (matches CI)
	cargo fmt --package keeper-indexer -- --check
	cargo build --package keeper-indexer --locked
	INDEXER_TEST_DATABASE_URL=$(INDEXER_TEST_DATABASE_URL) \
		cargo test --package keeper-indexer --locked

sdk-ts: ## Build and test the TypeScript SDK (matches CI)
	cd packages/sdk-ts && npm install --no-audit --no-fund && npm run build && npm test && npm run lint

bot-test: sdk-ts ## Build the SDK then run the keeper bot's tests (matches CI) — bot depends on sdk-ts's dist/ output
	cd examples/keeper-bot && npm install --no-audit --no-fund && npm test && npm run lint

clean: ## Remove build artifacts
	cargo clean

ci: fmt-check test wasm sdk-ts bot-test indexer ## Run all required CI checks locally (blocking checks only)

check: ci lint ## Run all checks contributors should run before opening a PR
