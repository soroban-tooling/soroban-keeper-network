# Soroban Keeper Bot (example)

A beginner-friendly, off-chain keeper for the Soroban Keeper Network. It polls
the registry for `TaskRegistered` events, evaluates candidates, claims and
executes the profitable ones, and withdraws accumulated rewards.

This is an example, not a production keeper. See "Production keepers" below.

## Quick start

```sh
cp .env.example .env
# Fill in REGISTRY_CONTRACT_ID and KEEPER_SECRET_KEY, then:
npm install
node index.js
```

For a single round (for example from cron):

```sh
node index.js --once
# or: RUN_ONCE=true node index.js
```

In dry-run mode no signing key is required and no transactions are submitted;
decisions are logged as JSON lines so you can compare configurations:

```sh
DRY_RUN=true node index.js --once
```

## Configuration

All settings come from the environment (or `.env`). The full annotated list is
in [`.env.example`](.env.example). The essentials:

| Variable | Meaning |
| --- | --- |
| `NETWORK` | `testnet`, `futurenet` or `mainnet` (default `testnet`) |
| `REGISTRY_CONTRACT_ID` | Deployed `KeeperRegistry` contract id (`C...`) |
| `KEEPER_SECRET_KEY` | Keeper signing seed (`S...`). Not needed in dry-run mode |
| `POLL_INTERVAL_MS` | Milliseconds between rounds, minimum 1000 (default 10000) |
| `MAX_TASKS_PER_ROUND` | Round budget (default 5) |
| `MIN_PROFIT_MARGIN_STROOPS` | Minimum net profit before a task is claimed |
| `DRY_RUN` | Evaluate and log decisions without submitting transactions |
| `METRICS_PORT` | Optional Prometheus endpoint port (see below) |

Further guides: [EXAMPLES.md](EXAMPLES.md) and [DRY_RUN.md](DRY_RUN.md).
Tests live in [`test/`](test/README.md).

## Metrics

Metrics are **off by default**. Set `METRICS_PORT` to a valid port to expose
`GET /metrics` on `127.0.0.1`:

```sh
METRICS_PORT=9464 node index.js
```

The endpoint uses only Node's standard library (`metrics.js`), so no new npm
dependency is added to this example. It exposes these counters:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `soroban_keeper_rounds_total` | none | Polling rounds started |
| `soroban_keeper_tasks_evaluated_total` | none | Candidate tasks evaluated |
| `soroban_keeper_tasks_claimed_total` | none | Tasks claimed |
| `soroban_keeper_tasks_executed_total` | none | Tasks executed |
| `soroban_keeper_tasks_skipped_total` | `reason` | Tasks skipped, by bounded reason |
| `soroban_keeper_rpc_errors_total` | `error_type` | Errors, by bounded type |

Names match `examples/keeper-bot-v2` wherever the meaning is the same. The
canonical catalogue, label rules and exposure advice are in
[`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md).

Error messages and URLs are never used as label values: an RPC provider URL can
embed an API key. The server binds to loopback only and has no authentication,
so put an authenticating reverse proxy or an SSH tunnel in front of it before
scraping it from another host. See the exposure recommendation in the
observability doc.

## Production keepers

Before running against real funds, add:

- a persistent task-state store to avoid double-claiming;
- MEV-aware submission for bundles;
- alerting on missed executions;
- an authenticated metrics endpoint as described above.

The executor interface in `index.js` (`EXECUTORS`) is deliberately simulated in
this example. Register a real executor for each `task_type` you intend to
handle; with no executor, the bot refuses the task rather than faking a proof.
