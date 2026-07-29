---
title: "feat(sdk-rust): KeeperRegistryClient struct wrapping RPC invocation"
labels: [enhancement, intermediate]
epic: E13
wave: 3
depends_on: [0197]
---

## Summary

The Rust equivalent of the TypeScript SDK's core client (issue 0153): a struct wrapping the simulate/sign/submit flow against the RPC client chosen in issue 0196, built against whichever sync-or-async decision issue 0197 settled on.

## Expected behaviour

```rust
let client = KeeperRegistryClient::new(contract_id, rpc_url, network_passphrase);
```

with shared internal plumbing for building, simulating, and (for mutating calls) signing and submitting a transaction, reusing `keeper_registry`'s own types (`Task`, `TaskType`, `TaskStatus`, `KeeperError`) directly wherever possible rather than redefining parallel structs -- since this crate can depend on `keeper-registry` directly (it's Rust, in the same workspace), it should not repeat the TypeScript SDK's need to hand-define a mirror of every contract type.

## Acceptance criteria

- [ ] Reuses `keeper_registry`'s own public types directly for every shared shape (Task, TaskType, TaskStatus, KeeperError) -- this is a meaningful advantage over the TypeScript SDK and should not be given up by redefining local copies.
- [ ] Shared read and mutating call plumbing implemented once, consistent with issue 0153's approach on the TypeScript side.
- [ ] A test against a real or local Soroban network exercises at least one read and one write.

## Files

- sdk/rust/src/client.rs
