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
