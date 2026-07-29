---
title: "docs(sdk-ts): worked example -- Node.js secret-key signing flow for server-side automation"
labels: [docs, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

The counterpart to issue 0190's browser-wallet example: a server-side script (the shape `examples/keeper-bot` already uses) signing directly with a `Keypair` loaded from an environment variable, for automation contexts where a wallet-extension flow is not applicable.

## Expected behaviour

A minimal script demonstrating the SDK's convenience methods (`client.registerTask(...)` with a configured signer, as opposed to issue 0190's unsigned-XDR-plus-external-signer path) in a Node context, following the same `.env`-based secret handling convention `examples/keeper-bot/.env.example` already establishes (never hardcoding a secret key in the example itself).

## Acceptance criteria

- [ ] Follows the existing `.env.example` convention for secret handling, consistent with `examples/keeper-bot`.
- [ ] Demonstrates error handling using the typed decoder from issue 0166, not raw try/catch on an untyped error.

## Files

- packages/sdk-ts/examples/node-signing/
