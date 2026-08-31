---
title: "design(governance): token, proposal, and voting architecture"
labels: [contract, docs, advanced]
epic: E09
wave: 4
depends_on: [0050, 0338]
---

## Summary

Opens epic E09, the largest remaining epic in the roadmap. Every protocol parameter that currently requires an admin key (fee_bps, min_reward, treasury recipient shares if epic E08 lands, and the admin key itself) is a centralization point. This epic introduces a governance token ($KPRS) and a process for token holders to propose and vote on changes to those parameters, moving control away from a single admin key over time.

## Questions this document must answer

- Token supply and distribution: total supply, initial allocation (to the existing admin/deployer, to early keepers based on the reputation or execution history from epic E07, to a public sale or airdrop), and whether any of it vests over time.
- Proposal mechanism: who can create a proposal (any token holder, or a minimum-holding threshold to prevent spam), what a proposal can actually change (an explicit, closed list of governable parameters is safer than an open-ended "arbitrary contract call" design for a first version), and the voting period length.
- Voting power: one token, one vote, or something weighted (by reputation, by stake, if those epics exist). State the actual mechanism, not just that voting exists.
- Quorum and passing threshold: what fraction of voting power must participate for a vote to be valid, and what fraction of participating votes must be in favor to pass.
- Timelock: is there a delay between a proposal passing and its effect taking place, giving affected parties time to react (withdraw, exit) before a parameter change lands. State the delay and why.
- Execution: does a passed proposal execute automatically once its timelock elapses, or does it require a separate triggering transaction, and who can trigger it.
- Migration path: how does control of the existing admin-gated functions (require_admin in the registry, and any treasury admin functions from epic E08) actually transfer to the governance contract — a single transfer_admin call handing control to the governance contract's own address is the most direct mechanism; confirm this is what is intended.

## Acceptance criteria

- [ ] Every question above is answered with an explicit decision and rationale.
- [ ] The exact list of governable parameters for a first version is enumerated, not left open-ended.
- [ ] The migration mechanism from the current single-admin model is specified precisely enough to implement and test.

## Files

- docs/GOVERNANCE_DESIGN.md
