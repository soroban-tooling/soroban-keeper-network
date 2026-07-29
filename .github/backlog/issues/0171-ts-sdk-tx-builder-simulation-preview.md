---
title: "feat(sdk-ts): expose a pre-submission simulation preview (resource cost, expected result)"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0170]
---

## Summary

Building on issue 0170's unsigned-transaction path: before a wallet user signs anything, a dApp typically wants to show them what will happen and what it will cost. This issue exposes that preview directly, rather than making every consumer re-simulate manually.

## Expected behaviour

`client.previewTransaction(methodName, params)` returning the simulated result (what the call would return if submitted now, useful for read-only-shaped confirmation UIs) alongside the estimated resource cost (CPU instructions, fee) from the simulation response, without requiring a signer at all — a preview should work for a read-only wallet connection too.

## Acceptance criteria

- [ ] Preview works without any signer present.
- [ ] Resource cost figures are extracted from the actual simulation response fields (verify the exact field names/shape against a real Soroban RPC response, do not guess).
- [ ] Test confirms preview output for both a call that would succeed and one that would fail, with the failure surfaced via the typed error decoder from issue 0166.

## Files

- packages/sdk-ts/src/transactionBuilder.ts
