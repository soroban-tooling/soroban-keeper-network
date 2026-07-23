---
title: "feat(keeper-bot): replace the hardcoded fake proof with a pluggable executor interface"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 1
depends_on: []
---

## Summary

`executeTaskOffChain` sleeps for 500ms and returns a hex-encoded string containing the task id and a timestamp. That is the entire off-chain execution story. Anyone using this bot as a starting point has to find and replace the one function that matters, with no interface telling them what it should do.

## Current behaviour

```js
async function executeTaskOffChain(task) {
  console.log(`  ⚙️  Executing task ${task.taskId} off-chain...`);
  await sleep(500);

  const fakeTxHash = Buffer.from(
    `keeper-proof:task:${task.taskId}:ts:${Date.now()}`
  ).toString("hex");
  return fakeTxHash;
}
```

The doc comment says what a real implementation would do — call the target contract, verify it succeeded, return a hash or state proof — but nothing in the code shape guides anyone there.

## What is actually missing

**The executor cannot see the calldata.** `fetchPendingTasks` returns `{ taskId, reward, deadline }` decoded from the registration event. `calldata` — the field whose entire purpose is telling the keeper what to do — is stored on the task and never fetched. So the current structure cannot support a real executor even if someone wrote one; they would first have to add a `get_task` call.

**Nothing dispatches on `task_type`.** The contract defines six variants — `Liquidation`, `OraclePricePush`, `FundingRateUpdate`, `LiquidityRebalance`, `TtlExtension`, `Custom` — and each implies completely different off-chain work. The bot treats them identically and does not even read the field.

**Failure has no representation.** The function cannot signal "I tried and could not do this". It always returns a proof, so the bot always calls `execute_task` and always claims the reward. A keeper built on this template submits proof of work it did not do — which is precisely the attack the README's "Known Design Decisions" section warns about, shipped as the reference implementation.

That last point is the reason this is worth fixing properly rather than leaving a TODO.

## Expected behaviour

Executors are registered per task type against a documented interface. The bot fetches the calldata, dispatches to the right executor, and does not submit `execute_task` when the executor reports failure.

## Suggested approach

Define the contract in a comment and keep it small:

```js
/**
 * A task executor performs the off-chain work a task describes and returns
 * evidence that it happened.
 *
 * @param {object} task           - { taskId, taskType, calldata, reward, deadline }
 * @param {object} ctx            - { server, keypair, networkPassphrase, log }
 * @returns {Promise<Buffer|null>} Proof bytes on success; null if the work
 *   could not be completed. Returning null means the bot will NOT call
 *   execute_task — the task is left for another keeper or for expiry. Throwing
 *   is treated the same way, with the error logged.
 */
```

Register them by task type, with an explicit refusal as the default:

```js
const EXECUTORS = {
  // No default executor. A keeper that submits proof for work it did not do is
  // exactly the failure mode the registry's trust model warns about, so an
  // unhandled task type is skipped rather than fabricated.
  default: async (task, ctx) => {
    ctx.log(`No executor registered for task type ${task.taskType} — skipping.`);
    return null;
  },
};
```

Ship the demo executor as an opt-in, clearly named, and off by default:

```js
// Development only. Returns a synthetic proof without doing any work. Enabled
// with SIMULATE_EXECUTION=true so it can never be the accidental default.
```

Then update the round loop to fetch full task details — this needs `get_task`, and pairs with the batch-read view issue on the contract side — and to skip `execute_task` when the executor returns null.

Documenting the interface in the README keeper-bot section is part of the work, not an afterthought. The interface is the deliverable; the executors are examples.

## Acceptance criteria

- [ ] An executor interface is documented with parameters, return value, and failure semantics.
- [ ] Executors are registered per `task_type`, with a default that refuses rather than fabricates.
- [ ] The bot fetches `calldata` and `task_type` and passes them to the executor.
- [ ] Returning null or throwing prevents `execute_task` from being submitted.
- [ ] The synthetic executor is opt-in via an environment variable and named to make its nature obvious.
- [ ] A worked example executor is included for one concrete task type.
- [ ] The interface is documented in the README or the operator guide.
- [ ] `.env.example` documents the simulate flag with a warning.

## Files

- `examples/keeper-bot/index.js`
- `examples/keeper-bot/.env.example`
- `README.md` or `docs/DEPLOYING.md`
