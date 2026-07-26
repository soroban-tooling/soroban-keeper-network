---
title: "docs(readme): the events table does not match the symbols the contract emits"
labels: [docs, bug, good-first-issue]
epic: E20
wave: 1
depends_on: []
---

## Summary

The events table in README lists topic and data shapes that differ from what `contracts/keeper-registry/src/lib.rs` actually publishes. Anyone building an event filter from the documentation will match nothing.

## The discrepancies

README documents:

| Event | Topics | Data |
|-------|--------|------|
| `TaskRegistered` | `("reg", "task")` | `(task_id, owner, reward, deadline)` |
| `TaskClaimed` | `("claim", "task")` | `(task_id, keeper, ledger_seq)` |
| `TaskExecuted` | `("exec", "task")` | `(task_id, keeper, net_reward, proof)` |
| `TaskExpired` | `("exp", "task")` | `(task_id,)` |
| `TaskCancelled` | `("cancel", "task")` | `(task_id, owner)` |
| `RewardsWithdrawn` | `("withdraw", "reward")` | `(keeper, amount)` |

The code publishes:

```rust
// emit_rewards_withdrawn
e.events().publish(
    (symbol_short!("wdraw"), symbol_short!("reward")),
    (keeper.clone(), amount),
);
```

**`RewardsWithdrawn` uses the topic `"wdraw"`, not `"withdraw"`.** This is not a typo that can be fixed in the code: `symbol_short!` is limited to 9 characters, and while `"withdraw"` is 8 and would fit, changing the emitted symbol breaks any existing consumer. The documentation is what is wrong.

**`TaskExecuted` does not include `proof` in its data.** The emitter takes four arguments and publishes three. This one is a genuine code defect rather than a documentation error and is tracked separately — but the table is wrong either way, and whichever issue lands second must reconcile the two.

The table also omits every event the contract emits that is not task-lifecycle: `emit_paused`, `emit_fee_updated`, `emit_admin_transferred`, `emit_reward_increased`, and `emit_deadline_extended`. Five emitted events appear nowhere in the documentation at all.

## Why this matters

The README presents this table as the integration contract for off-chain consumers, and the architecture section states that "events are the query primitive for off-chain indexers". The indexer and SDK work both start from this table. Shipping it wrong means every downstream consumer starts from a false specification, and the failure mode is silent — an event filter that matches nothing looks exactly like a quiet network.

The keeper bot already demonstrates the hazard: it hardcodes base64-encoded topic filters derived from these symbols, so a mismatch there produces an empty task list with no error.

## Expected behaviour

The README events table lists every event the contract emits, with topics and data shapes copied from the implementation, and nothing it does not emit.

## Suggested approach

Go through the emitter functions in `lib.rs` one at a time — they are all grouped together under the "Events" banner — and rebuild the table from them. Do not work from the existing table.

For each event, record the two topic symbols exactly as written in `symbol_short!`, and the data tuple in order with the Rust type of each element. Add a column noting which function emits it, since that is the first thing anyone reading the table wants to know.

Add a note explaining the 9-character `symbol_short!` limit, since that is the reason several topics are abbreviated and it is otherwise baffling.

Coordinate with the `TaskExecuted` proof issue: if that lands first, document the four-element shape; if this lands first, document the three-element shape and leave a note that it is expected to change.

## Acceptance criteria

- [ ] Every `emit_*` function in `lib.rs` has a row in the table.
- [ ] No row exists for an event the contract does not emit.
- [ ] Topic symbols match the `symbol_short!` literals character for character.
- [ ] Data tuples list elements in emission order with their types.
- [ ] A column identifies the emitting contract function.
- [ ] The `symbol_short!` length limit is noted.
- [ ] `docs/ARCHITECTURE.md` is checked for the same table and corrected if it disagrees.

## Files

- `README.md` — the events table under Technical Specifications
- `docs/ARCHITECTURE.md`

## Getting started

Good first issue, and a genuinely useful one — several later pieces of work read from this table. No Rust knowledge needed beyond reading the emitter functions, which are short and all in one place.
