---
title: "fix(keeper-bot): remove unused imports and the silently-swallowing catch block"
labels: [keeper-bot, good-first-issue]
epic: E15
wave: 1
depends_on: []
---

## Summary

Two small correctness problems in `index.js`: two imports are never used, and one `catch` block discards errors with no logging, hiding malformed-event failures completely.

## The unused imports

```js
const {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,        // never used
  Contract,
  Address,    // never used
} = require("@stellar/stellar-sdk");
```

Harmless at runtime, but they are the first thing a reader sees and they suggest the file uses XDR primitives and the `Address` helper directly, which it does not.

Note before deleting: the topic-filter issue proposes deriving filters at runtime, which may legitimately need `xdr`. Coordinate — if that work lands first, `xdr` becomes used and only `Address` should go.

## The empty catch

```js
for (const event of response.events || []) {
  try {
    const [taskIdVal, , rewardVal, deadlineVal] = event.value.value();
    const taskId = scValToNative(taskIdVal);
    const reward = scValToNative(rewardVal);
    const deadline = scValToNative(deadlineVal);

    tasks.push({ taskId, reward, deadline });
  } catch (e) {
    // Skip malformed events
  }
}
```

This is the more serious of the two. Skipping an event the bot cannot decode is a reasonable policy, but doing it silently is not.

The destructuring assumes `TaskRegistered` event data is a 4-tuple in a fixed order. That assumption is exactly what breaks when the contract's event shape changes — and there is already an open issue to add the proof field to `TaskExecuted`, which shows event shapes here do change. If a future change reorders or extends `TaskRegistered`, every event lands in this catch and the bot reports:

```
📋  Found 0 TaskRegistered events to evaluate
```

Identical to a quiet network. The bot stops earning and nothing says why.

The variable `e` is also bound and never used, which the lint config will flag.

## Expected behaviour

Unused imports are gone. Undecodable events are counted and logged, so a decoding failure is visible rather than indistinguishable from an empty network.

## Suggested approach

```js
let skipped = 0;
for (const event of response.events || []) {
  try {
    // TaskRegistered data is (task_id, owner, reward, deadline); the owner is
    // not needed here.
    const [taskIdVal, , rewardVal, deadlineVal] = event.value.value();
    tasks.push({
      taskId: scValToNative(taskIdVal),
      reward: scValToNative(rewardVal),
      deadline: scValToNative(deadlineVal),
    });
  } catch (err) {
    skipped++;
    if (skipped === 1) {
      // Log the first failure in full — if the event shape has changed, one
      // decoded error is worth more than a hundred counted ones.
      console.warn(`⚠️  Could not decode a TaskRegistered event: ${err.message}`);
    }
  }
}
if (skipped > 0) {
  console.warn(`⚠️  Skipped ${skipped} undecodable event(s) — the contract's event shape may have changed.`);
}
```

Logging the first failure in detail and then counting keeps the output readable when every event fails, without losing the diagnostic.

Add a comment naming the expected tuple shape and pointing at the contract's `emit_task_registered`, so the coupling is discoverable from this side.

## Acceptance criteria

- [ ] No unused imports remain.
- [ ] Undecodable events are counted, and the count is logged when non-zero.
- [ ] The first decoding failure per round logs the underlying error message.
- [ ] A comment documents the expected event tuple shape and references the emitter.
- [ ] `npm run lint` is clean.

## Files

- `examples/keeper-bot/index.js`

## Getting started

Good first issue. Pairs naturally with the ESLint config issue — that one adds the linter, this one fixes what it finds. Taking both in one PR is fine; say so on both issues.
