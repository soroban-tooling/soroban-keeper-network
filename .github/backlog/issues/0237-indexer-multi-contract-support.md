---
title: "design(indexer): decide whether one indexer instance may track more than one registry deployment"
labels: [indexer, docs, intermediate]
epic: E14
wave: 3
depends_on: [0218]
---

## Summary

The design in issue 0218 was scoped to one contract id. This project will eventually have deployments across testnet, futurenet, and mainnet, and possibly more than one mainnet deployment over time as upgrades or migrations occur. This issue decides, in writing, whether one indexer instance should be able to track several contract ids at once, or whether the answer is simply "run one instance per deployment."

## Expected output

A decision recorded in docs/INDEXER_DESIGN.md. If multi-contract support is chosen, this issue also produces the schema change needed (a contract id column threaded through every table from issues 0220 through 0222) as a follow-up issue, not silently expanded into this one.

## Acceptance criteria

- [ ] A decision is recorded with rationale.
- [ ] If multi-contract support is chosen, a scoped follow-up issue is filed for the schema change rather than expanding this issue's scope.
- [ ] If "one instance per deployment" is chosen, the deployment guide (issue 0234) reflects that operators need one instance per network/contract.

## Files

- docs/INDEXER_DESIGN.md
