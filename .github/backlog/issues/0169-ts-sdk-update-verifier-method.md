---
title: "feat(sdk-ts): client.updateVerifier, once epic E04's verifier support ships"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0081, 0153]
---

## Summary

Conditional on epic E04's `update_verifier` (issue 0081) having landed. Typed wrapper following the same shape as the other owner-facing pre-claim mutators.

## Expected behaviour

`client.updateVerifier({ owner, taskId, verifier })` where `verifier` is `string | undefined` (undefined clearing any attached verifier), rejecting `InvalidTaskStatus` distinctly for an attempt against an already-claimed task, per issue 0082's griefing-prevention guard.

## Acceptance criteria

- [ ] Supports both setting and clearing a verifier.
- [ ] `InvalidTaskStatus` on a claimed task is a distinct, documented typed outcome.
- [ ] If epic E04's `update_verifier` has not shipped by pickup time, defer rather than guess the API shape.

## Files

- packages/sdk-ts/src/methods/updateVerifier.ts
