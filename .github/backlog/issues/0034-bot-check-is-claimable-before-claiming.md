---
title: "feat(keeper-bot): check is_claimable before spending a fee on claim_task"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E15
wave: 1
depends_on: []
---

## Summary

The bot decides whether to claim a task using only the registration event and a local timestamp. It never asks the contract whether the task is actually claimable, so it submits — and pays for — claims that the contract is certain to reject.

## Current behaviour

The only filter before claiming is a deadline comparison against data from the registration event:

```js
if (task.deadline <= nowSeconds) { /* expire or skip */ }

// ...otherwise, straight to claiming
await withRetry(`claim_task ${task.taskId}`, () =>
  invokeContract(server, keypair, networkPassphrase, contractId, "claim_task", [...])
);
```

`task.deadline` comes from the `TaskRegistered` event, which records the deadline *at registration*. It is stale by construction — `extend_deadline` changes the deadline without emitting a `TaskRegistered` event, so the bot's copy can be wrong in either direction.

Nothing else is checked. The bot does not know whether the task is `Pending`, already `Claimed` by a competitor inside an active lock window, `Executed`, `Cancelled`, or `Expired`.

## The contract already provides the answer

`is_claimable` exists precisely for this, and its doc comment says so:

> Lets keeper bots pre-filter candidates without simulating a full claim_task call.

It evaluates the deadline against current ledger time, the status, and lock expiry in one read. The bot ignores it entirely.

## What it costs

Every claim on a non-claimable task is a signed, submitted, fee-paying transaction that fails. In a network with more than one keeper this is the common case, not the exception: whoever loses the race pays for the attempt. Combined with the re-scanning issue, the same doomed claim can be re-attempted every round.

`isPermanentError` catches the failure and prevents a retry, but only after the transaction has been submitted. The fee is already spent.

## Expected behaviour

The bot calls `is_claimable` by simulation before deciding to claim, and skips tasks the contract says are not claimable.

## Suggested approach

This depends on the read-by-simulation issue, since a pre-check that costs a submitted transaction defeats the purpose. Land that first, then:

```js
const claimable = await readContract(
  server, keypair.publicKey(), networkPassphrase, contractId,
  "is_claimable",
  [nativeToScVal(task.taskId, { type: "u64" })]
);
if (!claimable) {
  continue; // another keeper holds it, or it is finished
}
```

Two refinements worth making:

**Do not count skips against the budget.** `MAX_TASKS_PER_ROUND` should limit tasks actually *attempted*, not tasks examined — otherwise a run of stale entries exhausts the budget before the bot reaches anything real.

**Accept the race.** `is_claimable` returning true is not a guarantee; a competitor can claim in the interval between the simulation and the submission. The claim can still fail, and that is fine. Keep the existing error handling and add a comment saying the pre-check is an optimisation, not a lock — otherwise someone will later assume a successful pre-check means the claim cannot fail.

Consider fetching `get_task` instead, since the bot also wants the current reward for the profitability check tracked separately. One read serving both is better than two. Coordinate on the issues.

## Acceptance criteria

- [ ] `is_claimable` is consulted by simulation before any `claim_task` submission.
- [ ] Tasks reported as not claimable are skipped without submitting a transaction.
- [ ] Skipped tasks do not consume the per-round budget.
- [ ] A comment documents that the pre-check is advisory and the claim can still lose a race.
- [ ] Claim failures after a positive pre-check are handled exactly as before.
- [ ] A log line distinguishes "skipped, not claimable" from "claim attempted and failed".

## Files

- `examples/keeper-bot/index.js`
