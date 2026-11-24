# Runbook: registry paused

## When to use this

The registry's `paused` flag is `true`. An admin paused it during an incident,
and you need to know what each component is doing and how to unpause safely.
This runbook describes the current `main` behaviour of the contract, the two
keeper bots, the CLI and the indexer. The pause itself is an admin action. This
runbook does not decide whether an unpause is safe for your deployment.

## What a pause changes

The contract's `require_not_paused` guard is checked on chain, so a paused
registry rejects state-changing calls before any state is written. Read-only
views keep working. Callers see `KeeperError::ContractPaused` (contract error
code `ContractPaused`) on a blocked call.

| Entry point | While paused | Consequence |
| --- | --- | --- |
| `register_task` | blocked | New work cannot enter the registry |
| `claim_task` | blocked | A pending task stays pending; no lock is taken |
| `execute_task` | blocked | A task claimed before the pause stays claimed |
| `increase_reward`, `extend_deadline` | blocked | Owners cannot change an existing task |
| `cancel_task`, `expire_task` | allowed | Owners and callers can still refund and close tasks, including while paused |
| `withdraw_rewards` | allowed | Keepers can still collect already credited rewards |
| Staking, batch registration, admin parameter changes | blocked | Deferred until unpause |
| All read-only views | allowed | Inspection and dashboards keep working |

This matrix is asserted entry point by entry point in
`contracts/keeper-registry/src/test/admin.rs`, so treat that test as the source
of truth if a future version changes the policy.

## What each component sees

### Keepers (v1 example bot and v2 bot)

Both bots keep polling. Every attempted claim and execution is rejected on
chain with `ContractPaused`. In the v1 bot the SDK classifies a contract
rejection as a permanent error, so the line

```
<operation> failed (attempt 1), retrying in <delay>ms: ... simulation failed ...
```

is followed by no further retries for that task. The v1 round summary prints
`Keeper round finished with N error(s)`; a v1 bot with `METRICS_PORT` set still
exports `soroban_keeper_rounds_total` while no claims or executions are
recorded. The v2 bot likewise keeps incrementing rounds but records no
`soroban_keeper_tasks_claimed_total` or `soroban_keeper_tasks_executed_total`.
A paused registry therefore looks like a very quiet, healthy bot unless you
also look at the contract's `paused` flag. Do not interpret a flat claimed or
executed counter alone as "no work available".

### Task owners

`register`, `increase-reward` and `extend-deadline` operations fail with
`ContractPaused` (CLI exit code `4`). `cancel` and `expire` still work. A task
whose deadline passes during the pause can still be expired, and that refund
is final; check deadlines before a long pause. Claims taken before the pause
survive it and their locks keep running, so a claimed task can become
expirable while execution is unavailable.

### Indexer

The indexer is not gated by the pause. It keeps ingesting events, folds the
`Paused` event into `AdminConfig.paused`, and continues to serve reads.

- `GET /v1/admin/config` reports `paused: true` once the event is ingested.
- `GET /v1/health` keeps reporting `healthy: true` if ingestion is caught up.
  A healthy indexer does not mean the contract is accepting work.
- `soroban_indexer_events_ingested_total{event_type="paused"}` counts the
  pause event. If `INDEXER_LOG_FORMAT=json`, the same pass carries
  `component="indexer"` and `event_count`.
- Other `soroban_indexer_events_ingested_total` series stop growing for the
  blocked actions, because no such events are emitted.

### CLI

`skn inspect` and the other read-only views work. `skn task register`,
`increase-reward` and `extend-deadline` fail with `ContractPaused`. The
`skn admin unpause` command is used below; on mainnet it requires
`--confirm-mainnet`.

## Unpause checklist

Run these steps in order. Record the incident id and the admin signer in the
change log before step 6.

1. Confirm the pause was intentional and that the underlying incident is
   resolved. Identify who holds the admin key and who authorises the unpause.
2. Confirm the registry is the one in the incident. Compare the configured
   contract id with `skn inspect --contract-id <id> --network <network>` and
   note the current `version` and `paused` output.
3. Confirm the indexer has ingested the pause event and is caught up:
   `GET /v1/admin/config` shows `paused: true`, and `GET /v1/health` shows
   `healthy: true` with `ingestion_lag_ledgers` at or below
   `max_healthy_lag_ledgers`. If the lag is high, wait rather than acting on a
   stale view.
4. inventory the work that cannot be done while paused. Query open tasks with
   `GET /v1/feeds/open-tasks` and note any deadline that passes before the
   planned unpause. Those tasks may be expired and refunded. Decide whether
   that is acceptable before continuing.
5. Check the keepers are alive and will resume: `soroban_keeper_rounds_total`
   (v1 with `METRICS_PORT` set) or the v2 round logs are still advancing, and
   RPC connectivity is intact. A keeper process that exited during the pause
   must be restarted before the unpause, or its tasks will simply wait.
6. Unpause with the admin key:
   `skn admin unpause --network <network> --contract-id <id>` (add
   `--confirm-mainnet` on mainnet). The command displays the current value,
   the new value and a confirmation prompt before submitting. It refuses on
   mainnet without the explicit flag.
7. Confirm the chain state changed. `skn inspect` shows `paused: false`, and
   the indexer emits a second `Paused` event with `paused: false`. Wait for
   `GET /v1/admin/config` to report `paused: false` rather than trusting the
   transaction receipt alone.
8. Verify recovery: `soroban_keeper_tasks_claimed_total` and
   `soroban_keeper_tasks_executed_total` start increasing again, the v1
   `Keeper round finished with N error(s)` line disappears, and
   `soroban_keeper_rpc_errors_total` does not spike. Check one known task with
   `skn task` or `GET /v1/tasks/{task_id}` to confirm it moved off pending.
9. Record the unpause time, the admin signer and the first successful
   execution in the incident log, then close the incident.

## If the unpause does not take effect

- A `ContractPaused` error after step 6 means the transaction used a stale
  contract id, the indexer view is behind, or the unpause transaction did not
  land. Recheck `skn inspect` against the chain and the indexer separately.
- Bots that still report no claims after the flag is false are a keeper
  problem, not a pause problem. Follow `keeper-unfunded.md` next.
