---
title: "design(registry): staking and slashing architecture"
labels: [contract, docs, advanced]
epic: E06
wave: 4
depends_on: [0050]
---

## Summary

Opens epic E06. The registry currently has no concept of keeper reputation or accountability beyond the lock-window mechanic that prevents a squatting keeper from holding a task forever (wave 1 issue 0016). This epic introduces staking: a keeper posts collateral, and misbehavior (a proof later shown to be fraudulent, or a pattern the protocol defines as slashable) can result in losing some of it. This issue is the design document, following the same discipline epic E04's verifier work started with in issue 0071.

## Questions this document must answer

- What counts as slashable. Given the current contract has no on-chain verification of a proof's truth (the verifier epic, E04, was designed in docs/VERIFIER_DESIGN.md but never actually implemented — Task has no verifier field today), slashing cannot yet be triggered automatically by a failed on-chain check. Decide whether this epic depends on E04's verifier work actually landing first, or whether slashing in a first version is dispute-based (a challenge period, a governance vote) rather than automatic.
- Where stake lives: a separate stake escrow per keeper in this same contract, or a dedicated staking contract this registry calls into. State the tradeoff plainly — a separate contract isolates stake-related bugs from task escrow, at the cost of a cross-contract call on every stake-checked operation.
- Unbonding: can a keeper withdraw its stake immediately, or is there a delay, and if so, how long and why.
- Dispute window: if slashing is dispute-based, who can raise a dispute, within what window after the disputed action, and what happens to the stake while a dispute is pending.
- Interaction with existing mechanics: does a staked keeper get any different treatment in claim_task or execute_task than an unstaked one (priority, a lower effective lock window, nothing at all in a first version).

## Expected output

docs/STAKING_DESIGN.md answering each question, with the exact new error variants, storage keys, and entry point signatures needed, so issues 0289 onward implement against a fixed design rather than each guessing independently the way epic E04's verifier work suffered from multiple contributors building incompatible implementations.

## Acceptance criteria

- [ ] Every question above is answered with an explicit decision and rationale.
- [ ] The dependency (or lack of one) on epic E04's unimplemented verifier work is stated plainly, not assumed.
- [ ] Exact storage keys and entry point signatures are pinned before implementation begins.

## Files

- docs/STAKING_DESIGN.md
