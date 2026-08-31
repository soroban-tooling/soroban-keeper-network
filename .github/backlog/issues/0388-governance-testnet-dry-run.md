---
title: "chore(governance): run a full proposal lifecycle on testnet before mainnet consideration"
labels: [contract, testing, intermediate]
epic: E09
wave: 4
depends_on: [0361, 0362, 0367, 0368]
---

## Summary

Beyond unit and property tests, this epic's highest-stakes action — migrating the registry's admin control to the governance contract (issue 0368) — should be exercised once, deliberately, on testnet against the actual deployed testnet registry, not only in a local test harness, before it is ever considered for mainnet.

## Acceptance criteria

- [ ] Token and governance contracts are deployed to testnet.
- [ ] A full proposal lifecycle (creation, voting from multiple testnet accounts, timelock wait, execution) is run against the real testnet registry deployment.
- [ ] The admin migration itself is performed on testnet and verified: the original admin key can no longer call admin-gated registry functions directly, and a subsequent governance-executed change is confirmed to actually apply.
- [ ] Results, including any surprise encountered, are documented before this closes.

## Files

- docs/GOVERNANCE_TESTNET_REPORT.md
