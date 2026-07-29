---
title: "chore(release): CHANGELOG entry and VERSION bump for batch registration"
labels: [docs, good-first-issue]
epic: E05
wave: 2
depends_on: [0098, 0103]
---

## Summary

Closes out the batch-registration slice of epic E05, mirroring issue 0096's pattern for the verifier epic. New public entry point plus new error variants (if 0103's ceiling introduces one) are exactly the kind of ABI change VERSION exists to signal.

## Expected behaviour

VERSION bumped again (to whatever is next after epic E04's bump from issue 0096, if that landed first -- check current value before assuming). A CHANGELOG entry covering batch_register_tasks, the max_total_reward ceiling, and any new error variant, with the measured batch-size ceiling from issue 0104 called out explicitly so integrators know the practical limit.

## Acceptance criteria

- [ ] VERSION bumped and test_version_is_exposed (or equivalent) updated.
- [ ] CHANGELOG entry covers every user-visible change from the batch-registration work.
- [ ] Cross-references docs/BATCH_OPERATIONS.md for integrators wanting detail.

## Files

- contracts/keeper-registry/src/lib.rs
- contracts/keeper-registry/src/test.rs
- CHANGELOG.md
