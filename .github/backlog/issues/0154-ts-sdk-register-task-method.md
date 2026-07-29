---
title: "feat(sdk-ts): client.registerTask and client.increaseReward"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrappers for the two reward-escrow-mutating owner calls. Grouped together since both share the same "owner authorizes, token moves into escrow" shape.

## Expected behaviour

`client.registerTask({ owner, taskType, calldata, reward, deadline, ttlLedgers, lockLedgers, verifier? })` and `client.increaseReward({ owner, taskId, additional })`, both returning a typed result (the new task id for the former) after signing and submission, with every field typed against the contract's actual parameter types (e.g. `taskType` as a TypeScript union/enum matching `TaskType`, not a raw number the caller has to get right by convention).

## Acceptance criteria

- [ ] `taskType` is a proper TypeScript enum or literal union mirroring the contract's `TaskType`, not a bare `number`.
- [ ] `verifier` is optional and typed as `string | undefined` (a Stellar address), consistent with whatever epic E04's ABI actually looks like by the time this is built — check current `main` rather than assuming.
- [ ] Both methods reject client-side (before even building a transaction) for the same input errors the contract itself would reject for cheaply-checkable cases (e.g. non-positive reward), to save a round trip — but the contract's own validation remains the source of truth; the client check is an optimization, not a replacement.
- [ ] Tests cover a successful call and at least one client-side-caught invalid input.

## Files

- packages/sdk-ts/src/methods/registerTask.ts
- packages/sdk-ts/src/methods/increaseReward.ts
