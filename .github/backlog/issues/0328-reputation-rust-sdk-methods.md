---
title: "feat(rust-sdk): typed client methods for reputation views"
labels: [rust-sdk, enhancement, good-first-issue]
epic: E07
wave: 4
depends_on: [0320, 0207]
---

## Summary

Extends the Rust SDK with the reputation view from issue 0320, matching issue 0327's TypeScript coverage.

## Acceptance criteria

- [ ] keeper_reputation is wrapped following the same view-method conventions issue 0207 established.
- [ ] A test mirrors issue 0327's TypeScript test against the same scenario.

## Files

- rust-sdk/src/client.rs
