# Soroban Keeper Network — common developer commands.
# Run `make help` for the list.
#
# IMPORTANT: The `ci` target must remain synchronized with the required CI jobs
# defined in .github/workflows/ci.yml (format, test, build-wasm). If CI workflow
# changes, update this Makefile accordingly, and vice versa.

WASM := target/wasm32-unknown-unknown/release/keeper_registry.wasm

.PHONY: help build test fmt fmt-check lint wasm optimize clean bot ci check

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

clean: ## Remove build artifacts
	cargo clean

ci: fmt-check test wasm ## Run all required CI checks locally (blocking checks only)

check: ci lint ## Run all checks contributors should run before opening a PR
