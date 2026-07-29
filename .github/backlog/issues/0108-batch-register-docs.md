---
title: "docs: batch registration integration guide"
labels: [docs, good-first-issue]
epic: E05
wave: 2
depends_on: [0098, 0103]
---

## Summary

Once batch_register_tasks exists, dApp integrators need to know when it is worth using over repeated single register_task calls, and how the max_total_reward ceiling (0103) and any resource limit (0104) affect how they should batch their own workload.

## Expected behaviour

A docs/BATCH_OPERATIONS.md section (extending the design doc from 0097 rather than replacing it) with a worked example: a dApp with N pending tasks to register, showing how to size batches against the measured ceiling, set max_total_reward correctly, and handle a rejected batch.

## Acceptance criteria

- [ ] A copy-pasteable example exists for at least one SDK or raw contract-call context.
- [ ] The max_total_reward and batch-size-ceiling tradeoffs are explained, not just the happy path.
- [ ] README's Functional Requirements section gets an FR entry for batch_register_tasks, consistent with issue 0095's pattern for the verifier field.

## Files

- docs/BATCH_OPERATIONS.md
- README.md
