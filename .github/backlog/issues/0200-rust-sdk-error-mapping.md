---
title: "feat(sdk-rust): SdkError enum composing KeeperError with RPC/network failures"
labels: [enhancement, good-first-issue]
epic: E13
wave: 3
depends_on: [0197, 0198]
---

## Summary

Implements the error strategy issue 0197 designed: a superset error type every method in this crate (issue 0199 onward) returns, composing the contract's own `KeeperError` (reused directly, per issue 0198's type-reuse principle) with this crate's own RPC-layer and network failure modes.

## Expected behaviour

```rust
pub enum SdkError {
    Contract(keeper_registry::KeeperError),
    Network(/* underlying RPC client's error type or a wrapped variant */),
    Decode(String), // malformed response the RPC client itself didn't fail on but this SDK couldn't interpret
}
```

with a `From` implementation making `?`-based error propagation ergonomic throughout the rest of the crate, and a clear, documented distinction for callers between "the contract rejected this" (actionable, often expected) and "something went wrong reaching the network" (usually means retry).

## Acceptance criteria

- [ ] `KeeperError` variants are reachable through `SdkError` without the caller needing to know this crate's internal wrapping details to match on them.
- [ ] Every method from issue 0199 uses this type consistently.
- [ ] Documented with the same actionable-vs-transient framing the TypeScript SDK's error decoder (issue 0166) uses, for conceptual consistency across both SDKs even though the concrete types differ by language.

## Files

- sdk/rust/src/error.rs
