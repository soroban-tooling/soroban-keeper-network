---
title: "design(registry): on-chain task conditions architecture"
labels: [contract, docs, advanced]
epic: E10
wave: 4
depends_on: [0050]
---

## Summary

Opens epic E10. Today, is_claimable answers only whether a task's status and lock window permit a claim; it has no concept of whether the underlying off-chain condition the task exists to react to (a price crossing a threshold, a position becoming liquidatable) is actually true. A keeper currently has to know this out of band. This epic adds an on-chain predicate a task can carry, evaluated before a claim is allowed, similar in spirit to Chainlink Automation's checkUpkeep pattern.

## Questions this document must answer

- Relationship to the verifier epic (E04): epic E04 designed (docs/VERIFIER_DESIGN.md) but never implemented an on-chain verification callback for execute_task, checking a proof after the fact. This epic's condition check is different in kind — it gates claim_task, checking whether a task is even worth attempting, before any off-chain work happens. State plainly that these are two distinct, non-overlapping mechanisms, and whether this epic's implementation should reuse any of E04's never-shipped design decisions or start fresh.
- Predicate interface: a condition is almost certainly a cross-contract call to a task-specified address, similar in shape to the never-implemented verifier interface, returning a boolean. Specify the exact interface.
- What happens on a false condition: claim_task simply rejects (the task remains Pending, unclaimed, exactly as if no one had attempted it) versus some other outcome. The reject-and-remain-pending option is almost certainly correct and consistent with the rest of the contract's design; confirm this explicitly.
- Gas/resource cost: the condition check is a cross-contract call paid for by the claiming keeper's transaction, the same cost-allocation question epic E04's issue 0076 raised for verifier calls and never resolved since that epic was never implemented. Address it here from the start.
- Backward compatibility: a task registered without a condition (the overwhelming majority of existing and near-future tasks) must behave exactly as today, with zero added cost or behavior change.

## Acceptance criteria

- [ ] Every question above is answered with an explicit decision and rationale.
- [ ] The distinction from epic E04's verifier concept is stated plainly enough that a future contributor does not conflate the two.
- [ ] Exact storage field additions and entry point signature changes are pinned before implementation begins.

## Files

- docs/TASK_CONDITIONS_DESIGN.md
