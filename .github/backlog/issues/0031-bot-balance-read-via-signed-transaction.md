---
title: "fix(keeper-bot): keeper_balance is read by submitting a signed transaction instead of simulating"
labels: [keeper-bot, bug, intermediate]
epic: E15
wave: 1
depends_on: []
---

## Summary

The bot reads its reward balance by building, signing, submitting, and waiting for confirmation of a real Stellar transaction. `keeper_balance` is a read-only view. Every polling round therefore pays a network fee and burns a sequence number to read a number that simulation returns for free.

## Current behaviour

`invokeContract` always goes through `simulateAndSend`, which signs and submits:

```js
const preparedTx = SorobanRpc.assembleTransaction(tx, simResponse).build();
preparedTx.sign(keypair);

const sendResponse = await server.sendTransaction(preparedTx);
```

and the balance check calls it like any mutation:

```js
const balanceResult = await invokeContract(
  server, keypair, networkPassphrase, contractId, "keeper_balance",
  [nativeToScVal(keypair.publicKey(), { type: "address" })]
);
```

## The cost

`POLL_INTERVAL_MS` defaults to 10 seconds, and the balance check runs every round unconditionally — so roughly 8,640 submitted transactions per day to read a view. That is:

- A transaction fee per round, paid to learn a number the bot usually already knows.
- A sequence number consumed per round, which serialises the bot's account and means a balance read in flight blocks any claim or execute the bot wants to submit.
- ~30 seconds of worst-case latency per round in `simulateAndSend`'s confirmation poll, against a 10-second poll interval.

The last point is the one that bites. The confirmation loop polls up to 30 times at 2-second intervals. A slow round overlaps the next, and while `runRound` guards against concurrent rounds with `roundInFlight`, the practical effect is that the bot spends most of its time waiting on a read.

## Expected behaviour

Read-only views are evaluated by simulation. No transaction is signed, submitted, or confirmed, and no sequence number is consumed.

## Suggested approach

Add a separate read path rather than adding a flag to `invokeContract` — the two operations have genuinely different semantics and merging them invites calling the wrong one:

```js
/**
 * Evaluates a read-only contract function via simulation.
 *
 * No transaction is submitted and no sequence number is consumed, so this is
 * safe to call on every polling round. Use `invokeContract` for anything that
 * mutates state.
 */
async function readContract(server, sourcePublicKey, networkPassphrase, contractId, method, args) {
  const account = await server.getAccount(sourcePublicKey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  return sim.result ? scValToNative(sim.result.retval) : null;
}
```

Route `keeper_balance` through it. While you are there, check the other read-only views the bot could use — `get_task`, `is_claimable`, `task_count`, `min_reward` — since several later improvements depend on cheap reads being available.

Consider also whether the balance needs checking every round at all. The bot knows what it was credited, so it could track the balance locally and only confirm before withdrawing. Simulation makes the read cheap enough that this is optional, but say what you decided.

## Acceptance criteria

- [ ] A distinct read path evaluates views by simulation, with a doc comment stating it submits nothing.
- [ ] `keeper_balance` uses it.
- [ ] No transaction is submitted for any read-only call — verify against testnet and note the observation in the PR.
- [ ] `withdraw_rewards` still goes through the submitting path, since it mutates state.
- [ ] Simulation errors are surfaced with the same clarity as the current path.
- [ ] The bot's header comment is updated if it describes the old behaviour.

## Files

- `examples/keeper-bot/index.js`

## Verification

Run against testnet and compare the account's transaction count before and after several polling rounds. Only claims, executions, expiries, and withdrawals should appear.
