---
title: "docs(sdk-ts): worked example -- Freighter/wallet-kit browser signing flow"
labels: [docs, enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0170]
---

## Summary

Issue 0170 builds the unsigned-transaction-XDR capability a wallet-based signing flow needs; this issue is the actual worked example proving it works against a real wallet extension, since the unsigned-XDR API surface being technically correct is not the same as it being usable in practice against real wallet software's quirks.

## Expected behaviour

A small example (likely paired with the React example app from issue 0185, or standalone if that has not landed yet) walking through: connecting Freighter (or another Stellar wallet-kit-supported wallet), building an unsigned `registerTask` transaction via the SDK, requesting the wallet's signature, and submitting the signed result.

## Acceptance criteria

- [ ] Actually tested against a real wallet extension in a browser, not just reasoned about from the wallet's documented API.
- [ ] Handles and documents the user-rejects-the-signature-request case explicitly, since that is a normal, expected outcome a dApp must handle gracefully.

## Implementation Note

The example relies on `client.buildTransaction(methodName, params)` implemented in issue 0170 to obtain the unsigned XDR and required `signers`, passes `unsignedXdr` to Freighter / Stellar Wallet Kit's `signTransaction()` method, and sends the returned `signedXdr` to `client.submitSignedTransaction(signedXdr)`.

## Files

- packages/sdk-ts/examples/wallet-signing/

