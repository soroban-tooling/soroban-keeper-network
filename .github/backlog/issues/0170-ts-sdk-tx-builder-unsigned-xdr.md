---
title: "feat(sdk-ts): expose unsigned transaction XDR for wallet-signing flows"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Every method built so far (0154-0164) assumes the SDK itself has access to a signer (a secret key, typical of a server-side keeper bot). A browser dApp using a wallet extension (Freighter, etc.) needs the opposite flow: build an unsigned transaction, hand its XDR to the wallet for signing, then submit the signed result — the SDK should never see the user's private key.

## Expected behaviour

A lower-level `client.buildTransaction(methodName, params)` returning unsigned XDR plus enough metadata (which accounts need to sign) for a caller to drive their own wallet-signing flow, and a `client.submitSignedTransaction(signedXdr)` to complete it. The existing per-method wrappers (`registerTask`, etc.) become convenience layers on top of this pair for the server-side/secret-key case, not the only way to use the SDK.

## Acceptance criteria

- [ ] `buildTransaction` works for every mutating method, including the dual-auth `transferAdmin` case (returning which two accounts need to sign).
- [ ] A test simulates the full unsigned-build, external-sign (using a test keypair as a stand-in for a wallet), submit round trip.
- [ ] Documented as the recommended pattern for browser/wallet integrations in the React-hooks issues (0173 onward) and the wallet-kit example (issue 0190).

## Files

- packages/sdk-ts/src/transactionBuilder.ts
