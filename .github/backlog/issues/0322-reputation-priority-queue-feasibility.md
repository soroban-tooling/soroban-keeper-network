---
title: "design(registry): feasibility study — reputation-weighted claim priority"
labels: [contract, docs, advanced]
epic: E07
wave: 4
depends_on: [0318, 0319]
---

## Summary

If issue 0318 named claim priority as a real goal for reputation (rather than purely informational scoring), this issue investigates whether it is actually implementable on Soroban's execution model before committing to build it.

## The core difficulty

claim_task today is permissionless and first-come-first-served: whichever transaction lands first on a Pending task wins. A priority queue implies the contract should prefer a higher-reputation keeper's claim over a lower-reputation one submitted around the same time, but the contract has no visibility into "around the same time" beyond transaction ordering within a ledger, which keepers do not control and the contract should not be assumed to be able to influence fairly.

## Expected output

A recommendation: whether reputation-weighted priority is achievable at all given the above constraint (perhaps only as an off-chain courtesy — a keeper bot could voluntarily wait a few ledgers before claiming a task if its own reputation is low, self-selecting rather than being enforced on-chain), or whether informational-only reputation (issue 0320's view) is the honest ceiling for what this epic can deliver on-chain.

## Acceptance criteria

- [ ] The core difficulty above is addressed directly, not sidestepped.
- [ ] A recommendation is made, including explicitly recommending against on-chain enforcement if that is the honest conclusion.
- [ ] If any partial mechanism is recommended, it is scoped as its own follow-up issue.

## Files

- docs/REPUTATION_DESIGN.md
