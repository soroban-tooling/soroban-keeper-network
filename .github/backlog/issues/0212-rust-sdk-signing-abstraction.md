---
title: "feat(rust-sdk): abstract transaction signing behind a trait"
labels: [rust-sdk, enhancement, advanced]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

If the client methods added in issue 0199 take a raw Keypair directly, every integrator is forced into holding a plaintext secret key in the same process as the SDK. A native application backed by a hardware wallet, an HSM, or a remote signing service needs to supply signatures without the SDK ever seeing the secret key.

## Expected behaviour

A TransactionSigner trait with a sign method the client calls internally, with a default implementation wrapping a plain Keypair for the common case, but allowing a caller to supply their own implementation backed by whatever key management they use.

## Suggested approach

Keep the trait's surface area minimal: it should sign a transaction envelope and return the signature, not know anything about the registry's specific methods. This keeps it reusable for signing any Soroban transaction, not just calls into this one contract.

## Acceptance criteria

- [ ] The default Keypair-backed implementation exists and every existing client method continues to work with it unchanged.
- [ ] A test implements a second, trivial TransactionSigner (e.g. one that just wraps a different signing library) and confirms the client works against it without modification.
- [ ] Nothing in the client's public API assumes a Keypair specifically once this lands; the trait is the only signing interface client methods depend on.

## Files

- rust-sdk/src/signing.rs
- rust-sdk/src/client.rs
