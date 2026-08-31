---
title: "security(registry): review the task-conditions surface before wider use"
labels: [contract, security, advanced]
epic: E10
wave: 4
depends_on: [0393, 0395, 0396]
---

## Summary

Closes this wave's allocation of epic E10 with a dedicated security pass, mirroring the discipline every other epic in this project has required before its work was considered ready (issues 0089, 0248, 0311, 0336, 0358, 0387).

## Expected behaviour

A review covering at minimum: whether a task owner attaching a condition contract they control could use it to selectively allow only a colluding keeper to ever see is_claimable return true (starving out the permissionless competition the registry's design otherwise guarantees), whether the panic-isolation conclusion from issue 0395 actually holds under a live test rather than only a synthetic one, and whether a condition contract could be used as a side channel to observe claim attempts and front-run them in some way the plain contract does not already allow.

## Acceptance criteria

- [ ] Each concern above is explicitly addressed with a finding or a confirmation it does not apply.
- [ ] The keeper-exclusion risk in particular is named explicitly, since it runs directly against the permissionless-competition design principle stated throughout this project's README.
- [ ] Any concrete finding is fixed or documented as an accepted, named tradeoff before this closes.

## Files

- docs/TASK_CONDITIONS_SECURITY_REVIEW.md
