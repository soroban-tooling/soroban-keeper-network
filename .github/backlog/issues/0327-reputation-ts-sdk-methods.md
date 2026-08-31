---
title: "feat(ts-sdk): typed client methods for reputation views"
labels: [ts-sdk, enhancement, good-first-issue]
epic: E07
wave: 4
depends_on: [0320]
---

## Summary

Extends the TypeScript SDK with the reputation view from issue 0320, following the SDK's existing view-wrapping conventions.

## Acceptance criteria

- [ ] keeper_reputation is wrapped with the correct return type, including the decayed value if issue 0321's decay is read-time computed.
- [ ] A test confirms the SDK's returned value matches the contract's own view for a keeper with a nontrivial history.

## Files

- ts-sdk/src/client.ts
