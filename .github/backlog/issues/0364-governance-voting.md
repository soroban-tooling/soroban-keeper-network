---
title: "feat(governance): cast and tally votes on an open proposal"
labels: [contract, enhancement, advanced]
epic: E09
wave: 4
depends_on: [0361, 0363]
---

## Summary

Implements voting per issue 0360's voting-power model (one-token-one-vote, or a weighted variant), against a proposal created in issue 0363.

## Expected behaviour

A vote(proposal_id, choice) entry point that reads the caller's KPRS balance (or weighted power, per issue 0360) at proposal-creation time, not at vote time, to prevent a voter from acquiring additional tokens mid-vote specifically to swing the outcome. Decide and document a snapshotting mechanism for this rather than reading a live balance.

## Acceptance criteria

- [ ] Voting power is fixed at proposal creation and does not change even if a voter's balance changes afterward, verified by a test that transfers tokens mid-vote and confirms the transfer does not retroactively change already-cast or future voting weight for that proposal.
- [ ] A voter cannot vote twice on the same proposal.
- [ ] Tallies are correctly computed and queryable before the voting period closes.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
