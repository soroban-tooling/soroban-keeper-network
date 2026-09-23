# Keeper Bot v2 Operator Migration Guide

A migration and operational reference for operators transitioning from the educational v1 keeper bot (`examples/keeper-bot`) to the production-grade v2 architecture (`examples/keeper-bot-v2`).

---

## 1. Architectural Overview & Differences

| Dimension | v1 (`examples/keeper-bot`) | v2 (`examples/keeper-bot-v2`) |
| :--- | :--- | :--- |
| **Audience** | Beginners, local testing, educational demo | Production operators, competitive keepers |
| **Language & Build** | CommonJS JavaScript (single file, no build step) | TypeScript with strict compilation (`npm run build`) |
| **Concurrency** | Strictly sequential (one task at a time) | Bounded concurrent task execution across signing accounts |
| **State Persistence** | Transient in-memory `Map` (lost on every restart) | PostgreSQL database schema with migration tracking |
| **Account Model** | Single signing key (`KEEPER_SECRET_KEY`) | Multi-account signing pool (`SIGNING_KEY_POOL`) |
| **Secret Management** | Plain environment variable only | Pluggable backends: `env`, `vault`, `aws_secrets_manager` |
| **Configuration Validation**| Individual per-field checks as read | Strict fail-fast schema + cross-field consistency checks |
| **Observability** | Console logs only | Prometheus metrics endpoint with per-`task_type` breakdowns |
| **Executors** | Hardcoded inline functions | Discoverable, pluggable executor modules |

---

## 2. Configuration Value Mapping

Every configuration variable from v1 has a defined equivalent or superseding counterpart in v2:

| v1 Variable | v2 Variable | Status / Action | Description & Notes |
| :--- | :--- | :--- | :--- |
| `NETWORK` | `NETWORK` | **Unchanged** | Supported: `testnet`, `futurenet`, `mainnet` (defaults to `testnet`). |
| `REGISTRY_CONTRACT_ID` | `REGISTRY_CONTRACT_ID` | **Unchanged** | Deployed contract ID (`C...`). Must pass `StrKey.isValidContract`. |
| `KEEPER_SECRET_KEY` | `KEEPER_SECRET_KEY` or `SIGNING_KEY_POOL` | **Enhanced** | For single-worker mode, `KEEPER_SECRET_KEY` continues to work. For concurrent setups (`MAX_CONCURRENT_TASKS > 1`), operators must provide `SIGNING_KEY_POOL` containing a comma-separated list of funded signing keys. |
| `POLL_INTERVAL_MS` | `POLL_INTERVAL_MS` | **Unchanged** | Polling interval between event scans. Minimum 1000ms; defaults to 10000ms. |
| `WITHDRAW_THRESHOLD` | `WITHDRAW_THRESHOLD` | **Unchanged** | Threshold in stroops to trigger reward withdrawal. Defaults to 10,000,000 (1 XLM). |
| `MAX_TASKS_PER_ROUND` | `MAX_TASKS_PER_ROUND` | **Unchanged** | Maximum tasks evaluated in a single round. Minimum 1; defaults to 5. |
| `MAX_RETRIES` | `MAX_RETRIES` | **Unchanged** | Number of retry attempts on transient RPC errors. Defaults to 3. |
| `RETRY_BASE_MS` | `RETRY_BASE_MS` | **Unchanged** | Base retry delay for exponential backoff. Defaults to 500ms. |
| `EXPIRE_STALE_TASKS` | `EXPIRE_STALE_TASKS` | **Unchanged** | Boolean flag (`true`/`false`) to expire stale tasks. Defaults to `true`. |
| `MIN_PROFIT_MARGIN_STROOPS` | `MIN_PROFIT_MARGIN_STROOPS` | **Enhanced** | Minimum profit margin in stroops. Validated against `FEE_CEILING_STROOPS` to prevent contradictions. |
| `SIMULATE_EXECUTION` | `SIMULATE_EXECUTION` | **Unchanged** | Development-only flag for simulating off-chain execution proofs. |
| `RUN_ONCE` / `--once` | `RUN_ONCE` / `--once` | **Unchanged** | Executes a single polling round and halts. |

### New v2-Only Configuration Fields

The following fields are introduced in v2 to support production concurrency, durability, and observability:

| v2 Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Optional (local) / Required (prod) | _None_ | PostgreSQL connection URI (`postgresql://user:pass@host:5432/db`) for persistent task tracking. |
| `MAX_CONCURRENT_TASKS` | No | `1` | Maximum parallel task workers within a round. **Must not exceed the number of signing keys in `SIGNING_KEY_POOL`**. |
| `FEE_CEILING_STROOPS` | No | `1000000` | Safety maximum fee ceiling for network surges. Cross-checked with `MIN_PROFIT_MARGIN_STROOPS`. |
| `SECRET_BACKEND` | No | `env` | Secret backend provider: `env`, `vault`, or `aws_secrets_manager`. |
| `VAULT_ADDR` | If `SECRET_BACKEND=vault` | _None_ | HashiCorp Vault endpoint address. |
| `AWS_SECRET_NAME` | If `SECRET_BACKEND=aws_secrets_manager` | _None_ | AWS Secrets Manager secret identifier. |
| `METRICS_ENABLED` | No | `true` | Enables the HTTP Prometheus metrics scraper. |
| `METRICS_PORT` | No | `9090` | HTTP port for the Prometheus metrics server (`/metrics`). |

