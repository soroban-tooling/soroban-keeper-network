---
title: "fix(keeper-bot): every round re-scans the same ledger window and re-processes handled tasks"
labels: [keeper-bot, bug, intermediate]
epic: E15
wave: 1
depends_on: []
---

## Summary

The event query window is computed from the current ledger on every round, so each round re-reads roughly the same 1000 ledgers and re-evaluates every task it has already dealt with. The bot has no memory between rounds.

## Current behaviour

```js
// Determine start ledger for event query (last ~1000 ledgers ≈ 1.4h at 5s)
const latestLedger = await server.getLatestLedger();
const startLedger = Math.max(1, latestLedger.sequence - 1000);

const pendingTasks = await fetchPendingTasks(server, contractId, startLedger);
```

With a 10-second poll interval, consecutive rounds advance the window by about two ledgers while re-reading 998 of the same ones. Every `TaskRegistered` event in that window is re-materialised into a task object every round, for roughly 500 rounds before it finally scrolls out.

Nothing tracks which tasks have already been handled. `fetchPendingTasks` returns only `{ taskId, reward, deadline }` extracted from the registration event — never the current on-chain status — so a task this bot executed ten seconds ago comes back identical to a brand-new one.

## What actually goes wrong

The bot does not double-execute, because the contract rejects it. But the rejection costs a submitted transaction:

- For an already-executed task, `claim_task` fails on the status guard. That failure is caught, logged as a warning, and the round moves on — after paying for the attempt.
- `isPermanentError` matches on `"already"` and `"simulation failed"`, which prevents *retrying* the doomed call, but the first attempt is still made every round.
- With `EXPIRE_STALE_TASKS` on, past-deadline tasks that someone already expired get an `expire_task` attempt each round, with the same outcome.

So a task that scrolls through a 1000-ledger window generates hundreds of failed submissions. `MAX_TASKS_PER_ROUND` caps the damage at five per round, but that cap makes a second problem worse: the loop iterates events in the order returned, so it spends its budget re-attempting the *oldest* tasks in the window and may never reach genuinely new ones.

That is the serious version of this bug. Under sustained task volume the bot can starve itself of new work while burning fees on stale entries.

## Expected behaviour

The bot tracks its scan position and its per-task outcomes across rounds, so each registration event is evaluated once and new tasks are reached first.

## Suggested approach

Two changes that work together.

**Advance the cursor.** Keep the last scanned ledger and start the next query from there, falling back to a lookback window only on the first round:

```js
// Ledger to resume from on the next round. Starts as a lookback window so a
// freshly started bot sees recent tasks, then tracks forward.
let cursorLedger = null;
```

`getEvents` returns `latestLedger` in its response; use it rather than a second `getLatestLedger` call.

**Remember outcomes.** An in-memory `Map` of `taskId -> terminal outcome` is enough to stop re-attempting tasks this process already resolved. Keep it bounded — evict entries whose deadline has passed, or cap the size — so a long-running bot does not grow without limit.

In-memory state is lost on restart, which is acceptable for an example bot as long as it is stated. The header comment already lists "Persistent task state DB (SQLite / Redis)" as a production concern; this change makes the in-memory version correct so the persistent version is a swap rather than a rewrite.

Also consider processing newest-first, or checking status before spending the per-round budget. Both interact with the separate `is_claimable` pre-check issue — coordinate so the two PRs do not conflict.

## Acceptance criteria

- [ ] The event query resumes from a tracked cursor rather than recomputing a fixed lookback each round.
- [ ] The first round uses a documented lookback window; subsequent rounds do not.
- [ ] Tasks resolved in an earlier round are not re-attempted.
- [ ] The outcome cache is bounded, with the eviction policy documented.
- [ ] The loss of state across restarts is documented in the header comment.
- [ ] A log line reports the ledger range scanned per round, so the behaviour is observable.

## Files

- `examples/keeper-bot/index.js`

## Verification

Run for several minutes against testnet with one registered task. Confirm the claim is attempted once, not once per round.
