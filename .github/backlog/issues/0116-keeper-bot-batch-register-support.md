---
title: "feat(keeper-bot-tooling): add a batch registration helper script for dApp integrators"
labels: [tooling, enhancement, good-first-issue]
epic: E05
wave: 2
depends_on: [0098]
---

## Summary

The keeper bot example is keeper-side tooling; there is currently no owner-side example showing how to actually call batch_register_tasks once it exists. This issue adds a small standalone script (not part of the keeper bot itself, which has no reason to register tasks) demonstrating the batch registration flow end to end.

## Expected behaviour

A script under examples/ (e.g. examples/batch-register/) that reads a simple JSON or CSV list of tasks to register and submits them via one batch_register_tasks call, respecting the max_total_reward ceiling from issue 0103 and reporting the returned task ids clearly.

## Acceptance criteria

- [ ] Script runs against testnet given a funded owner key and a task list file.
- [ ] Demonstrates setting max_total_reward correctly (sum of the list, or an explicit buffer -- document the choice).
- [ ] README in the new example directory explains the format and usage, following the style of examples/keeper-bot's own README/header comment.

## Files

- examples/batch-register/index.js
- examples/batch-register/README.md
