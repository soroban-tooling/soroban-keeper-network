---
title: "feat(rust-sdk): typed client for the treasury contract"
labels: [rust-sdk, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0340, 0342, 0346, 0347]
---

## Summary

Adds a Rust client for the treasury contract, matching issue 0347's TypeScript coverage.

## Acceptance criteria

- [ ] All treasury entry points and views are wrapped.
- [ ] Error decoding integrates with the same typed error pattern issue 0200 established for the registry client.
- [ ] A test mirrors issue 0347's TypeScript test against the same scenario.

## Files

- rust-sdk/src/treasury_client.rs
