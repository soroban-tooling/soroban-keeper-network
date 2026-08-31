# Migrating from `@stellar/stellar-sdk`

This guide shows how to migrate contract-interaction code from the raw
`@stellar/stellar-sdk` APIs used by `examples/keeper-bot` to the
typed `@soroban-keeper-network/sdk` client.

The SDK removes repetitive transaction construction, contract invocation,
result decoding, and common error handling while leaving application-level
keeper logic under the control of the integrator.

## What the SDK replaces

The SDK can replace application code responsible for:

- building Soroban transactions for supported registry operations;
- preparing and submitting contract invocations;
- decoding supported contract results and events;
- normalizing SDK-specific contract errors;
- repeatedly implementing the same contract-interaction plumbing.

The SDK does **not** replace:

- keeper retry/backoff policy;
- profitability calculations;
- task-selection strategy;
- off-chain execution;
- application-specific scheduling;
- operational monitoring.

---

## 1. Contract invocation

### Before

The keeper bot manually builds the transaction and invokes the contract
using `@stellar/stellar-sdk`.

```js
// Representative code from examples/keeper-bot/index.js.
const tx = new TransactionBuilder(account, {
  fee,
  networkPassphrase,
})
  .addOperation(
    contract.call(
      "claim_task",
      nativeToScVal(taskId),
    ),
  )
  .setTimeout(timeout)
  .build();

tx.sign(keypair);

const result = await sendTransaction(tx);
