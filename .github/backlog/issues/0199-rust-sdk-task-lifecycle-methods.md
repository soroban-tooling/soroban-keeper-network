---
title: "feat(sdk-rust): task lifecycle methods -- register, claim, execute, cancel, expire, withdraw"
labels: [enhancement, intermediate]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The core task-lifecycle method wrappers, grouped into one issue (unlike the TypeScript SDK's more granular per-method issues) since Rust's stronger type system and direct reuse of `keeper_registry`'s types (per issue 0198) make each wrapper considerably thinner than its TypeScript equivalent -- there is less unique design surface per method to warrant separate issues at this stage of the epic.

## Expected behaviour

`client.register_task(...)`, `client.claim_task(...)`, `client.execute_task(...)`, `client.cancel_task(...)`, `client.expire_task(...)`, `client.withdraw_rewards(...)`, each returning `Result<T, SdkError>` using the error strategy from issue 0197, with method signatures mirroring the contract's own function signatures as closely as Rust idiom allows (builder pattern or plain positional arguments -- decide based on the same "too many arguments" consideration the contract's own `register_task` doc comment already reasons about, and be consistent with that reasoning rather than contradicting it).

## Acceptance criteria

- [ ] All six methods implemented with consistent error handling per issue 0197's design.
- [ ] Signatures reviewed against the contract's own argument-count reasoning (the `#[allow(clippy::too_many_arguments)]` comment on `register_task`) for consistency of philosophy, even if the concrete Rust API shape differs.
- [ ] Tests cover the full lifecycle end to end against a local or real network.

## Files

- sdk/rust/src/methods.rs
