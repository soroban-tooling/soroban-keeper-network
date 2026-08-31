---
title: "feat(rust-sdk): typed wrappers for batch_register_tasks, get_tasks, get_tasks_range"
labels: [rust-sdk, enhancement, intermediate]
epic: E13
wave: 3
depends_on: [0198, 0199]
---

## Summary

Issue 0199 wired the single-task lifecycle methods (register_task, claim_task, execute_task, and friends) onto the Rust SDK client struct from issue 0198. This issue adds the three batch entry points the contract actually exposes: batch_register_tasks, get_tasks, and get_tasks_range.

## Current behaviour

The registry's batch.rs module implements exactly these three functions today, against BatchTaskParams (task_type, calldata, reward, deadline, ttl_ledgers, lock_ledgers), bounded by MAX_BATCH_SIZE for registration and MAX_BATCH_READ for reads. Nothing in the Rust SDK crate wraps them yet.

## Expected behaviour

Client methods matching the contract's actual signatures:

- batch_register_tasks(owner, tasks: Vec<BatchTaskParams>, max_total_reward: i128) -> Result<Vec<u64>, ClientError>
- get_tasks(ids: Vec<u64>) -> Result<Vec<Option<Task>>, ClientError>
- get_tasks_range(start_id: u64, count: u32) -> Result<Vec<Option<Task>>, ClientError>

Do not invent a max_total_reward default on the SDK side. The contract treats it as a caller-supplied ceiling with no implicit value; the SDK method should require it as an explicit argument so a caller cannot accidentally omit the safety check the ceiling exists to provide.

## Suggested approach

Reuse the error-mapping work from issue 0200 rather than adding a second decode path for these three methods. BatchTaskParams itself should round-trip through the same XDR conversion used for Task in issue 0199, since the two types share several fields.

## Acceptance criteria

- [ ] All three methods call the actual contract entry points with the exact argument order and types the contract defines.
- [ ] BatchTooLarge, EmptyBatch, and BatchRewardCeilingExceeded decode to the same typed Rust error enum issue 0200 established, not a generic string.
- [ ] A test against the local test network registers a batch, then reads it back via both get_tasks and get_tasks_range, and asserts the two views agree.
- [ ] Rustdoc on batch_register_tasks states the MAX_BATCH_SIZE ceiling and links to docs/BATCH_OPERATIONS.md rather than restating its contents.

## Files

- rust-sdk/src/client.rs
- rust-sdk/tests/batch.rs
