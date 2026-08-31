---
title: "feat(governance): the KPRS token contract"
labels: [contract, enhancement, advanced]
epic: E09
wave: 4
depends_on: [0360]
---

## Summary

Implements the governance token itself, per issue 0360's supply and distribution decisions. This is likely a standard fungible token (Soroban's token interface, the same interface the existing reward_token already implements against for XLM/SAC tokens) rather than a bespoke design, unless issue 0360 specifically called for non-standard behavior (non-transferability during a vesting period, for instance).

## Acceptance criteria

- [ ] The contract implements the standard Soroban token interface, so existing wallet and SDK tooling that already understands that interface works with it without modification.
- [ ] Initial distribution matches issue 0360's decisions exactly, verified by a test checking balances immediately after deployment.
- [ ] If any allocation vests, the vesting schedule is enforced on-chain (transfers of unvested tokens rejected), not merely documented as a social commitment.

## Files

- contracts/governance-token/src/lib.rs
- contracts/governance-token/src/test.rs
