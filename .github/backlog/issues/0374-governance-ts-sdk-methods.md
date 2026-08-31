---
title: "feat(ts-sdk): typed client for the governance contract"
labels: [ts-sdk, enhancement, advanced]
epic: E09
wave: 4
depends_on: [0363, 0364, 0367, 0370]
---

## Summary

Adds a TypeScript client covering proposal creation, voting, execution, and the read-only views, following the SDK's established client conventions, as its own client type distinct from the registry and treasury clients.

## Acceptance criteria

- [ ] All governance entry points and views are wrapped with correct types matching the enumerated proposal types from issue 0363.
- [ ] Typed error decoding covers the governance contract's own error enum.
- [ ] An end-to-end test against a local network creates, votes on, waits out the timelock for, and executes a proposal, confirming the SDK correctly observes each state transition.

## Files

- ts-sdk/src/governance-client.ts
- ts-sdk/test/governance.test.ts
