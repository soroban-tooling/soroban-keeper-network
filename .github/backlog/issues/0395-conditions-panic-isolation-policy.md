---
title: "design(registry): failure handling for a panicking condition contract"
labels: [contract, security, advanced]
epic: E10
wave: 4
depends_on: [0390, 0393]
---

## Summary

Mirrors epic E04's issue 0075 investigation (never resolved there since that epic was never implemented) for this epic's own condition contracts: since a condition is, by design, potentially any contract a task owner chooses, a buggy or malicious one that panics needs a defined failure mode, not an assumed one.

## Expected output

A concrete investigation into Soroban's actual cross-contract panic semantics (do not assume; verify with a minimal reproducing test) and a decision on whether claim_task's own eventual recovery paths (the task remains claimable by nothing, forever, if a panicking condition blocks every claim attempt, with no deadline-based escape since expire_task only fires after the deadline regardless of the condition) are sufficient, or whether a stricter mitigation is needed given this blocks claiming entirely rather than merely gating a slower path.

## Acceptance criteria

- [ ] The actual Soroban cross-contract panic behavior is documented with evidence, not assumption.
- [ ] The specific risk that a panicking condition can permanently prevent a task from ever being claimed (worse than epic E04's analogous risk, since that only blocked execution of an already-claimed task) is addressed explicitly.
- [ ] A decision is recorded, with a mitigation implemented if the investigation concludes one is needed.

## Files

- docs/TASK_CONDITIONS_DESIGN.md
- contracts/keeper-registry/src/test/claim.rs
