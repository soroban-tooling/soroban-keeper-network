# Operating keeper-bot-v2 in production

A guide for the people who run [`examples/keeper-bot-v2`](../examples/keeper-bot-v2)
against a real deployment: how to size it, what to monitor, how to bound what
it spends, how to get rewards out, and how to upgrade and back it up.

Every recommendation below names the configuration variable (or the code-level
setting) that controls it. Variables are validated at startup by
[`src/config.ts`](../examples/keeper-bot-v2/src/config.ts) unless a section says
otherwise, and the ready-to-copy template is
[`.env.example`](../examples/keeper-bot-v2/.env.example).

## Read this first: what is wired up today

The package has two halves (see its
[README](../examples/keeper-bot-v2/README.md#layout)), and not every operational
knob below is an environment variable:

| Capability | Where it lives | How you configure it |
|---|---|---|
| Startup validation, metrics server, PostgreSQL state store, signing-pool class | `src/` (TypeScript, the `npm start` process) | Environment variables |
| Round loop pieces: spend ceiling, withdrawal strategies, graceful drain, hot reload | `bot/` (CommonJS) | Environment variables read by `bot/config.js`, or constructor options |
| Alerting (`AlertManager`, webhook transport) | `src/alerts.ts` | **Code only**: `createAlertManager({...})`. There is no alert environment variable. |
| Withdrawal strategy selection | `bot/withdrawal.js` | **Code only**: you construct the strategy. `WITHDRAW_THRESHOLD` feeds the default one. |

At the time of writing, `KeeperBotV2.runRound()` in
[`src/index.ts`](../examples/keeper-bot-v2/src/index.ts) records round timing but
leaves the RPC polling as a placeholder comment; the claim, execute and
withdraw logic is in the library modules you compose into your own entry point.
Treat the sections below as the operating contract for those pieces and check
the source before you rely on a behaviour in production.

## 1. Choose a topology

One bot process plus one PostgreSQL database is the supported shape.
[`docker-compose.yml`](../examples/keeper-bot-v2/docker-compose.yml) is a
working reference; [`DEPLOYMENT.md`](../examples/keeper-bot-v2/DEPLOYMENT.md)
covers how configuration reaches the process on Kubernetes, ECS and plain
Docker.

- Run **one bot process per signing-account set.** Two processes sharing a
  signing key race each other's sequence numbers.
- Pin the network with `NETWORK` (`testnet`, `futurenet` or `mainnet`; default
  `testnet`) and the registry with `REGISTRY_CONTRACT_ID` (must be a valid `C...`
  contract id or the process exits at startup).
- Rehearse every change with `RUN_ONCE=true` (or `npm start -- --once`): one
  round, then a clean exit.
- Never run with `SIMULATE_EXECUTION=true` against a real deployment. It
  fabricates proofs for task types that have no real executor and exists for
  development only.

## 2. Size the signing pool

A Stellar account has a single sequence number, so one account serialises every
transaction it submits. More concurrency needs more accounts.

| Decision | Variable | Rule enforced at startup |
|---|---|---|
| How many tasks run at once | `MAX_CONCURRENT_TASKS` (default `1`) | Must be `>= 1`, must not exceed the number of signing accounts when `SECRET_BACKEND=env`, and must not exceed `MAX_TASKS_PER_ROUND` |
| How many tasks a round looks at | `MAX_TASKS_PER_ROUND` (default `5`) | Must be `>= 1` |
| The signing accounts | `KEEPER_SECRET_KEY` (one) or `SIGNING_KEY_POOL` (comma-separated, supersedes the single key) | Every entry must be a valid `S...` secret seed |
| Which account takes the next task | `KEEPER_POOL_STRATEGY`: `round-robin` (default) or `least-loaded` | Read by the `AccountPool` in `src/accounts.ts` |

Sizing guidance:

1. Start with one account and `MAX_CONCURRENT_TASKS=1`. Raise concurrency only
   when metrics show tasks being skipped because the round ran out of time
   (see section 5).
2. Keep the pool size equal to `MAX_CONCURRENT_TASKS`. Extra idle accounts
   still need funding and still hold separate reward balances.
3. Set `MAX_TASKS_PER_ROUND` to at least `MAX_CONCURRENT_TASKS`, and large
   enough that a round is not cut short while profitable tasks wait.
4. Fund every account independently with enough XLM for fees. Each account
   also earns, and must withdraw, its own on-chain `keeper_balance`.

> **Pool variables differ between the two code paths.** Startup validation
> (`validateConfig`) reads `SIGNING_KEY_POOL`. `parseAccountPoolFromEnv()` in
> `src/accounts.ts` reads `KEEPER_SECRET_KEYS`, then `KEEPER_SECRET_KEY_0`,
> `KEEPER_SECRET_KEY_1`, ..., then `KEEPER_SECRET_KEY`. If you build your
> entry point on `AccountPool`, set the variables the parser you call actually
> reads, and keep the two lists identical. The full account-setup walkthrough
> is [`MULTI_ACCOUNT_SETUP.md`](../examples/keeper-bot-v2/docs/MULTI_ACCOUNT_SETUP.md).

### Keep secrets out of the process environment where you can

`SECRET_BACKEND` selects where signing keys come from: `env` (default),
`vault` (requires `VAULT_ADDR`) or `aws_secrets_manager` (requires
`AWS_SECRET_NAME`). Startup fails if the variable for the chosen backend is
missing. Secret values are redacted in configuration errors. Whatever the
backend, never commit `.env` and never bake keys into an image; the compose
file passes them at runtime.

## 3. Run PostgreSQL

Persistence is optional but you should treat it as required in production.

- `DATABASE_URL` enables it. With it unset the bot keeps task state in memory
  and forgets every outcome on restart.
- On start the bot creates the `keeper_task_outcomes` table and its indexes if
  they are missing (`CREATE ... IF NOT EXISTS`), then loads the set of
  already-processed task ids. There is no separate migration tool, so a
  schema change ships with a bot upgrade.
- Under Docker Compose the connection string is assembled from `DB_USER`,
  `DB_PASSWORD` and `DB_NAME`. Set `DB_PASSWORD` to a strong value; the
  template's placeholder is deliberately invalid for production.
- The compose file publishes port `5432` for local debugging. **Remove that
  mapping in production** and keep the database on a private network.

Postgres sizing is modest: one row per task the bot has touched. Size disk for
retention and backups rather than throughput.

## 4. Bound what the bot can spend

Four independent controls limit fee spend and unprofitable work. Use all of them.

| Control | Variable | Default | Effect |
|---|---|---|---|
| Hard per-round fee ceiling | `FEE_CEILING_STROOPS` | `1000000` | No fee the bot pays is allowed to exceed it |
| Adaptive fee target | `FEE_PERCENTILE` (`p10`, `p50`, `p90`, `p99`) and `FEE_MULTIPLIER` | `p90`, `1.1` | Which recent network fee percentile to follow, and the headroom on top of it |
| Minimum profit to claim | `MIN_PROFIT_MARGIN_STROOPS` | `0` | A task is skipped unless its net profit (reward minus claim, execute and withdraw fees) clears this margin |
| Per-round spend backstop | `MAX_ROUND_SPEND_STROOPS` | `5000000` | The round loop halts further submissions once this much has been spent in one round |

Guidance:

- Set `FEE_CEILING_STROOPS` deliberately; do not inherit the default. It must
  be at least `MIN_PROFIT_MARGIN_STROOPS`, or startup fails with a cross-field
  error, because no task could ever be profitable.
- Pick `FEE_PERCENTILE` for how competitive you need to be: `p50` saves money
  and loses races, `p99` wins races and costs more. Raise `FEE_MULTIPLIER`
  before raising the percentile for a smaller step.
- When the RPC fee statistics are unavailable the bot falls back to `BASE_FEE`
  rather than guessing.
- `FEE_PERCENTILE` and `FEE_MULTIPLIER` are read by `loadFeeConfig()` in
  `src/config.ts`, not by the startup `validateConfig()` pass, and
  `MAX_ROUND_SPEND_STROOPS` is read by `bot/config.js`. A typo in them is
  reported when that loader runs, so exercise it with `RUN_ONCE=true` after
  every change.
- Note that `loadFeeConfig()` falls back to `10000` for `FEE_CEILING_STROOPS`
  when called standalone, while `validateConfig()` falls back to `1000000`.
  Set the variable explicitly so both agree.

### Retry settings

`MAX_RETRIES` (default `3`) and `RETRY_BASE_MS` (default `500`) control the
exponential backoff for transient RPC errors. Startup rejects a combination
where `RETRY_BASE_MS * 2^MAX_RETRIES` exceeds ten times `POLL_INTERVAL_MS`, since
retries would then overlap the next round. Contract rejections are never
retried.

## 5. Metrics, health and alerts

### Endpoints

`METRICS_ENABLED` (default `true`) starts an HTTP server on `METRICS_PORT`
(default `9090`):

| Path | Returns |
|---|---|
| `/metrics` (also `/`) | Prometheus text exposition |
| `/healthz` | `{"status":"ok"}` whenever the process is serving requests |

`/healthz` is a liveness check only. It does not test the database, the RPC
node or the signing account, so do not use it alone to decide the bot is
working; alert on the metrics below. The server has no authentication and
listens on all interfaces, so expose it only to your Prometheus scraper
(firewall, security group or `NetworkPolicy`).

### Metrics to watch

| Metric | Type | What it tells you |
|---|---|---|
| `soroban_keeper_tasks_evaluated_total` | counter | Rounds are running and seeing work |
| `soroban_keeper_tasks_claimed_total`, `..._executed_total` | counter | Claims versus completions; a growing gap means claimed tasks are being missed |
| `soroban_keeper_tasks_skipped_total{reason}` | counter | Why work is skipped. The round loop in `bot/loop.js` records `lost_claim_race`, `unprofitable`, `spend_ceiling_reached`, `already_in_flight` and `unsupported_executor` |
| `soroban_keeper_net_profit_stroops_total` | counter | Net earnings after fees |
| `soroban_keeper_round_duration_seconds` | gauge | Latest round duration; compare to `POLL_INTERVAL_MS` |
| `soroban_keeper_balance_stroops{address}` | gauge | On-chain reward balance per signing account |
| `soroban_keeper_rpc_errors_total{error_type}` | counter | RPC trouble by type |

Per-task-type variants (`..._by_type{task_type=...}`) exist for claimed,
executed, skipped and net profit.

Example Prometheus alert expressions (tune thresholds to your volume):

```yaml
- alert: KeeperIdle
  expr: increase(soroban_keeper_tasks_evaluated_total[30m]) == 0
- alert: KeeperRpcErrors
  expr: increase(soroban_keeper_rpc_errors_total[10m]) > 20
- alert: KeeperRoundsOverrunning
  expr: soroban_keeper_round_duration_seconds > 10   # POLL_INTERVAL_MS / 1000
- alert: KeeperClaimsNotCompleting
  expr: increase(soroban_keeper_tasks_claimed_total[1h]) - increase(soroban_keeper_tasks_executed_total[1h]) > 5
```

### Built-in alert rules (code-level)

`createAlertManager()` in `src/alerts.ts` wires three rules to an optional
webhook (`webhook.url`, `method`, `headers`, `timeoutMs` defaulting to 5000):

| Rule | Option | Severity |
|---|---|---|
| Claimed task not executed within its lock window | `missedExecution.lockWindowMs` | critical |
| Consecutive rounds with RPC errors | `consecutiveRpcErrors.threshold` | critical |
| Claims made but balance did not grow | `stagnantBalance` (enabled unless `enabled: false`) | warning |

Each incident notifies once and re-fires only after the condition clears. With
no `webhook` configured the manager uses a no-op transport, which silently
drops every alert, so confirm a transport is set in production.

## 6. Withdrawal strategy

Rewards accrue as an on-chain `keeper_balance` per signing account and are
only paid out when withdrawn. Strategies live in `bot/withdrawal.js`:

| Strategy | Behaviour | Settings (constructor options) |
|---|---|---|
| `FixedThresholdStrategy` (default, v1 parity) | Withdraw when balance reaches the threshold | `WITHDRAW_THRESHOLD`, default `10000000` stroops (1 XLM) |
| `FixedScheduleStrategy` | Withdraw on a timer when there is a positive balance | `intervalSeconds` (3600), `minBalance` (1) |
| `FeeAwareThresholdStrategy` | Use a lower threshold while network fees are low | `normalThreshold` (10000000), `lowFeeThreshold` (2000000), `lowFeeCutoff` (100 stroops base fee) |

Choosing:

- **Fixed threshold** is the right default. Raise `WITHDRAW_THRESHOLD` so a
  withdrawal's fee is a negligible fraction of what it moves.
- **Fixed schedule** suits operators who reconcile on a calendar (for example
  daily) and want predictable payouts.
- **Fee-aware** suits large pools on a congested network, where waiting for a
  cheap window saves real fees across many accounts.
- With a pool, withdrawals are per account: N accounts means N withdrawal
  calls. The fee for each counts against profitability, so a pool of small
  balances is better served by a higher threshold.

`WITHDRAW_THRESHOLD` is hot-reloadable (see below).

## 7. Change configuration safely

The `bot/` components re-read these before each round, so a change applies
within one round without a restart: `POLL_INTERVAL_MS`, `WITHDRAW_THRESHOLD`,
`MAX_TASKS_PER_ROUND`, `MAX_RETRIES`, `RETRY_BASE_MS`, `EXPIRE_STALE_TASKS`,
`MIN_PROFIT_MARGIN_STROOPS` and `SIMULATE_EXECUTION`.

- An invalid value aborts the whole reload and the previous configuration
  stays in force; changes are all-or-nothing.
- `NETWORK`, `REGISTRY_CONTRACT_ID`, `KEEPER_SECRET_KEY` and `DRY_RUN` need a
  restart. A change is logged as a warning and not applied.
- Everything validated only by `src/config.ts` (pool, `DATABASE_URL`,
  `MAX_CONCURRENT_TASKS`, `FEE_CEILING_STROOPS`, `METRICS_*`,
  `CONDITION_BACKOFF_MS`, `SECRET_BACKEND`) is read once at startup.

Two settings worth deciding explicitly:

- `EXPIRE_STALE_TASKS` (default `true`) calls `expire_task` on past-deadline
  tasks to refund their creators. It costs fees; turn it off if you do not want
  to subsidise that.
- `CONDITION_BACKOFF_MS` (default `60000`, minimum `1000`) is how long a task
  whose condition is unmet waits before being checked again.

## 8. Upgrades and restarts

1. Rehearse on testnet with the new build and `RUN_ONCE=true`.
2. Read the [migration guide](KEEPER_BOT_V2_MIGRATION.md) and the changelog for
   configuration changes.
3. Take a database backup (section 9) before deploying a version that may
   change the schema.
4. Roll the bot: stop, deploy, start. On `SIGINT` or `SIGTERM` the bot stops
   taking new work, lets in-flight submissions finish and persist, then closes
   the metrics server and the database connection. The drain is bounded
   (`maxDrainMs`, default 10 seconds, in `bot/shutdown.js`), and compose's
   `stop_grace_period: 30s` leaves headroom. In Kubernetes set
   `terminationGracePeriodSeconds` to at least the same value, or the pod is
   killed mid-drain.
5. Watch `/metrics` for a full round: `soroban_keeper_tasks_evaluated_total`
   should rise and `soroban_keeper_rpc_errors_total` should stay flat.

Because there is one process per signing-account set, a restart means a short
gap in coverage. Other keepers compete for the same tasks, so schedule
planned restarts for quiet periods.

## 9. Back up and restore

What is worth backing up:

| Item | Why | How |
|---|---|---|
| PostgreSQL `keeper_task_outcomes` | Lets a restarted bot skip tasks it already handled | `pg_dump` on a schedule; test a restore |
| Signing keys | Losing them strands that account's balance | Keep them in your secret backend (`SECRET_BACKEND`) with its own backup |
| Your `.env` / deployment manifest | Reproducible configuration | Version it **without** secrets |

If the database is lost, the bot starts from an empty state and re-evaluates
tasks. The contract remains the source of truth for task status, so nothing
on-chain is lost, but the bot may spend fees re-checking work it already
completed. Restore the latest dump before starting the bot where you can.

## 10. Runbooks and further reading

Existing operational documents:

- [Multi-account setup](../examples/keeper-bot-v2/docs/MULTI_ACCOUNT_SETUP.md): funding, per-account withdrawals, pool strategies.
- [Deployment guide](../examples/keeper-bot-v2/DEPLOYMENT.md): configuration flow and container runtime behaviour.
- [Migration from v1](KEEPER_BOT_V2_MIGRATION.md): operational requirements and the step-by-step upgrade.
- [Design rationale](KEEPER_BOT_V2_DESIGN.md): shutdown, scheduling and withdrawal architecture.
- [Security review](KEEPER_BOT_V2_SECURITY_REVIEW.md): threat model and key handling.
- [Deploying and running](DEPLOYING.md) and [CI](CI.md).

Incident runbooks are tracked as backlog items and are **not yet written**;
this guide will link them when they land:

- [Keeper account out of XLM](../.github/backlog/issues/0485-obs-runbook-bot-unfunded.md)
- [RPC outage](../.github/backlog/issues/0484-obs-runbook-rpc-outage.md)
- [Registry paused](../.github/backlog/issues/0486-obs-runbook-contract-paused.md)
- [Indexer lag](../.github/backlog/issues/0483-obs-runbook-indexer-lag.md)

Until then, the quick triage is: check `/healthz`, check
`soroban_keeper_rpc_errors_total` and the per-account
`soroban_keeper_balance_stroops`, and run `RUN_ONCE=true` to reproduce a
failure in isolation.
