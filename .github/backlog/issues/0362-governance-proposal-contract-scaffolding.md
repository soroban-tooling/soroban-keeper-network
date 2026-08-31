---
title: "chore(governance): scaffold the governance contract"
labels: [contract, tooling, intermediate]
epic: E09
wave: 4
depends_on: [0360, 0361]
---

## Summary

Stands up the governance contract as a deployable, empty shell with no proposal logic yet, following the scaffold-first discipline used across every other epic in this project.

## Acceptance criteria

- [ ] The contract builds, deploys to a local network, and exposes a version view.
- [ ] It is configured to read balances from the KPRS token contract (issue 0361) for voting power, with that dependency wired but unused until issue 0364.

## Files

- contracts/governance/src/lib.rs
