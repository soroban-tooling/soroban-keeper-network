---
title: "fix(registry): extend_deadline is not gated by the pause switch"
labels: [contract, bug, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`extend_deadline` is the only task-mutating function that does not call `require_not_paused`. While the registry is paused, an owner can still push a task's deadline arbitrarily far into the future.

## Current behaviour

Compare the two owner-facing mutators. `increase_reward` is gated:

```rust
pub fn increase_reward(
    e: Env,
    owner: Address,
    task_id: u64,
    additional: i128,
) -> Result<(), KeeperError> {
    require_not_paused(&e)?;
    owner.require_auth();
```

`extend_deadline` is not:

```rust
pub fn extend_deadline(
    e: Env,
    owner: Address,
    task_id: u64,
    new_deadline: u64,
) -> Result<(), KeeperError> {
    owner.require_auth();
```

## Is this intentional?

The contract documents a deliberate policy for which functions stay open during a pause:

> While paused, register_task/claim_task/execute_task are blocked, but expire_task and withdraw_rewards remain open so funds can always be recovered even during an incident.

That policy is coherent: block anything that takes on new obligations, allow anything that lets participants get their money out. `extend_deadline` fits neither category — it does not recover funds, and leaving it open actively works against a pause.

Consider what a pause is for. The admin has discovered a problem and wants to stop the system taking on new commitments while it is investigated. `expire_task` stays open so escrow can drain back to owners as deadlines pass. But `extend_deadline` lets an owner push a deadline out and *prevent* that drain — it is the one call that can keep escrow locked in a contract the admin has declared unsafe.

The asymmetry with `increase_reward`, which is gated despite being similarly harmless-looking, strongly suggests this is an oversight rather than a decision.

## Expected behaviour

`extend_deadline` returns `ContractPaused` while the registry is paused, consistent with `increase_reward`.

## Suggested approach

Add the guard as the first statement, matching the ordering used everywhere else:

```rust
require_not_paused(&e)?;
owner.require_auth();
```

While you are here, the pause policy is worth writing down in one place rather than being distributed across function comments. Add a table to the `pause` doc comment listing every entry point and whether it is gated, so the next person adding a function has an explicit rule to follow.

## Acceptance criteria

- [ ] `extend_deadline` calls `require_not_paused` before mutating state.
- [ ] A test asserts `extend_deadline` fails with `ContractPaused` while paused, in the style of `test_pause_blocks_registration_but_allows_withdraw`.
- [ ] A test asserts it succeeds again after `unpause`.
- [ ] The `pause` doc comment lists every entry point and its gating status.
- [ ] README FR-7 is updated — it currently names only `register_task`, `claim_task`, and `execute_task` as gated, which no longer matches the code.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — FR-7
