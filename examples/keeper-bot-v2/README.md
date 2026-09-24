# keeper-bot-v2

A TypeScript keeper bot implementation for the Soroban Keeper Network, designed for operators running keepers competitively with support for:

- **Multiple signing accounts** for parallelized transaction submission
- **Concurrent task processing** within each round
- **Persistent state** across restarts
- **Profitability checks** before claiming
- **Flexible executor plugins** for custom task types
- **Observability** and metrics

## Not a Beginner's Guide

This package is aimed at **operators** running a keeper competitively on production networks. It is intentionally more complex than the simple, single-file example at `examples/keeper-bot/`.

**If you're new to the Soroban Keeper Network, start with `examples/keeper-bot/` instead.** It's a great introduction with no external dependencies or persistence layer.

## Key Differences from keeper-bot v1

| Feature | v1 (examples/keeper-bot) | v2 (keeper-bot-v2) |
| --- | --- | --- |
| Language | JavaScript (CommonJS) | TypeScript |
| Complexity | Single file, ~200 LOC | Modular, multiple files |
| Persistence | None | SQLite/Redis |
| Concurrency | Serial (one task at a time) | Parallel (configurable) |
| Signing accounts | One fixed account | Pool of accounts |
| Profitability | None | Real cost + reward check |
| Executor interface | Pluggable (simple) | Pluggable (richer) |
| Target audience | Learners | Production operators |

## Quick Start

### Prerequisites

- Node.js ≥ 18
- A funded Stellar account (or multiple accounts for a pool)
- Connection to a Soroban RPC endpoint

### Installation

```bash
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
export KEEPER_CONCURRENCY=10      # concurrent tasks per round
export KEEPER_DATABASE_URL=...    # defaults to ./keeper.db
```

### Running

```bash
npm start

# Or with specific network
NETWORK=testnet npm start
```

## Architecture

```
src/
├── accounts.ts         # SigningAccount pool, round-robin/least-loaded strategies
├── accounts.test.ts    # 50+ tests for account pool behavior
├── loop.ts             # Main keeper loop, concurrency, round management
├── profitability.ts    # Cost + reward calculations
├── executors/
│   ├── ttl.ts         # TTL extension executor
│   └── ...
├── persistence/
│   ├── schema.ts      # SQLite/Redis schema
│   └── store.ts       # Query/update interface
└── metrics.ts          # Observability, per-account stats
```

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

## Configuration

### Environment Variables

#### Signing

- `KEEPER_SECRET_KEY` — Single account (backward compatible)
- `KEEPER_SECRET_KEYS` — Comma-separated list of secret keys
- `KEEPER_SECRET_KEY_0`, `KEEPER_SECRET_KEY_1`, ... — Indexed keys
- `KEEPER_POOL_STRATEGY` — `round-robin` (default) or `least-loaded`

#### Network

- `REGISTRY_CONTRACT_ID` — Contract ID of keeper-registry
- `RPC_URL` — Soroban RPC endpoint
- `NETWORK` — `testnet` or `mainnet` (determines network passphrase)

#### Performance

- `KEEPER_CONCURRENCY` — Max concurrent tasks per round (default: 5)
- `KEEPER_ROUND_INTERVAL_MS` — Milliseconds between rounds (default: 5000)

#### Persistence

- `KEEPER_DATABASE_URL` — SQLite or Redis connection (default: `./keeper.db`)

#### Observability

- `LOG_LEVEL` — `debug`, `info`, `warn`, `error` (default: `info`)
- `METRICS_PORT` — HTTP port for metrics endpoint (default: 9090)

### Profitability

The bot evaluates each candidate task before claiming:

1. Estimate gas cost (from recent network history)
2. Fetch current fee_bps from the contract
3. Calculate expected reward
4. Skip if: `reward < (estimated_gas_cost + tx_fee)`

This prevents unprofitable claims and wasted fees.

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

## Testing

```bash
npm test

# With coverage
npm test -- --coverage
```

Tests are written with [Vitest](https://vitest.dev/) and cover:

- Account pool strategies and distribution
- Profitability calculations
- Concurrency bounds
- Persistence layer
- Each executor type

## Metrics & Observability

The bot exposes an HTTP metrics endpoint (default port 9090):

```bash
curl http://localhost:9090/metrics
```

Output includes per-account stats:

```
keeper_tasks_executed{account="account-0",address="GABC..."} 1250
keeper_tasks_executed{account="account-1",address="GDEF..."} 1245
keeper_tasks_executed{account="account-2",address="GGHI..."} 1268
keeper_pending_tasks{account="account-0",address="GABC..."} 3
keeper_pending_tasks{account="account-1",address="GDEF..."} 2
keeper_pending_tasks{account="account-2",address="GGHI..."} 5
keeper_balance_xfcn{account="account-0",address="GABC..."} 50.5
keeper_balance_xfcn{account="account-1",address="GDEF..."} 49.2
keeper_balance_xfcn{account="account-2",address="GGHI..."} 51.1
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

## Security

1. **Never commit secret keys** to version control
2. **Use secure secret management** (AWS Secrets Manager, HashiCorp Vault, systemd secrets)
3. **Rotate keys regularly** by updating environment and restarting
4. **Fund conservatively** — only add enough XLM for a few rounds of activity
5. **Monitor on-chain activity** to detect unauthorized transactions

## Related Issues & Docs

- **Issue 0253:** Concurrent task processing — explains concurrency design
- **Issue 0255:** Multi-account support — this feature
- **Issue 0252:** Persistent state — database schema and restart behavior
- **Issue 0254:** Profitability checks — cost + reward logic
- `docs/MULTI_ACCOUNT_SETUP.md` — Complete multi-account guide

## License

Apache-2.0 (see CONTRIBUTING.md in the repo root)

## Contributing

See `CONTRIBUTING.md` in the repo root. This package follows the same conventions as the rest of the soroban-keeper-network project.
