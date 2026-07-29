---
title: "test(registry): confirm verifier-attached tasks interact correctly with cancel_task's lock-lapse path"
labels: [testing, contract, intermediate]
epic: E04
wave: 2
depends_on: [0074]
---

## Summary

cancel_task now allows an owner to reclaim a Claimed task's escrow once the claimer's lock has lapsed (a wave-1/wave-2-adjacent fix). This interacts with the verifier work: if a task has a verifier attached and the current claimer cannot produce a satisfying proof (whether because the verifier is simply strict or, per issue 0075/0127, malfunctioning), the lock-lapse cancel path is exactly the recovery mechanism an owner would reach for. This issue confirms that path works correctly for verifier-attached tasks specifically.

## Expected behaviour

A test: register a task with a verifier that always rejects (from issue 0084's mock), claim it, let the lock lapse without a successful execution, and confirm the owner can cancel and recover the full escrow via the existing lock-lapse cancel path -- no verifier-specific interaction bug (for example, the cancel path should not attempt to call the verifier at all, since it is not executing anything).

## Acceptance criteria

- [ ] Confirms cancel_task never calls the attached verifier -- it is purely a refund path and has no reason to.
- [ ] Confirms the full escrow is recovered, matching the non-verifier lock-lapse cancel behavior exactly.
- [ ] Documents this as the intended recovery path for a keeper stuck against an unsatisfiable verifier, cross-referenced from issue 0127's emergency-disable discussion as the "already exists" baseline that issue is trying to improve on for the claimer's (not just the owner's) sake.

## Files

- contracts/keeper-registry/src/test.rs
