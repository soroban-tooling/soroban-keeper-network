# Soroban Keeper Bot v2

**This is the operator-grade keeper bot.** It is aimed at teams running a keeper
competitively — with persistent task state, concurrent round processing, and
runtime-tunable configuration — not at newcomers exploring the Keeper Network
for the first time.

> **Looking for a simple starting point?**  
> See [`examples/keeper-bot`](../keeper-bot) — a single-file, dependency-light
> example that is deliberately kept beginner-friendly.

---

## Configuration and hot reloading

All configuration is read from environment variables (copy `.env.example` to
`.env` and fill in your values).

Configuration values are divided into two categories:

### Hot-reloadable

These values are re-read from the environment before every evaluation round.
A change takes effect within one round — no restart required.

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `10000` | Polling interval in milliseconds (integer, ≥ 1000) |
| `WITHDRAW_THRESHOLD` | `10000000` | Auto-withdraw when balance exceeds this (stroops) |
| `MAX_TASKS_PER_ROUND` | `5` | Maximum tasks processed per round (integer, ≥ 1) |
| `MAX_RETRIES` | `3` | Retry attempts for transient RPC errors (integer, ≥ 0) |
| `RETRY_BASE_MS` | `500` | Base delay for exponential back-off (integer, > 0) |
| `EXPIRE_STALE_TASKS` | `true` | Call `expire_task` on past-deadline tasks |
| `MIN_PROFIT_MARGIN_STROOPS` | `0` | Skip tasks below this net profit threshold |
| `SIMULATE_EXECUTION` | `false` | Dev-only: fabricate proofs when no real executor exists |

### Restart-required

These values are consumed during process initialisation. Changing them requires
a restart. If a change is detected at reload time, it is logged as a warning —
it is **never silently ignored** and **never partially applied**.

| Variable | Description |
|---|---|
| `NETWORK` | `testnet` \| `futurenet` \| `mainnet` |
| `REGISTRY_CONTRACT_ID` | Deployed KeeperRegistry contract ID |
| `KEEPER_SECRET_KEY` | Keeper signing key — never logged, never echoed |
| `DRY_RUN` | Run without submitting transactions (no signing key required) |

### Reload safety guarantees

- **Invalid values are rejected.** The same validation rules enforced at startup
  are enforced on every reload. An invalid environment variable causes the
  entire reload to be aborted; the previous valid configuration is retained.
- **No partial updates.** Either all hot-reloadable changes in a reload pass
  validation and are applied, or none are applied.
- **Restart-required values are never applied mid-run.** Detecting and logging
  a restart-required change does not affect the running process.
- **Secrets are never logged.** `KEEPER_SECRET_KEY` and any other `secret: true`
  field are replaced with `<redacted>` in all change-detection output.

---

## Development

```sh
cp .env.example .env
# fill in your values

npm install
npm test
npm run lint
```

---

## Architecture

Source files live under `src/`:

| File | Responsibility |
|---|---|
| `src/config.js` | Configuration loading, validation, and hot-reload (this issue) |

Further modules — runtime loop, persistent state, concurrency control,
profitability, fee adaptation — are added by subsequent issues in epic E15.
# Keeper Bot v2

A production-ready keeper bot for the Soroban Keeper Network. This is **not** the beginner-friendly example; see `examples/keeper-bot` for that.

v2 is aimed at operators running a keeper competitively, with features v1 lacks:

