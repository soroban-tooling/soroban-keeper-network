---
title: "feat(rust-sdk): typed client methods for the staking entry points"
labels: [rust-sdk, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291, 0206]
---

## Summary

Extends the Rust SDK (epic E13) with the staking entry points, matching issue 0299's TypeScript coverage so neither SDK is left behind the other on the same contract surface.

## Acceptance criteria

- [ ] All new entry points and views from issues 0289, 0290, 0291, and 0297 are wrapped, following the argument-type discipline issue 0206's admin methods already established.
- [ ] Error decoding covers any new KeeperError variants this epic introduced, integrated into the same error type issue 0200 built rather than a separate one.
- [ ] A test mirrors issue 0299's TypeScript test against the same local-network scenario.

## Files

- rust-sdk/src/client.rs
- rust-sdk/tests/staking.rs
