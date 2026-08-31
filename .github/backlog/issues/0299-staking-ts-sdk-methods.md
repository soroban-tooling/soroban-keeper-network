---
title: "feat(ts-sdk): typed client methods for the staking entry points"
labels: [ts-sdk, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291, 0297]
---

## Summary

Extends the TypeScript SDK (epic E12) with client methods for stake_deposit, initiate_unbond, withdraw_stake, and the read-only staking views, following the same client-method conventions the rest of the SDK already established for the core task lifecycle.

## Acceptance criteria

- [ ] All new entry points and views from issues 0289, 0290, 0291, and 0297 are wrapped.
- [ ] Typed error decoding covers any new KeeperError variants this epic introduced.
- [ ] A test against a local network deposits, unbonds, and withdraws stake, and confirms the SDK's view methods agree with the contract's own state at each step.

## Files

- ts-sdk/src/client.ts
- ts-sdk/test/staking.test.ts
