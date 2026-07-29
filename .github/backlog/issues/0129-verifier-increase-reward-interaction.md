---
title: "test(registry): confirm increase_reward and extend_deadline behave correctly on verifier-attached tasks"
labels: [testing, contract, good-first-issue]
epic: E04
wave: 2
depends_on: [0073]
---

## Summary

increase_reward and extend_deadline both operate on a Task without reading or caring about its verifier field, per the design from issue 0071 (the verifier only matters at execute_task time). This issue is a straightforward confirmation test that adding the verifier field did not accidentally change either function's behavior, and that a task's verifier survives a reward top-up or deadline extension unchanged.

## Expected behaviour

Tests confirming: increase_reward on a verifier-attached task succeeds normally and leaves the verifier field untouched; extend_deadline likewise; and a subsequent execute_task against the topped-up or extended task still correctly invokes the unchanged verifier.

## Acceptance criteria

- [ ] Both functions tested against verifier-attached tasks specifically, not just relying on the no-verifier test coverage generalizing by inspection.
- [ ] Verifier field confirmed unchanged via get_task after each operation.

## Files

- contracts/keeper-registry/src/test.rs
