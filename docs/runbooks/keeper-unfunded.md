# Runbook: keeper account running out of XLM

## When to use this

A keeper has stopped claiming or executing tasks even though there is open
work, its process is still running, and the registry is not paused. The usual
cause is that the account has too little native XLM to pay transaction fees.
This is different from the reward balance: `soroban_keeper_balance_stroops`
reports the reward token balance from the registry's `keeper_balance` view,
which can be large while the native XLM balance is zero. Never treat that
gauge as proof that the keeper can submit transactions.

There is no dedicated native-XLM-balance metric today. Detection therefore
uses a concrete log line plus a direct balance query, described below.

## Detection

Pick the signal that matches your bot.

### v1 example bot (`examples/keeper-bot`)

The bot prints one of these lines when a signed submission fails:

```
Keeper loop error: <error message>
Keeper round finished with N error(s)
Fatal keeper loop error: <error message>
```

A contract rejection is classified as permanent and logged once by the retry
helper:

```
<operation> failed (attempt 1), retrying in <delay>ms: <error message>
```

Look for messages containing `insufficient balance`, `fee`, `simulation
failed` or `account not found`. The `Keeper round finished with N error(s)`
line with no corresponding claim or execution is the earliest sign. With
`METRICS_PORT` set, `soroban_keeper_rounds_total` keeps increasing while
`soroban_keeper_tasks_claimed_total` and
`soroban_keeper_tasks_executed_total` stay flat; that combination is the
metric-level signal.

### v2 bot (`examples/keeper-bot-v2`)

The bot logs its start banner with every signing key's public address:

```
[KEEPER-BOT-V2] Starting on network '<network>' with registry '<id>'
[KEEPER-BOT-V2] Signing pool size: <n> worker(s), ...
```

Round logs keep appearing while the claimed and executed counters stay flat.
`soroban_keeper_rpc_errors_total{error_type="..."}` is the metric to watch for
RPC-side failures; note that it is only populated when the bot records an RPC
error through its metrics collector, so an absent series is not proof that
nothing failed. Check the log lines for the account that was selected for the
failed task.

### Confirm with a balance query

For each signing address `G...`, query the native balance on the same network
the bot uses:

```sh
stellar account info --network testnet --address <G...>
```

Or call the RPC `getAccountInfo` method directly. Compare the result with the
fee budget: a keeper needs enough XLM for the base fee times the number of
in-flight tasks plus the reserve for its account. A balance at or near the
minimum reserve is already effectively unfunded even if the account still
exists. Do not fund from the reward balance; it is a separate token.

## Recovery for a single-account keeper

Run these steps in order.

1. Record the keeper's public address, the network, the contract id and the
   first failing log line. Keep the exact timestamp so you can match it to a
   round.
2. Confirm the registry is not paused. `GET /v1/admin/config` should show
   `paused: false`, and `skn inspect` should report the same. If it is paused,
   follow `contract-paused.md` first.
3. Confirm the bot process is alive and the RPC endpoint responds. A dead bot
   or a bad RPC URL produces the same flat counters.
4. Query the native XLM balance for the address. If it is at or below the
   reserve plus a few fees, fund it from a source account on that network:

   ```sh
   stellar keys fund <keeper-key-name> --network testnet
   ```

   On mainnet, transfer XLM from your treasury or operational account instead
   of using friendbot. Do not paste a secret key into a shared shell.
5. Re-query the balance and confirm it increased by the expected amount.
6. Watch the next round. In v1, `Keeper round finished with N error(s)` should
   stop appearing and `Accumulated reward balance: <n> stroops` should be
   logged again. In v2, the claimed or executed counter should increase. If
   neither happens, go back to step 2 and check for a different contract
   error.
7. Record the funded amount, the transaction hash and the first successful
   execution in the incident log.

## Recovery for a multi-account pool

The v2 bot has a signing pool. It selects the least-loaded account for each
task, so one empty account fails only the tasks assigned to it and can look
like intermittent, low-volume bad luck. Fund every account, not just the one
in the first error line.

1. Get the full address list from the v2 start banner, or from the configured
   secret backends in the order the bot loads them. Each entry in
   `AccountPool` has a `publicKey`; all of them must have a native balance.
2. For each address in turn, run the single-account detection steps above.
   Record the balance next to the address in a table. Do not assume equal
   balances: the least-loaded selector uses pending task counts, not XLM.
3. Fund every address whose balance is at or near the reserve. If one funding
   transaction fails, stop and recheck that address before continuing; a
   partially funded pool still fails intermittently.
4. Re-query all addresses and confirm every one is above the reserve.
5. Watch `soroban_keeper_tasks_claimed_total` and
   `soroban_keeper_tasks_executed_total` for several rounds. If failures
   persist, correlate the failing task's account with the pool table. A single
   address that keeps failing after funding has a different problem, such as
   a revoked key or a stale sequence number.
6. Record each funded address, amount and transaction hash. Note which
   account had the original failure.

## Why a keeper can stop without a metric spike

A fee shortfall is usually rejected during simulation or transaction
submission, before an event is emitted, so the indexer's
`soroban_indexer_events_ingested_total` does not change. The v1 bot's retry
helper treats a contract-level failure as permanent and does not retry it in
later rounds, so the same task fails once and then simply sits pending. The
flat counters plus a failing log line are the reliable signal. An alert on
`soroban_keeper_rounds_total` alone will not catch this failure mode.
