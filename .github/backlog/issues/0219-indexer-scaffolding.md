---
title: "chore(indexer): scaffold the indexer service"
labels: [indexer, tooling, intermediate]
epic: E14
wave: 3
depends_on: [0218]
---

## Summary

Stands up the indexer as a runnable, empty service implementing whatever ingest mechanism issue 0218 decided, with no event-specific logic yet — the equivalent of issue 0051's fuzz-harness-setup for this epic: prove the plumbing works before building on it.

## Expected behaviour

A service that connects to a configured RPC endpoint and the configured database from issue 0218's design, runs an ingest loop (poll or subscribe per that decision), and logs each raw event it observes without parsing or storing it yet. This should be runnable against a local network with zero registry-specific code beyond a hardcoded contract id to filter on.

## Acceptance criteria

- [ ] Service connects to a local or testnet RPC endpoint and prints every raw event observed for a given contract id.
- [ ] Database connection and migration tooling is wired but the schema is still empty; issue 0220 fills it in.
- [ ] Configuration (RPC URL, contract id, database connection string) follows the same startup-validation discipline the keeper-bot's requireEnv established, failing loudly and specifically rather than crashing on first use.

## Files

- indexer/src/main.rs (or equivalent for the chosen language/runtime)
- indexer/README.md