---

## 3. State & Cache Migration Policy

### Plain Statement on Outcome Cache Seeding

> **v1's in-memory outcome cache cannot and should not be seeded into v2's persistent database. v2 simply starts fresh.**

#### Rationale
- **Transient Nature of v1**: v1 maintained an ephemeral `Map` in memory (`taskOutcomes`) purely to avoid duplicate submissions within the lifespan of a single process run. On any restart, crash, or deployment in v1, this map was discarded.
- **On-Chain Source of Truth**: The `KeeperRegistry` smart contract enforces all core invariants on-chain. If a task was already claimed or executed during a previous v1 session, calling `is_claimable` returns `false`, and any simulated claim attempt fails immediately.
- **Fresh Startup Behavior**: When v2 starts for the first time, it connects to PostgreSQL, creates its tables via schema migrations, and begins recording state from that point forward. No historical state dump or manual database insertion is required or advised.

---

## 4. Operational Requirements

Operators deploying v2 must account for the following infrastructural and operational differences:

### 1. Persistent PostgreSQL Database
v2 requires a reliable PostgreSQL instance (version 14+) for durable state tracking:
- **Connection**: Provide `DATABASE_URL=postgresql://user:password@host:port/dbname`.
- **Migrations**: Database schema migrations (`keeper_task_outcomes` table and indices) run automatically on bot initialization via idempotent DDL (`CREATE TABLE IF NOT EXISTS`).
- **Connection Pool**: The bot utilizes an internal connection pool (default max 10 connections) with configurable connection timeouts.

### 2. Multi-Account Management & Funding
To execute tasks concurrently without encountering Stellar transaction sequence conflicts, v2 supports a pool of signing accounts:
- **Sequence Number Serialization**: A single Stellar public key enforces strict sequence numbering. Multiple concurrent threads submitting transactions with the same account will fail with bad sequence errors.
- **Signing Pool Requirement**: When setting `MAX_CONCURRENT_TASKS = N`, you must configure at least `N` distinct secret keys in `SIGNING_KEY_POOL`. Startup validation explicitly blocks launch if `MAX_CONCURRENT_TASKS > pool_size`.
- **Independent Funding**: Each account in the signing pool must hold sufficient native XLM balance to satisfy the Stellar base reserve and transaction fee requirements.
- **Reward Accounting**: On-chain rewards are accumulated under each individual signing account's address (`keeper_balance`). When running in a pool, operators should monitor balances for all configured addresses.

### 3. External Secret Management
Storing raw secret keys in plaintext `.env` files is not recommended in production.
- v2 supports `SECRET_BACKEND=vault` or `SECRET_BACKEND=aws_secrets_manager`.
- The bot validates backend configuration at startup.
- Key material is strictly redacted: no secret seed will ever appear in error logs, stdout, or stack traces.

### 4. Observability & Monitoring
- v2 exposes operational metrics at `http://<bot-host>:9090/metrics` in standard Prometheus exposition format.
- In addition to aggregate task counters, metrics are broken down by `task_type` (e.g. `ttl_extension`, `contract_invocation`):
  - `soroban_keeper_tasks_claimed_by_type{task_type="..."}`
  - `soroban_keeper_tasks_executed_by_type{task_type="..."}`
  - `soroban_keeper_tasks_skipped_by_type{task_type="...",reason="..."}`
  - `soroban_keeper_net_profit_stroops_by_type{task_type="..."}`
- Operators can configure alert rules based on `skipped_by_type{reason="unprofitable"}` or `rpc_errors_total`.

---

## 5. Step-by-Step Operator Upgrade Procedure

1. **Provision Infrastructure**:
   - Provision a PostgreSQL database instance and create a dedicated database (e.g. `keeper_bot_v2`).
   - If scaling concurrency, generate and fund secondary Stellar signing accounts.
2. **Deploy v2 Application**:
   ```bash
   git clone <repo-url>
   cd examples/keeper-bot-v2
   npm ci
   npm run build
   ```
3. **Configure Environment**:
   - Create `.env` using your existing v1 parameters (`NETWORK`, `REGISTRY_CONTRACT_ID`, `KEEPER_SECRET_KEY`).
   - Add `DATABASE_URL` pointing to your PostgreSQL instance.
   - Configure `MAX_CONCURRENT_TASKS` and `METRICS_PORT`.
4. **Dry Run / Smoke Test**:
   - Run in single-round mode to verify contract connectivity, database migrations, and signing keys:
     ```bash
     RUN_ONCE=true npm start
     ```
5. **Start Daemon**:
   - Start the service under your process manager (`systemd`, Docker, Kubernetes):
     ```bash
     npm start
     ```
6. **Verify Metrics**:
   - Query the metrics endpoint:
     ```bash
     curl http://localhost:9090/metrics
     ```
7. **Decommission v1**:
   - Stop the v1 process. No data export or migration script is required.
