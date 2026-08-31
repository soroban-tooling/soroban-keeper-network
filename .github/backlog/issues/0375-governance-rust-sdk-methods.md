---
title: "feat(rust-sdk): typed client for the governance contract"
labels: [rust-sdk, enhancement, advanced]
epic: E09
wave: 4
depends_on: [0363, 0364, 0367, 0370, 0374]
---

## Summary

Adds a Rust client for governance, matching issue 0374's TypeScript coverage.

## Acceptance criteria

- [ ] All governance entry points and views are wrapped.
- [ ] Error decoding integrates with the shared typed error pattern from issue 0200.
- [ ] A test mirrors issue 0374's end-to-end scenario.

## Files

- rust-sdk/src/governance_client.rs
