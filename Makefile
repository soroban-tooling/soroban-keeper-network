# Soroban Keeper Network — common developer commands.
# Run `make help` for the list.

WASM := target/wasm32-unknown-unknown/release/keeper_registry.wasm

.PHONY: help build test fmt fmt-check lint coverage wasm optimize clean bot

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Build the workspace
	cargo build

test: ## Run the contract test suite
	cargo test -p keeper-registry

fmt: ## Format all Rust code
	cargo fmt --all

fmt-check: ## Check formatting (CI)
	cargo fmt --all -- --check

lint: ## Run clippy with warnings denied
	cargo clippy --all-targets -- -D warnings

coverage: ## Measure advisory Rust test coverage
	cargo llvm-cov --workspace --summary-only --ignore-filename-regex '(/src/test\.rs|/target/)'

wasm: ## Build the release WASM contract
	cargo build -p keeper-registry --target wasm32-unknown-unknown --release

optimize: wasm ## Build and optimize the WASM for deployment
	stellar contract optimize --wasm $(WASM)

bot: ## Run the example keeper bot
	cd examples/keeper-bot && npm start

clean: ## Remove build artifacts
	cargo clean
