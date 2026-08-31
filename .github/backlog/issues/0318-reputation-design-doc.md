---
title: "design(registry): on-chain reputation scoring architecture"
labels: [contract, docs, advanced]
epic: E07
wave: 4
depends_on: [0050]
---

## Summary

Opens epic E07. The registry currently treats every keeper identically at the protocol level: any address can claim any claimable task, with no memory of a keeper's track record beyond what an off-chain indexer (epic E14) might separately compute. This epic introduces on-chain reputation the contract itself can use to influence claim priority or eligibility.

## Questions this document must answer

- What reputation tracks: successful executions, missed lock windows (claimed but never executed before re-claim), slashes if epic E06 lands, or some combination, each with its own weight.
- Where the score lives and how it is computed: updated incrementally on every relevant action (cheap per-call, harder to audit after the fact) versus computed on demand from history (expensive, but always exactly reproducible from raw events).
- Decay: does an old failure matter as much as a recent one, and if reputation decays over time, what is the decay function and why.
- What reputation actually gates or influences: nothing in a first version beyond being readable (informational only), a priority queue for claim ordering, or an eligibility floor similar to the staking minimum from epic E06. State plainly whether this epic depends on E06 landing first if the two are meant to interact (e.g., reputation affecting slash severity).

## Acceptance criteria

- [ ] Every question above is answered with an explicit decision and rationale.
- [ ] Any dependency on epic E06 is stated plainly, not assumed.
- [ ] Exact storage keys and entry point or view signatures are pinned before implementation begins.

## Files

- docs/REPUTATION_DESIGN.md
