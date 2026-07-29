---
title: "feat(sdk-ts): decode contract error codes into a typed KeeperError enum"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

A failed contract call surfaces as a numeric error code buried in the simulation or transaction-result response. Every method issue in this epic (0154-0164) assumes typed, named error handling exists — this issue is where that actually gets built, and should land early enough that those methods can depend on it directly rather than each inventing its own decoding.

## Expected behaviour

A `KeeperErrorCode` TypeScript enum mirroring the contract's `KeeperError` exactly (same names, same discriminant numbers — generated or manually kept in sync per issue 0192's versioning policy, since a mismatch here would silently misclassify errors), and a `decodeKeeperError(simulationOrSubmitResult)` helper that extracts the numeric code from wherever Soroban RPC actually puts it (this needs verifying against a real failed call, not assumed) and returns the typed enum value, or `undefined` if the failure was not a decodable contract error (e.g. a network error, or a host-level trap rather than a `Result::Err`).

## Acceptance criteria

- [ ] `KeeperErrorCode` enum matches the contract's current discriminants exactly — verified against `contracts/keeper-registry/src/lib.rs` at implementation time, not copied from an older issue that may predate later additions (`CalldataTooLarge`, `InvalidTaskParams`, the reserved `TtlTooShort` slot).
- [ ] `decodeKeeperError` correctly distinguishes a decodable contract error from a network/host-level failure, tested against real examples of each.
- [ ] Every method issue in this epic uses this shared decoder rather than a bespoke one.

## Files

- packages/sdk-ts/src/errors.ts
- packages/sdk-ts/src/errors.test.ts
