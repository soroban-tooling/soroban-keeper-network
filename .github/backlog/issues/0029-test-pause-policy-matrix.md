---
title: "test(registry): assert the full pause policy matrix, entry point by entry point"
labels: [testing, contract, intermediate]
epic: E02
wave: 1
depends_on: []
---

## Summary

The contract documents which functions are blocked while paused and which stay open, but only three entry points are actually tested against the pause switch. The policy is a liveness guarantee — keepers are promised they can always withdraw — and most of it is unverified.

## The documented policy

From the `pause` doc comment:

> While paused, register_task/claim_task/execute_task are blocked, but expire_task and withdraw_rewards remain open so funds can always be recovered even during an incident.

And README FR-7 makes the same claim.

## Current coverage

- `test_pause_blocks_registration_but_allows_withdraw` — `register_task` blocked, `withdraw_rewards` open.
- `test_unpause_restores_registration`.
- `test_pause_emits_event`, `test_pause_by_non_admin_fails`.

So `register_task` and `withdraw_rewards` are covered. `claim_task`, `execute_task`, `expire_task`, `cancel_task`, `increase_reward`, and `extend_deadline` are not.

## Why the untested ones matter

`expire_task` and `withdraw_rewards` staying open is the *entire* argument that pausing is safe for users. If a future change accidentally gates `expire_task`, an admin pause becomes a fund freeze: owners cannot recover escrow from expired tasks for as long as the pause lasts. That is a materially different security posture from the one documented, and nothing would catch the change.

The functions the policy does not mention are equally important to pin down, because the policy is silent on them and the code is not:

- `cancel_task` — **not** gated. An owner can withdraw a pending task's escrow while paused. Consistent with the "funds can always be recovered" principle, but undocumented.
- `increase_reward` — **is** gated.
- `extend_deadline` — **not** gated, which is tracked as a separate bug.

A test matrix is how the policy stops being folklore.

## Expected behaviour

Every public entry point has an explicit assertion about its behaviour under pause, and the assertions match a policy written down in one place.

## Suggested approach

Write one table-driven test that sets up a contract with tasks in the states each function needs, pauses, and then asserts each entry point's outcome:

| Entry point | Paused behaviour |
|---|---|
| `register_task` | rejected — `ContractPaused` |
| `claim_task` | rejected |
| `execute_task` | rejected |
| `increase_reward` | rejected |
| `extend_deadline` | see the companion bug issue |
| `cancel_task` | allowed |
| `expire_task` | allowed |
| `withdraw_rewards` | allowed |
| read-only views | allowed |

Fill in the table from the code as it stands, not from the docs — where they disagree, that disagreement is a finding worth reporting on the issue.

Then assert every entry works again after `unpause`, so a one-way pause would be caught.

Coordinate with the `extend_deadline` pause bug. If that lands first, this matrix asserts the corrected behaviour; if this lands first, encode current behaviour and leave a comment pointing at the bug issue.

## Acceptance criteria

- [ ] Every public entry point has a pause assertion.
- [ ] Blocked entry points assert the specific `ContractPaused` error, not merely that the call failed.
- [ ] Allowed entry points assert the call fully succeeded and had its intended effect, not just that it did not error.
- [ ] A test asserts every entry point works again after `unpause`.
- [ ] The policy table is added to the `pause` doc comment.
- [ ] README FR-7 matches the tested matrix.

## Files

- `contracts/keeper-registry/src/test.rs`
- `contracts/keeper-registry/src/lib.rs` — doc comment
- `README.md` — FR-7