- **Persistent state**: Task outcomes survive process restarts (issue #0252)
- **Concurrency**: Process multiple tasks in a single round (issue #0253)
- **Profitability checks**: Only claim tasks that are worth the gas (issue #0254)
- **Database-backed storage**: PostgreSQL persistence for task state
- **Pluggable executors**: Richer, discoverable executor interface (issue #0256)

## Quick Start

### Local Development (Daemon Mode)

```bash
cd examples/keeper-bot-v2

# Copy and customize configuration
cp .env.example .env
# Edit .env with your KEEPER_SECRET_KEY, REGISTRY_CONTRACT_ID, and DB credentials

# Start the deployment (keeper-bot + PostgreSQL)
docker-compose up -d

# View logs
docker-compose logs -f keeper-bot

# Stop
docker-compose down
```

### One-Shot Mode (Cron / Serverless)

```bash
# Run a single round then exit
RUN_ONCE=true docker-compose run --rm keeper-bot
```

## Configuration

All configuration is loaded from environment variables. See `.env.example` for the complete list and defaults.

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `KEEPER_SECRET_KEY` | Stellar secret key (starts with S) | `SBXXXXXXX...` |
| `REGISTRY_CONTRACT_ID` | KeeperRegistry contract ID (starts with C) | `CAXXXXXX...` |
| `NETWORK` | Stellar network | `testnet` (or `futurenet`, `mainnet`) |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/keeper_bot` |

### Optional Variables (with Defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | 10000 | Polling frequency (milliseconds) |
| `WITHDRAW_THRESHOLD` | 10000000 | Minimum accumulated rewards before withdrawal (stroops; 1 XLM = 10M stroops) |
| `MAX_TASKS_PER_ROUND` | 5 | Maximum tasks to process per round |
| `MAX_RETRIES` | 3 | Retry attempts for transient errors |
| `RETRY_BASE_MS` | 500 | Base delay for exponential backoff (milliseconds) |
| `EXPIRE_STALE_TASKS` | true | Whether to expire past-deadline tasks |
| `MIN_PROFIT_MARGIN_STROOPS` | 0 | Minimum profit margin to claim a task (stroops) |
| `SIMULATE_EXECUTION` | false | [Dev only] Fabricate proofs instead of calling executor |
| `RUN_ONCE` | false | [Dev only] One-shot mode; exit after single round |

## Secret Handling

**Secrets are never baked into the image.** All sensitive configuration is supplied at runtime via environment variables or `.env` file.

### Security Best Practices

1. **Never commit `.env`**: Ensure `.gitignore` includes `.env`
2. **Restrict file permissions**: `chmod 600 .env`
3. **Use a secrets manager in production**: 
   - For Kubernetes: use Secrets
   - For Docker Swarm: use Secrets
   - For AWS: use AWS Secrets Manager
   - For other platforms: inject via your orchestration tool
4. **Validate before logging**: Configuration validation never includes secret values in error messages

Example error output (safe to log):
```
Invalid KEEPER_SECRET_KEY — must be a valid Stellar secret seed (starts with S)
```

Notice: the actual key is never shown, only the variable name and reason.

## Database

keeper-bot-v2 requires PostgreSQL for persistent state. The compose example includes a PostgreSQL service, but you can use any PostgreSQL instance:

```bash
# Use a managed PostgreSQL service (e.g., AWS RDS, DigitalOcean, Heroku)
docker run \
  -e DATABASE_URL='postgresql://user:pass@my-db.example.com:5432/keeper' \
  -e KEEPER_SECRET_KEY='...' \
  -e REGISTRY_CONTRACT_ID='...' \
  -e NETWORK='testnet' \
  keeper-bot-v2:latest
```

### Schema Migrations

On first run, the bot applies pending migrations automatically. This allows a fresh database to be set up with a single command:

```bash
# Brings a fresh database to the current schema
docker-compose up -d keeper-bot
```

Migrations are idempotent: running the bot against an already-migrated database is safe.

## Deployment Topologies

### Docker Compose (Development / Small Operators)

See `docker-compose.yml` for a complete example with PostgreSQL.

```bash
docker-compose up -d
docker-compose down
docker-compose down -v  # Destroy persisted data
```

### Kubernetes (Production / Enterprise)

Use the Dockerfile with a Helm chart or Kustomize overlays:

```bash
docker build -t keeper-bot-v2:latest .
docker tag keeper-bot-v2:latest your-registry/keeper-bot-v2:latest
docker push your-registry/keeper-bot-v2:latest
```

Then deploy via your orchestration tool, using Kubernetes Secrets for sensitive config:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: keeper-bot-secrets
type: Opaque
stringData:
  KEEPER_SECRET_KEY: SBXXXXXXX...
  DATABASE_URL: postgresql://user:pass@postgres:5432/keeper

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keeper-bot
spec:
  template:
    spec:
      containers:
      - name: keeper-bot
        image: your-registry/keeper-bot-v2:latest
        envFrom:
        - secretRef:
            name: keeper-bot-secrets
        env:
        - name: REGISTRY_CONTRACT_ID
          value: CAXXXXXX...
        - name: NETWORK
          value: testnet
```

### AWS ECS (Fargate / EC2)

Register a task definition with secrets stored in AWS Secrets Manager:

```json
{
  "family": "keeper-bot-v2",
  "containerDefinitions": [
    {
      "name": "keeper-bot",
      "image": "your-account.dkr.ecr.us-east-1.amazonaws.com/keeper-bot-v2:latest",
      "secrets": [
        {
          "name": "KEEPER_SECRET_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:keeper-bot/secret-key"
        },
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:keeper-bot/db-url"
        }
      ],
      "environment": [
        { "name": "REGISTRY_CONTRACT_ID", "value": "CAXXXXXX..." },
        { "name": "NETWORK", "value": "testnet" }
      ]
    }
  ]
}
```

## Graceful Shutdown

The bot listens for `SIGINT` and `SIGTERM`, completing the current round before exiting. When using containers or orchestration:

- Set a reasonable stop timeout: `docker run --stop-timeout 30 ...`
- Configure Pod termination grace period: `terminationGracePeriodSeconds: 30`
- The bot logs "finishing current round then exiting..." on shutdown

## Monitoring and Observability

### Exit Codes

- **0**: Success (one-shot mode) or graceful shutdown
- **1**: Configuration error (missing required variable, invalid value) or runtime error
- **Other**: Unexpected failure

### Logs

All activity is logged to stdout/stderr:

```bash
docker-compose logs keeper-bot
docker-compose logs -f keeper-bot  # Follow
```

Typical log output:

```
Soroban Keeper Network — Keeper Bot v2

  Network  : testnet
  RPC URL  : https://soroban-testnet.stellar.org
  Keeper   : GXXXXXXX...
  Registry : CXXXXXXX...
  Mode     : Poll: every 10s
  Withdraw : when balance ≥ 10000000 stroops

RPC healthy — ledger 1234567

Keeper round at 2024-10-20T12:34:56.789Z
  Found 5 TaskRegistered events to evaluate
  Attempting to claim task 1 (reward: 1000000)...
  Task 1 claimed!
  ...
```

### Metrics

In production, integrate with monitoring tools:

- **Prometheus**: Scrape metrics endpoint (future feature, issue #0257)
- **CloudWatch**: Stream logs to AWS CloudWatch
- **Datadog**: Use log forwarding
- **Custom alerting**: Parse stdout/stderr for `ERROR` or `WARN` prefixes

## Build and Image Details

### Build Command

```bash
docker build -t keeper-bot-v2:latest .
```

### Image Size

The final runtime image is approximately 200–250 MiB (Node.js 20 Alpine + dependencies).

### Base Image

**Runtime**: `node:20-alpine` — Small, security-focused base with Node.js 20 LTS.

### Security

- **Non-root user**: Runs as `keeper:keeper` (uid 1000:1000)
- **No secrets embedded**: All config is runtime-injected
- **Minimal dependencies**: Only production npm dependencies included
- **Health checks**: PostgreSQL health check in compose example

## Development and Contributing

This directory contains the production keeper bot. For contributions:

1. Follow the patterns established in `examples/keeper-bot` (v1)
2. Ensure configuration validation matches v1's `requireEnv()` discipline
3. Never log secret values
4. Test database migrations on a fresh database
5. Update `.env.example` if adding new environment variables

## References

- [Keeper Network Design](../../docs/ARCHITECTURE.md)
- [Keeper Bot v2 Design](../../docs/KEEPER_BOT_V2_DESIGN.md) (when written; issue #0250)
- [Deployment Guide](../../docs/DEPLOYING.md)
- [Indexer Design](../../docs/INDEXER_DESIGN.md) (database patterns)
- Issue #0267: Container image and docker-compose example (this work)
- Issue #0252: Persistent state schema (v2 database feature)

## License

Apache 2.0 — Same as the rest of the soroban-keeper-network repository.
# Soroban Keeper Network - Keeper Bot v2

A TypeScript keeper bot implementation for the Soroban Keeper Network designed for operators running keepers competitively with support for:

- **Multiple signing accounts** for parallelized transaction submission with account pooling strategies
- **Concurrent task processing** within each round
- **Persistent state** across restarts
- **Profitability checks** with real cost + reward calculations
- **Adaptive fees** based on current network conditions
- **Real-time alerting** for missed executions, RPC errors, and balance monitoring
- **Comprehensive metrics** for observability
- **Flexible executor plugins** for custom task types

## Overview

This is **keeper-bot-v2**, aimed at **operators** running a keeper competitively on production networks. It is intentionally more complex than the simple, single-file example at `examples/keeper-bot/`.

**If you're new to the Soroban Keeper Network, start with `examples/keeper-bot/` instead.** It's a great introduction with no external dependencies or persistence layer.

### Key Differences from keeper-bot v1

| Feature | v1 (examples/keeper-bot) | v2 (keeper-bot-v2) |
| --- | --- | --- |
| Language | JavaScript (CommonJS) | TypeScript |
| Complexity | Single file, ~200 LOC | Modular, multiple files |
| Persistence | None | SQLite/Redis |
| Concurrency | Serial (one task at a time) | Parallel (configurable) |
| Signing accounts | One fixed account | Pool of accounts with strategies |
| Profitability | None | Real cost + reward check |
| Adaptive Fees | None | Network-aware fee adjustment |
| Alerting | None | Comprehensive alert system |
| Executor interface | Pluggable (simple) | Pluggable (richer) |
| Target audience | Learners | Production operators |

## Features

### Multi-Account Pool Management

Run concurrent tasks across multiple signing accounts:

- **Round-robin strategy**: Distribute load evenly
- **Least-loaded strategy**: Dynamic balancing based on pending tasks
- **Independent balances**: Each account tracks its own keeper_balance
- **Reward accounting**: Withdraw per-account separately

### Adaptive Fee Management

Queries Soroban RPC for current network fee conditions and adjusts submission fees:

- **Network-aware**: Uses p10, p50, p90, or p99 fee percentiles from recent ledgers
- **Ceiling-bounded**: Never exceeds the operator's configured maximum fee
- **Configurable**: Tunable via environment variables
- **Fallback strategy**: Reverts to BASE_FEE if RPC is unavailable

### Profitability Checks

Before claiming and executing a task, evaluates:

```
Net Profit = Gross Reward - (claim fee + execute fee + withdraw fee)
```

Skip if net profit ≤ 0 — no point paying to lose money.

### Real-Time Alerting

Production-grade alerting with pluggable transports:

- **Missed Execution Detection**: Alerts when claimed tasks are not executed within lock window
- **RPC Error Tracking**: Detects consecutive RPC failures
- **Balance Monitoring**: Warns when keeper balance is stagnant despite activity
- **Webhook Transport**: Generic HTTP endpoint support
- **Extensible**: Add Slack, PagerDuty, Datadog, or custom implementations

### Metrics & Observability

Track operational health with:

- Claimed/executed task counts per account
- Profit metrics and fee statistics
- RPC error rates and round metrics
- Balance changes per account
- Concurrency metrics

### Persistent State & Resilience

- Durable task state tracking across restarts
- SQLite or Redis support
- Graceful shutdown with in-flight transaction settling
- Resume from checkpoint after restart

## Quick Start

### Prerequisites

- Node.js ≥ 18
- A funded Stellar account (or multiple accounts for a pool)
- Connection to a Soroban RPC endpoint (e.g., https://soroban-testnet.stellar.org)

### Installation

```bash
cd examples/keeper-bot-v2
npm install
```

### Configuration

Set environment variables:

```bash
# Single account (backward compatible)
export KEEPER_SECRET_KEY=S...
export REGISTRY_CONTRACT_ID=CA...
export RPC_URL=https://soroban-testnet.stellar.org

# Or: Multiple accounts for parallel submission
export KEEPER_SECRET_KEYS=S...,S...,S...
export KEEPER_POOL_STRATEGY=round-robin

# Optional
export KEEPER_CONCURRENCY=10           # concurrent tasks per round
export KEEPER_DATABASE_URL=./keeper.db  # persistence
export FEE_PERCENTILE=p90               # fee strategy
export FEE_MULTIPLIER=1.1               # urgency multiplier
```

### Running

```bash
npm start

# Or with specific network
NETWORK=testnet npm start
```

## Building and Testing

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` directory.

### Run Tests

```bash
npm test
```

Run tests in watch mode during development:

```bash
npm run test:watch
```

### Type Check

```bash
npm run type-check
```

Verifies TypeScript types without building.

### Linting

```bash
npm run lint
```

Validates code against repository style guidelines.

## Architecture

```
src/
├── accounts.ts          # SigningAccount pool, round-robin/least-loaded strategies
├── accounts.test.ts     # 50+ tests for account pool behavior
├── loop.ts              # Main keeper loop, concurrency, round management
├── profitability.ts     # Cost + reward calculations
├── fees.ts              # Adaptive fee calculation, RPC integration
├── alerts.ts            # Alerting system with webhook transport
├── metrics.ts           # Metrics collection and observability
├── executors/
│   ├── ttl.ts          # TTL extension executor
│   └── ...
├── persistence/
│   ├── schema.ts       # SQLite/Redis schema
│   └── store.ts        # Query/update interface
└── types.ts            # Core interfaces and type definitions
```

### Core Components

- **Account Pool**: Manages multiple signing accounts with distribution strategies
- **Profitability Module**: Evaluates task profitability with actual fees
- **Adaptive Fee Module**: Queries RPC and adjusts fees based on network conditions
- **Alerting System**: Monitors metrics and sends notifications via pluggable transports
- **Metrics Collection**: Aggregates operational data for observability
- **Task Persistence**: Durable state tracking for resilience
- **Executor**: Pluggable task execution strategies

### Alert Rules

#### MissedExecutionRule
Detects when a claimed task is not executed within its lock window.

#### ConsecutiveRpcErrorRule
Detects when consecutive rounds with RPC errors exceed a threshold.

#### StagnantBalanceRule
Detects when the keeper balance is not growing despite claimed activity.

### Deduplication

The AlertManager ensures exactly one notification per incident:

- Fires on first detection
- Suppresses duplicates while condition persists
- Clears incident when condition resolves
- Can re-fire if condition recurs

## Multi-Account Setup

See `docs/MULTI_ACCOUNT_SETUP.md` for complete details. Quick summary:

1. **Fund multiple accounts** on Stellar
2. **Configure the pool** via environment variables
3. **Each account accumulates its own on-chain `keeper_balance`**
4. **Withdraw rewards per-account separately**

Example:

```bash
export KEEPER_SECRET_KEYS="S...,S...,S..."
export KEEPER_POOL_STRATEGY=least-loaded
npm start

# Later: check and withdraw per account
keeper-registry balance GABC123...
keeper-registry withdraw --keeper GABC123...
```

## Environment Variables Reference

### Signing

- `KEEPER_SECRET_KEY` — Single account (backward compatible)
- `KEEPER_SECRET_KEYS` — Comma-separated list of secret keys
- `KEEPER_SECRET_KEY_0`, `KEEPER_SECRET_KEY_1`, ... — Indexed keys
- `KEEPER_POOL_STRATEGY` — `round-robin` (default) or `least-loaded`

### Network

- `REGISTRY_CONTRACT_ID` — Contract ID of keeper-registry
- `RPC_URL` — Soroban RPC endpoint
- `NETWORK` — `testnet` or `mainnet`

### Performance

- `KEEPER_CONCURRENCY` — Max concurrent tasks per round (default: 5)
- `KEEPER_ROUND_INTERVAL_MS` — Milliseconds between rounds (default: 5000)

### Fees

- `FEE_CEILING_STROOPS` — Maximum fee to ever pay
- `FEE_PERCENTILE` — `p10`, `p50`, `p90`, or `p99` (default: p90)
- `FEE_MULTIPLIER` — Urgency multiplier (default: 1.1)

### Persistence

- `KEEPER_DATABASE_URL` — SQLite or Redis connection (default: `./keeper.db`)

### Observability

- `LOG_LEVEL` — `debug`, `info`, `warn`, `error` (default: `info`)
- `METRICS_PORT` — HTTP port for metrics endpoint (default: 9090)

## Executor Plugins

Custom task executors can be registered for different task types:

```typescript
const bot = new KeeperBot(config);

bot.registerExecutor(SWAP_TASK_TYPE, new SwapExecutor());
bot.registerExecutor(ORACLE_TASK_TYPE, new OracleExecutor());

await bot.run();
```

Each executor implements:

```typescript
interface Executor {
  canExecute(task: Task): boolean;
  execute(task: Task, keeper: SigningAccount): Promise<ExecutionResult>;
}
```

## Metrics & Observability

The bot exposes an HTTP metrics endpoint (default port 9090):

```bash
curl http://localhost:9090/metrics
```

Output includes per-account stats:

```
keeper_tasks_executed{account="account-0",address="GABC..."} 1250
keeper_tasks_executed{account="account-1",address="GDEF..."} 1245
keeper_pending_tasks{account="account-0",address="GABC..."} 3
keeper_balance_xfcn{account="account-0",address="GABC..."} 50.5
keeper_balance_xfcn{account="account-1",address="GDEF..."} 49.2
```

## Graceful Shutdown

The bot responds to `SIGTERM` and `SIGINT`:

```bash
# Start bot
npm start

# In another terminal
kill -TERM <pid>    # or Ctrl+C

# Bot will:
# 1. Stop accepting new tasks
# 2. Wait for in-flight transactions to settle
# 3. Persist state to database
# 4. Exit cleanly
```

Restart after shutdown to resume where it left off.

## Testing

```bash
npm test

# With coverage
npm test -- --coverage
```

Tests cover:

- ✓ Account pool strategies and distribution
- ✓ Profitability calculations with real fees
- ✓ Adaptive fee calculation with various network conditions
- ✓ Fee ceiling enforcement during extreme congestion
- ✓ Alert rule detection and deduplication
- ✓ Metrics collection and aggregation
- ✓ Configuration loading and validation
- ✓ Transport error handling and timeouts
- ✓ Concurrency bounds
- ✓ Persistence layer behavior

## Reward Accounting

**Important:** When running a pool, rewards are split across accounts.

- Each account has its own on-chain `keeper_balance`
- The total keeper earnings = sum of all per-address balances
- Withdrawals must be done per-account

Example with 3 accounts:

```
Account 1 (GABC...): 50 XLM balance
Account 2 (GDEF...): 49 XLM balance
Account 3 (GGHI...): 51 XLM balance
Total:               150 XLM
```

You must call `withdraw_rewards(keeper)` three separate times to collect all earnings.

## Performance Tuning

### For High Throughput

1. Increase pool size to match or exceed concurrency
2. Use `least-loaded` strategy for dynamic balancing
3. Increase `KEEPER_CONCURRENCY` (but monitor fee usage)
4. Monitor metrics to detect bottlenecks

### For Cost Control

1. Use a smaller pool and lower concurrency
2. Adjust profitability thresholds
3. Monitor per-account balance to avoid funding more than needed

## Troubleshooting

### "No signing accounts configured"

Ensure at least one of these is set:

```bash
export KEEPER_SECRET_KEY=S...                # single
export KEEPER_SECRET_KEYS=S...,S...,S...   # multiple (comma-separated)
export KEEPER_SECRET_KEY_0=S...             # indexed
```

### "Invalid secret key"

Your secret key is malformed. Use the Stellar SDK to generate a valid one:

```bash
node -e "const {Keypair} = require('@stellar/stellar-sdk'); console.log(Keypair.random().secret())"
```

### Account not getting tasks

- Verify account is funded with enough XLM
- Check logs for profitability filters (task may not be profitable)
- Increase `KEEPER_CONCURRENCY` if bot is bottlenecked

### Sequence number errors

- Your account ran out of XLM (fund it)
- Too many concurrent submissions and account is hitting its fee limit
- Try reducing `KEEPER_CONCURRENCY` or fund more accounts

## Security

1. **Never commit secret keys** to version control
2. **Use secure secret management** (AWS Secrets Manager, HashiCorp Vault, systemd secrets)
3. **Rotate keys regularly** by updating environment and restarting
4. **Fund conservatively** — only add enough XLM for a few rounds of activity
5. **Monitor on-chain activity** to detect unauthorized transactions

## Roadmap

- [x] Adaptive fee module with RPC integration
- [x] Profitability check integration
- [x] Multi-account pooling with distribution strategies
- [x] Alerting system with webhook transport
- [x] Metrics collection framework
- [ ] Executor plugin interface (in progress)
- [ ] Persistent task state schema (in progress)
- [ ] Concurrent task processing (in progress)
- [ ] CLI for administration and monitoring
- [ ] Slack/PagerDuty/Datadog transports

## Related Issues & Docs

- **Issue #260**: Adapt submitted fees to current network conditions
- **Issue #254**: Profitability check before claiming
- **Issue #255**: Multi-account support with account pooling
- **Issue #253**: Concurrent task processing
- **Issue #257**: Metrics collection endpoint
- **Issue #258**: Alerting system with webhook transport
- **Issue #252**: Persistent task-state schema
- `docs/MULTI_ACCOUNT_SETUP.md` — Complete multi-account guide
- `.github/backlog/README.md` — Full issue index

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

Keeper-bot-v2 is part of epic E15 in the Soroban Keeper Network roadmap.

## License

Apache 2.0 — see [LICENSE](../../LICENSE)
# Soroban Keeper Bot v2

A high-performance, modular off-chain keeper bot for the [Soroban Keeper Network](https://github.com/soroban-tooling/soroban-keeper-network).

> [!NOTE]
> If you are new to Soroban, building a first integration, or exploring the
> smart contract ABI, start with the introductory single-file bot in
> [`examples/keeper-bot`](../keeper-bot) instead. **Keeper Bot v2** is for
> operators running competitively: concurrency, custom withdrawal schedules,
> lock-window-aware scheduling, and persistent state across restarts.

## Key architectural capabilities

### Concurrent rounds, prioritization, and spend safety (issues #404, #407)
- Bounded concurrent workers process independent tasks without racing internally.
- Candidate tasks are ranked by estimated net profit so high-value work is evaluated first.
- `FEE_CEILING_STROOPS` imposes a hard per-round fee ceiling (default: `1000000` stroops).
- Lost claim races are normal competitive skips, recorded separately from RPC and execution failures.

### Graceful shutdown under concurrency (`src/shutdown.js`)
- **Worker draining**: on `SIGINT` or `SIGTERM`, the bot stops accepting new candidate tasks and drains all active in-flight workers.
- **No mid-submission kills**: each concurrent worker finishes its current submission and persists its outcome before the process exits.
- **Bounded maximum wait**: a configurable maximum drain ceiling (`maxDrainMs`) prevents a deadlocked worker or hung network connection from blocking shutdown indefinitely.

### Verifier support (issue #412)
Verifier-aware proof generation is deferred until the on-chain contract exposes a
verifier field, entry points, and validation hooks. The bot does not implement
against a non-existent contract interface.

### Benchmarking (issue #413)
A committed comparison against v1 (`examples/keeper-bot`) — round latency, claim-race
handling, and profitability under identical simulated load — is at
[`benchmark/REPORT.md`](benchmark/REPORT.md).

## Overview

Keeper Bot v2 is a high-throughput, enterprise-ready off-chain daemon for the Soroban Keeper Network. Key features include:

- **Full startup configuration schema validation**: per-field validation plus cross-field consistency checks (e.g. concurrency limits vs. account pool size, profitability margins vs. fee ceilings) to fail fast before any runtime operation begins.
- **Per-task-type observability**: detailed metrics broken down by `task_type` (claimed, executed, skipped counts by reason, and net profit per type) in Prometheus exposition format.
- **Persistent state & idempotency**: backed by PostgreSQL (`DATABASE_URL`) to record task outcomes and prevent duplicate claims or executions across restarts. Optional — omit `DATABASE_URL` to run with in-memory state only.
- **Multi-account concurrency**: distributes tasks across multiple signing accounts in `SIGNING_KEY_POOL` to bypass single-account sequence-number serialization.
- **Pluggable executors**: discoverable executor modules with automatic metrics registration.
- **Graceful shutdown**: stops accepting new work on `SIGINT` or `SIGTERM`, drains in-flight workers, and bounds shutdown time.
- **Lock-aware scheduling**: rechecks claimed tasks at their unlock ledger while continuing normal task discovery.
- **Scheduled and fee-aware withdrawals**: supports fixed schedules and withdrawal decisions based on network fees.

## Configuration

The full, current set of environment variables validated at startup — this table is
generated by hand from [`src/config.ts`](src/config.ts)'s `validateConfig`, the
single source of truth; if the two ever disagree, trust the code. See
[`.env.example`](.env.example) for a ready-to-copy template with valid placeholder
values.

| Environment variable | Description | Default |
|---|---|---|
| `NETWORK` | `testnet`, `futurenet`, or `mainnet` | `testnet` |
| `REGISTRY_CONTRACT_ID` | Deployed `KeeperRegistry` contract address (`C...`) | required |
| `SECRET_BACKEND` | `env`, `vault`, or `aws_secrets_manager` | `env` |
| `KEEPER_SECRET_KEY` | Single signing account secret key (`S...`); required when `SECRET_BACKEND=env` and `SIGNING_KEY_POOL` is unset | — |
| `SIGNING_KEY_POOL` | Comma-separated secret keys for multi-account concurrent signing; supersedes `KEEPER_SECRET_KEY` | — |
| `VAULT_ADDR` | HashiCorp Vault address, when `SECRET_BACKEND=vault` | — |
| `AWS_SECRET_NAME` | AWS Secrets Manager secret name, when `SECRET_BACKEND=aws_secrets_manager` | — |
| `DATABASE_URL` | PostgreSQL connection string for persistent task state. Omit to run with in-memory state only | — |
| `MAX_CONCURRENT_TASKS` | Concurrency limit within a single round; must not exceed the signing pool size | `1` |
| `MAX_TASKS_PER_ROUND` | Maximum tasks evaluated per polling round | `5` |
| `POLL_INTERVAL_MS` | Delay between keeper rounds, in milliseconds (must be ≥ `1000`) | `10000` |
| `MIN_PROFIT_MARGIN_STROOPS` | Minimum net profit required before claiming | `0` |
| `FEE_CEILING_STROOPS` | Hard per-round transaction fee ceiling, in stroops | `1000000` |
| `WITHDRAW_THRESHOLD` | Minimum accumulated balance before triggering an automated withdrawal, in stroops | `10000000` |
| `MAX_RETRIES` | Retries for transient RPC errors | `3` |
| `RETRY_BASE_MS` | Base delay for retry backoff, in milliseconds | `500` |
| `EXPIRE_STALE_TASKS` | Expire stale tasks to refund creators | `true` |
| `SIMULATE_EXECUTION` | Enable the fallback simulated executor, for development | `false` |
| `METRICS_ENABLED` | Expose the Prometheus `/metrics` endpoint | `true` |
| `METRICS_PORT` | Port for the metrics endpoint (`1`–`65535`) | `9090` |
| `RUN_ONCE` | Run a single round then exit (also settable via the `--once` CLI flag) | `false` |

## Quickstart: zero to a running dry-run instance

This gets you a real, running `KeeperBotV2` process — configuration validated,
metrics server started, one round executed, clean shutdown — without a funded
account, a deployed contract, or a database. `.env.example`'s placeholder
`REGISTRY_CONTRACT_ID` and `KEEPER_SECRET_KEY` are already format-valid, which is
all startup validation checks; today's round loop does not yet call out to Soroban
RPC (that lands with the polling-loop wiring), so nothing here touches the network
except the metrics server's local port.

```bash
# Install dependencies
npm install

# Copy the configuration template
cp .env.example .env

# For this dry run only: comment out DATABASE_URL in .env (or leave it unset) so
# the bot runs with in-memory state and doesn't need a local Postgres instance.
# A real deployment should configure DATABASE_URL for persistence.

# Build TypeScript
npm run build

# Run one round and exit
npm start -- --once
```

Expected output ends with `[KEEPER-BOT-V2] Stopped cleanly.` and exit code `0`. From
here, set real `REGISTRY_CONTRACT_ID` / signing-key values, configure
`DATABASE_URL` for persistence, and drop `--once` to run continuously on
`POLL_INTERVAL_MS`.

### Tests and linting

```bash
npm test       # tsc, then the node:test suite in dist/test/
npm run lint   # eslint over src/ and test/
```

## Further reading

- **Migrating from v1**: [docs/KEEPER_BOT_V2_MIGRATION.md](../../docs/KEEPER_BOT_V2_MIGRATION.md)
- **Design rationale** — the shutdown, scheduling, and withdrawal architecture: [docs/KEEPER_BOT_V2_DESIGN.md](../../docs/KEEPER_BOT_V2_DESIGN.md)
