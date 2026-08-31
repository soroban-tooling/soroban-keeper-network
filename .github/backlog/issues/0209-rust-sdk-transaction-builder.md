---
title: "feat(rust-sdk): a transaction builder for contract-to-contract calls"
labels: [rust-sdk, enhancement, advanced]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The client methods added in issues 0199, 0205, and 0206 are aimed at native applications that can sign and submit directly. A second, real use case for a Rust SDK is a contract calling the registry from inside another contract's own logic, where there is no transaction to sign; the caller is already inside a host invocation. This issue adds a lower-level builder that produces the invocation the way a cross-contract call needs it, without assuming a signing key is available.

## Expected behaviour

A CrossContractInvocation type (or similar) that constructs the same argument encoding the higher-level client methods use, but returns something a calling contract can pass to its own env.invoke_contract rather than something meant for a submitted transaction. This is deliberately narrower in scope than the full client: it does not simulate, does not sign, and does not decode a transaction result, since none of those apply inside a contract-to-contract call.

## Suggested approach

Look at how the keeper-registry's own reward_token() helper in internal.rs constructs a token::Client and calls it directly, since that is the same pattern: a contract calling another contract's typed client from inside its own entry point, with auth already established by the outer call. This issue's deliverable is the equivalent typed client for calling the keeper registry itself from another contract.

## Acceptance criteria

- [ ] The builder produces argument encodings identical to the transaction-based client methods for the same call, verified by a test that compares the two encodings byte for byte.
- [ ] No dependency on anything a submitted transaction needs (a Keypair, a network passphrase, an RPC server).
- [ ] A worked example: a minimal example contract that registers a task on behalf of its own caller by calling into the keeper registry directly.

## Files

- rust-sdk/src/cross_contract.rs
- rust-sdk/examples/calling-contract/
