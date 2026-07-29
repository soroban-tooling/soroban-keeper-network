---
title: "feat(sdk-ts): KeeperRegistryClient class wrapping contract invocation"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0152]
---

## Summary

The core of the SDK: a `KeeperRegistryClient` class that wraps the repetitive simulate-build-sign-submit dance the keeper-bot example currently hand-rolls in `invokeContract`/`readContract`, parameterized by contract address and network, exposing one typed method per contract entry point (the remaining issues in this epic fill in the methods; this issue is the class shape and its shared plumbing).

## Expected behaviour

```ts
const client = new KeeperRegistryClient({ contractId, rpcUrl, networkPassphrase });
```

with shared internal helpers for building a transaction, simulating it, and either returning the simulated result (for read-only calls) or requiring a signer and submitting (for mutating calls) — mirroring the `invokeContract`/`readContract` split already proven out in `examples/keeper-bot/index.js`, but as a reusable, typed library rather than one script's internal functions.

## Acceptance criteria

- [ ] Class constructor validates its inputs (a malformed contract address should fail fast with a clear error, not surface as an opaque RPC failure later).
- [ ] Shared read-only and mutating call paths are implemented once and reused, not duplicated per method (the remaining issues in this epic should only need to add thin per-method wrappers).
- [ ] A test against a local or sandboxed RPC (or a mocked one, if a live one is impractical for CI) exercises at least one read and one write path through this shared plumbing.

## Files

- packages/sdk-ts/src/client.ts
- packages/sdk-ts/src/client.test.ts
