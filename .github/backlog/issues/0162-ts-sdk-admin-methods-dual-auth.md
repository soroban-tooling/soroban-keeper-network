---
title: "feat(sdk-ts): admin methods requiring dual authorization -- transferAdmin, upgrade, sweepFees"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Split from issue 0161 because `transferAdmin` has a materially different signing shape: it requires two separate signatures (current admin and incoming admin) in one transaction, which the SDK's transaction-building layer needs to support explicitly rather than assuming a single signer, as the rest of this epic's methods do.

## Expected behaviour

`client.transferAdmin({ currentAdmin, newAdmin })` accepting two distinct signers (however this SDK's signing abstraction works — coordinate with issue 0189's signing-flow design) and building a transaction both must sign before submission, following the pattern wave-1's `test_transfer_admin_succeeds_with_both_auths_explicit` test proved out at the contract level. `client.upgrade({ admin, newWasmHash })` and `client.sweepFees({ admin, treasury, amount })` are single-signer and simpler, included here for shared review since all three are "the remaining admin functions."

## Acceptance criteria

- [ ] `transferAdmin` correctly builds and requires two signatures, tested against both a single-signer failure and a correct dual-signer success.
- [ ] `sweepFees` rejects non-positive `amount` and over-accrued-amount client-side where cheaply checkable.
- [ ] `upgrade` accepts a `newWasmHash` typed as a 32-byte value with a clear error for the wrong length, not a cryptic contract-side failure.

## Files

- packages/sdk-ts/src/methods/adminDualAuth.ts
