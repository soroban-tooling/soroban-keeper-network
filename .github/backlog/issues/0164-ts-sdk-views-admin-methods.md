---
title: "feat(sdk-ts): read-only view methods -- admin, getFeeBps, isPaused, feesAccrued, rewardTokenAddress, minReward, version"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

The remaining contract-level (as opposed to per-task) read-only views.

## Expected behaviour

`client.admin()` returning `string | undefined` (matching the contract's `Option<Address>`, correctly representing an uninitialized registry rather than throwing), `client.getFeeBps()`, `client.isPaused()`, `client.feesAccrued()`, `client.rewardTokenAddress()`, `client.minReward()`, `client.version()` — the last of which the SDK should itself check against its own known-compatible contract version range and warn (not necessarily throw) if the deployed contract reports a version the SDK was not built against, per issue 0192's versioning policy.

## Acceptance criteria

- [ ] `admin()` on an uninitialized registry returns `undefined`, not an error, matching the contract's own view-never-errors policy from wave 1's issue 8.
- [ ] `version()` includes the SDK-vs-contract compatibility check and a clear warning path.
- [ ] All methods tested against both a fresh (uninitialized where applicable) and a fully configured registry.

## Files

- packages/sdk-ts/src/methods/views.ts
