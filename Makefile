# Soroban Keeper Network — common developer commands.
# Run `make help` for the list.
#
# IMPORTANT: The `ci` target must stay in sync with the required jobs in
# .github/workflows/ci.yml (format, test, build-wasm, sdk-ts, bot, bot-v2,
# indexer, rust-sdk, indexer-client). Change one, change the other.

WASM := target/wasm32-unknown-unknown/release/keeper_registry.wasm

# Where the indexer's database-backed tests look for a Postgres. Unset by
# default: without it those tests skip themselves, so `make ci` stays green on
# a machine with no database. Override to run them for real, e.g.
#   make indexer INDEXER_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/indexer_test
INDEXER_TEST_DATABASE_URL ?=

# Packages `make setup` installs dependencies for. Each needs a package-lock.json
# so `npm ci` can run; add new packages here when they gain one.
SETUP_PACKAGES := packages/sdk-ts packages/indexer-client examples/keeper-bot examples/keeper-bot-v2 examples/batch-register

.PHONY: help build test fmt fmt-check lint wasm optimize clean setup bot bot-test bot-v2-test sdk-ts sdk-ts-lint indexer rust-sdk indexer-client ci check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Install the wasm target and npm dependencies, and report missing system tools
	@command -v rustup >/dev/null 2>&1 || { echo "setup: rustup is required, see https://rustup.rs"; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "setup: npm is required, see https://nodejs.org"; exit 1; }
	rustup target add wasm32-unknown-unknown
	@for pkg in $(SETUP_PACKAGES); do \
		echo "==> npm ci in $$pkg"; \
		(cd "$$pkg" && npm ci --no-audit --no-fund) || { echo "setup: npm ci failed in $$pkg"; exit 1; }; \
	done
	@echo ""
	@echo "System tools:"
	@missing=0; \
	if command -v stellar >/dev/null 2>&1; then echo "  ok       stellar"; \
	else echo "  MISSING  stellar  (cargo install --locked stellar-cli --features opt; needed for make optimize and deploys)"; missing=1; fi; \
	if command -v docker >/dev/null 2>&1; then echo "  ok       docker"; \
	else echo "  MISSING  docker   (needed only for the indexer's Postgres tests, see docs/CI.md)"; missing=1; fi; \
	if [ $$missing -eq 1 ]; then echo "Setup finished, but some system tools above are missing."; fi

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

wasm: ## Build the release WASM contracts (matches CI)
	cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
	cargo build --locked --release --target wasm32-unknown-unknown --package keeper-treasury

optimize: wasm ## Build and optimize the WASM for deployment
	stellar contract optimize --wasm $(WASM)

bot: ## Run the example keeper bot
	cd examples/keeper-bot && npm start

indexer: ## Format-check, build and test the indexer (matches CI)
	cargo fmt --package keeper-indexer -- --check
	cargo build --package keeper-indexer --locked
	INDEXER_TEST_DATABASE_URL=$(INDEXER_TEST_DATABASE_URL) \
		cargo test --package keeper-indexer --locked

sdk-ts: ## Typecheck, build and test the TypeScript SDK (matches the required CI job)
	cd packages/sdk-ts && npm ci --no-audit --no-fund && npx tsc --noEmit -p tsconfig.json && npm run build && npm test

sdk-ts-lint: ## ESLint the TypeScript SDK (advisory in CI, so not part of `make ci`)
	cd packages/sdk-ts && npm ci --no-audit --no-fund && npm run lint

bot-test: sdk-ts ## Build the SDK then run the keeper bot's tests (matches CI) — bot depends on sdk-ts's dist/ output
	cd examples/keeper-bot && npm ci --no-audit --no-fund && npm test && npm run lint

bot-v2-test: sdk-ts ## Build the SDK then build, test and lint keeper-bot-v2 (matches CI)
	cd examples/keeper-bot-v2 && npm ci --no-audit --no-fund && npm run build && npm test && npm run lint

rust-sdk: ## Test the Rust SDK crate (matches CI)
	cargo test --package soroban-keeper-sdk --locked

indexer-client: ## Typecheck, build, test and lint the indexer client (matches CI)
	cd packages/indexer-client && npm ci --no-audit --no-fund && npx tsc --noEmit -p tsconfig.json && npm run build && npm test && npm run lint

clean: ## Remove build artifacts
	cargo clean

ci: fmt-check test wasm sdk-ts bot-test bot-v2-test indexer rust-sdk indexer-client ## Run all required CI checks locally (blocking checks only)

check: ci lint sdk-ts-lint ## Run all checks contributors should run before opening a PR
