---
title: "feat(registry): let the owner detach a misbehaving verifier from a Claimed task without losing the claim"
labels: [contract, security, advanced]
epic: E04
wave: 2
depends_on: [0075, 0082]
---

## Summary

Issue 0082 blocks update_verifier once a task is Claimed, specifically to prevent an owner from griefing the current claimer by swapping in an unsatisfiable verifier mid-claim. But the reverse problem also needs an answer: what if the *attached* verifier itself starts malfunctioning (panicking, per issue 0075, or is discovered to have a bug) while a keeper legitimately holds a claim and cannot get a valid execution through no fault of its own? Today the only recovery path is waiting for the deadline and expire_task, which fully refunds the owner but leaves the claiming keeper's off-chain work uncompensated.

## Expected behaviour

Investigate whether a narrow emergency path is warranted: for example, allowing the *admin* (not the owner, to avoid reintroducing the exact griefing risk issue 0082 closed) to detach a verifier from a specifically-identified Claimed task, but only under some constraint that prevents this from becoming a general-purpose bypass (e.g. only after a documented number of failed verification attempts have been recorded on-chain, so there's evidence the verifier is genuinely broken rather than the keeper just submitting bad proofs).

## Acceptance criteria

- [ ] The griefing-reintroduction risk from issue 0082 is explicitly re-examined against whatever mechanism is proposed here.
- [ ] A failed-attempt counter (if used as the gating condition) is added to Task or tracked separately, with its own storage-cost consideration.
- [ ] If no safe mechanism can be found, that conclusion is recorded and the existing expire_task-only recovery path is confirmed as accepted, with the tradeoff (keeper uncompensated for legitimate work) stated plainly rather than glossed over.

## Files

- docs/VERIFIER_DESIGN.md
- contracts/keeper-registry/src/lib.rs
