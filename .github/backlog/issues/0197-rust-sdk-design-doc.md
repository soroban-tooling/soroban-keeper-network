---
title: "design(sdk-rust): sync vs async client and error-type strategy"
labels: [docs, intermediate]
epic: E13
wave: 3
depends_on: [0196]
---

## Summary

Before building out method wrappers, this issue settles two design questions the TypeScript SDK did not have to face in the same way: does this crate expose an async API (natural for RPC-bound work, but requires picking and depending on an async runtime like `tokio`) or a sync one (simpler for embedding in more contexts, at the cost of the caller managing blocking I/O themselves), and how should contract errors (`KeeperError`, already a Rust type importable directly from `contracts/keeper-registry`) be surfaced -- reused directly, or wrapped in an SDK-specific error type that also covers network/RPC-layer failures.

## Expected output

A design document deciding both questions, with the reasoning grounded in this crate's likely consumers (native services, other Soroban contracts' off-chain tooling, possibly the keeper-bot's ecosystem if a Rust-based keeper bot ever gets built per a future epic) rather than an abstract preference.

## Acceptance criteria

- [ ] Async-vs-sync decision made and justified against likely consumers.
- [ ] Error strategy decided: direct reuse of `keeper_registry::KeeperError` for contract-level failures (importable since it is already a public workspace crate type) composed into a superset SDK error enum that also covers RPC/network failures -- confirm this compiles and is ergonomic before committing to it in the design doc, not just in theory.

## Files

- sdk/rust/DESIGN.md
