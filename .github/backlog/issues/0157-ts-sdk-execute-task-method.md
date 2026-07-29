---
title: "feat(sdk-ts): client.executeTask with typed proof handling"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrapper for proof submission. Proof handling deserves its own issue rather than folding into 0156, since getting the byte-encoding ergonomics right (the existing keeper-bot passes `Buffer.from(proof, "hex")` — this SDK should accept a more flexible input type) matters for adoption.

## Expected behaviour

`client.executeTask({ keeper, taskId, proof })` where `proof` accepts `Uint8Array | Buffer | string` (treating a `string` input as hex, with the encoding assumption documented clearly since silently guessing wrong between hex and utf-8 would be a nasty bug), converted internally to the `Bytes` the contract expects, and validated client-side against `MAX_PROOF_LEN` before ever building a transaction — surfacing `ProofTooLarge` as a fast, local check when possible, while the contract's own check remains authoritative.

## Acceptance criteria

- [ ] Accepts multiple proof input types with the accepted formats documented explicitly.
- [ ] Client-side length pre-check against `MAX_PROOF_LEN`, sourced from the SDK's own copy of that constant (kept in sync with the contract — see issue 0192's versioning policy for how constants like this get updated on a contract version bump).
- [ ] Test covers success, an over-length proof caught client-side, and a verifier rejection (`VerificationFailed`, once epic E04 lands) surfaced distinctly.

## Files

- packages/sdk-ts/src/methods/executeTask.ts
