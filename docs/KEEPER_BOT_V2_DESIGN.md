# Keeper bot v2 design (E15)

## Decision summary

| Question | Decision |
| --- | --- |
| Relationship to v1 | Build a separate package at `packages/keeper-bot-v2`; keep `examples/keeper-bot` beginner-oriented and behaviorally independent. |
| Language and runtime | Node.js 24 LTS, strict TypeScript 5.7, native ES modules, `NodeNext` resolution, and an ES2022 target. |
| Persistence | One local SQLite database per bot instance, accessed through `better-sqlite3`, with migrations from the first release. |
| Concurrency | A bounded worker pool (default 4), durable task leases, one transaction-submission lane per signing account, and an atomic fee budget. |
| Executor model | Keep v1's task-to-proof idea, but replace its in-file function map with typed, configured plugins that support estimation, idempotency, timeout, checkpoint, and reconciliation. |
| Profitability | A dedicated pre-claim policy computes keeper net reward minus simulated network fees, executor cost, withdrawal share, and safety margin. Uncertain or stale estimates fail closed. |
| Indexer dependency | Optional candidate source. Prefer the indexer stream when configured, retain direct RPC scanning as a fallback, and always confirm claimability on chain. |

These are implementation decisions for E15, not suggestions left to the
scaffolding issue.

## 1. Package and runtime

V2 lives at **`packages/keeper-bot-v2`**. It is not a mode, flag, or set
of extra files inside `examples/keeper-bot`, and it is not a separate
repository.

The existing example deliberately uses one CommonJS JavaScript file, no
build step, and a small inline executor map. That makes the full loop
readable to a newcomer. Adding migrations, durable state machines,
concurrency, plugin loading, metrics, and recovery branches to that file
would destroy the property the example is intended to teach. V1 remains
the walkthrough; v2 is the operator service.

Keeping v2 in this repository still has material value: it can consume
`@soroban-keeper-network/sdk` from the workspace, change atomically with
the contract ABI, share CI, and be tested against the same fixtures. A
standalone repository would add release coordination without isolating a
security boundary.

The pinned implementation baseline is:

- package: `packages/keeper-bot-v2`;
- runtime: Node.js 24 LTS (`engines.node: ">=24 <25"`);
- language: TypeScript 5.7 with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes` enabled;
- modules: ESM (`type: "module"`, TypeScript `NodeNext`);
- output: compiled JavaScript in `dist/`, target `ES2022`; and
- contract access: `@soroban-keeper-network/sdk` plus
  `@stellar/stellar-sdk`, not a second hand-written client.

SQLite is accessed through [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).
Node's built-in `node:sqlite` is not selected while the
[Node 24 documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
still marks it as a release-candidate API. The database calls are short prepared statements
and transactions; executor and network work never runs inside a database
transaction. If profiling later shows synchronous database calls delaying
the loop, the storage interface can move to a worker thread without
changing the schema or orchestration contract.

Expected package layout:

```text
packages/keeper-bot-v2/
  migrations/
  src/
    main.ts
    config.ts
    loop.ts
    profitability.ts
    submissions.ts
    state/
      database.ts
      repository.ts
      types.ts
    task-sources/
      indexer.ts
      rpc.ts
    executors/
      interface.ts
      loader.ts
      ttl-extension.ts
  test/
  package.json
  tsconfig.json
```

## 2. Persistence

### Storage choice

V2 uses SQLite in WAL mode with foreign keys enabled and a busy timeout.
The first supported topology is one process, one signing account, and one
database file. SQLite fits that topology better than Redis: reservations,
cursor advancement, task state, and submission intent need atomic
transactions and durable uniqueness, while no shared cache service is
otherwise required. Redis would add an operator dependency and would
still need an append-only durability and migration story.

The database contains operational state only. It must never contain the
Stellar secret seed, API keys, or secret-manager tokens. The file is
created owner-readable/writable only, lives on a persistent volume, and
is backed up before migrations.

All contract `u64` identifiers and token `i128` amounts are stored as
canonical decimal `TEXT`, not JavaScript `number` or SQLite `INTEGER`.
This avoids precision loss above `Number.MAX_SAFE_INTEGER`. Unix times and
ledger sequences fit SQLite integers.

### State that survives restart

The following state is durable:

- the last committed cursor for every candidate source;
- every discovered task this keeper evaluated;
- an in-flight reservation and its expiry;
- profitability inputs and the decision made from them;
- claim and execute transaction intent, signed envelope, hash, sequence,
  submission status, and result;
- executor version, idempotency key, and opaque checkpoint;
- terminal outcomes (`executed`, `expired`, unsupported, or permanent
  failure); and
- retry count, next eligible time, and the last classified error.

RPC clients, short-lived fee quotes, decoded task objects, and cached
health responses are reconstructed. A current quote may be persisted for
audit, but it is never trusted after its freshness deadline.

### Initial schema

Issue 0251 can scaffold migrations and repository interfaces directly
from this schema; issue 0252 implements their behavior.

```sql
CREATE TABLE source_cursors (
  network              TEXT NOT NULL,
  contract_id          TEXT NOT NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('indexer', 'rpc')),
  cursor_value         TEXT,
  last_ledger          INTEGER,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (network, contract_id, source_kind)
) STRICT;

CREATE TABLE task_runs (
  network                    TEXT NOT NULL,
  contract_id                TEXT NOT NULL,
  keeper_address             TEXT NOT NULL,
  task_id                    TEXT NOT NULL,
  state                      TEXT NOT NULL CHECK (state IN (
    'discovered', 'evaluating', 'reserved', 'claim_submitted',
    'claimed', 'executing', 'execute_submitted', 'executed',
    'expired', 'skipped', 'retryable_failed', 'terminal_failed'
  )),
  discovery_source           TEXT NOT NULL CHECK (discovery_source IN ('indexer', 'rpc')),
  source_cursor              TEXT,
  reward_stroops             TEXT,
  deadline                   INTEGER,
  executor_name              TEXT,
  executor_version           TEXT,
  idempotency_key            TEXT NOT NULL,
  executor_checkpoint_json   TEXT,
  lease_owner                TEXT,
  lease_expires_at           INTEGER,
  reserved_fee_stroops       TEXT,
  profitability_json         TEXT,
  attempt_count              INTEGER NOT NULL DEFAULT 0,
  next_eligible_at           INTEGER,
  outcome_code               TEXT,
  last_error                 TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  PRIMARY KEY (network, contract_id, keeper_address, task_id),
  UNIQUE (idempotency_key)
) STRICT;

CREATE TABLE submissions (
  id                         INTEGER PRIMARY KEY,
  network                    TEXT NOT NULL,
  contract_id                TEXT NOT NULL,
  keeper_address             TEXT NOT NULL,
  task_id                    TEXT NOT NULL,
  stage                      TEXT NOT NULL CHECK (stage IN (
    'claim', 'execute', 'expire'
  )),
  attempt_no                 INTEGER NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN (
    'built', 'submitted', 'confirmed', 'failed', 'unknown'
  )),
  account_sequence           TEXT NOT NULL,
  transaction_hash           TEXT NOT NULL,
  envelope_xdr               TEXT NOT NULL,
  fee_bid_stroops            TEXT NOT NULL,
  submitted_at               INTEGER,
  resolved_at                INTEGER,
  result_code                TEXT,
  created_at                 INTEGER NOT NULL,
  FOREIGN KEY (network, contract_id, keeper_address, task_id)
    REFERENCES task_runs (network, contract_id, keeper_address, task_id),
  UNIQUE (network, contract_id, keeper_address, task_id, stage, attempt_no),
  UNIQUE (transaction_hash)
) STRICT;

CREATE INDEX task_runs_ready
  ON task_runs (state, next_eligible_at, deadline);
CREATE INDEX task_runs_lease
  ON task_runs (lease_expires_at) WHERE lease_expires_at IS NOT NULL;
CREATE INDEX submissions_unresolved
  ON submissions (status) WHERE status IN ('built', 'submitted', 'unknown');
```

Migrations are numbered, checksummed, and applied transactionally before
the candidate source or workers start. A newer database schema than the
binary understands is a hard startup error; the bot never attempts to run
against it.

### Cursor and outcome transaction rule

A source page is committed in one transaction: insert each task as
`discovered` with `ON CONFLICT DO NOTHING`, then advance `source_cursors`.
The cursor must not advance if any insert fails. Processing may happen
afterward because the durable task rows now represent every candidate in
the page.

Terminal rows are not deleted automatically. A restart therefore cannot
forget that this keeper already executed or expired a task. A skipped task
is either terminal (unsupported task type or invalid payload) or has
`next_eligible_at` set (temporarily unprofitable, RPC unavailable, or lock
still held); the reason code decides which.

### Restart reconciliation

Startup performs reconciliation before new work is leased:

1. For every unresolved submission, query its stored transaction hash.
   If confirmed, apply the result. If still pending, keep the lease. If
   the RPC cannot decide, keep status `unknown`; do not build a replacement.
2. For an expired lease with no conclusive transaction, read the task on
   chain. Requeue only when its state proves that this keeper did not
   complete the stage.
3. If a claim belongs to this keeper, resume execution with the stored
   executor checkpoint and idempotency key. If another keeper owns it or
   it is terminal, record that outcome and release the budget.
4. Resubmit only the exact stored envelope when protocol rules allow it.
   Never create a second transaction merely because the first response was
   lost.

Persisting the signed envelope and hash before network submission closes
the crash window between "sent" and "remembered". It does not store the
secret key.

## 3. Concurrency model

One process handles independent tasks concurrently through a bounded
worker pool. The default is 4 workers, configurable as
`KEEPER_CONCURRENCY`, with a separate `KEEPER_MAX_IN_FLIGHT_CLAIMS`
ceiling. Increasing one does not bypass the other.

Same-process duplicate submission is prevented at the database boundary.
A worker obtains a task with a conditional transaction that changes an
eligible row to `reserved`, assigns a random process instance id as
`lease_owner`, sets `lease_expires_at`, and reserves its maximum fee. The
worker proceeds only when exactly one row changed. Two workers cannot
lease the same primary key.

SQLite coordinates workers inside one process and can protect against an
accidental second process using the same file, but v2 does not advertise
active/active operation. Operators must run one process per database and
signing account. Multi-account and distributed-worker support require a
different sequence and lease design and are separate E15 work.

### Submission lanes and sequence numbers

Executor work and RPC reads may run in parallel. Transaction construction
and submission are serialized through one lane per signing account because
Stellar account sequence numbers are ordered shared state. Each lane:

1. simulates the intended call;
2. checks the fee reservation and estimate freshness;
3. allocates the next account sequence;
4. signs the envelope;
5. commits envelope, hash, sequence, and `built` status; then
6. submits and records the response.

This retains concurrent off-chain work without constructing competing
transactions with the same account sequence.

### Resource budget

Configuration sets a maximum fee per transaction, total reserved fees per
round, total spend per round, maximum claimed tasks, executor timeout, and
round deadline. Reserving a task atomically reserves its worst-case fee;
no worker may start a claim when active reservations would cross the
budget. Confirmation replaces the reservation with actual spend. Failure
or a reconciled terminal outcome releases it.

Worker cancellation stops new stages but does not pretend submitted work
was cancelled. Shutdown stops discovery, drains within a configured grace
period, persists every checkpoint, marks unresolved submissions
`unknown`, and leaves reconciliation to the next start.

## 4. Executor interface

V1's essential rule remains: an executor accepts a task and either returns
a proof or refuses it; there is no production default that fabricates a
proof. V2 redesigns the surrounding interface because operator plugins
also need cost estimation, durable identity, cancellation, restart
reconciliation, and explicit supported task types.

```ts
export interface TaskExecutor {
  readonly name: string;
  readonly version: string;
  readonly taskTypes: readonly TaskType[];

  estimate(task: KeeperTask, context: EstimateContext): Promise<ExecutorEstimate>;

  execute(
    task: KeeperTask,
    context: ExecuteContext & {
      idempotencyKey: string;
      checkpoint: unknown | null;
      signal: AbortSignal;
      saveCheckpoint(value: unknown): Promise<void>;
    },
  ): Promise<{ proof: Uint8Array; costStroops: bigint; checkpoint?: unknown }>;

  reconcile?(
    task: KeeperTask,
    context: ReconcileContext,
    checkpoint: unknown,
  ): Promise<'completed' | 'not_completed' | 'unknown'>;
}
```

`ExecutorEstimate` includes expected external cost, worst-case cost,
estimate timestamp, validity window, and whether execution is idempotent.
An executor that cannot provide a bounded worst case is not eligible for
automatic claiming.

Plugin modules are loaded only from an explicit configuration allow-list
at startup. Each module exports one validated executor. Duplicate task
type registrations, missing methods, invalid names/versions, and an empty
production registry are startup errors. Modules are local trusted code,
not downloaded from a task or loaded from an on-chain string.

The core owns the signing key, claim/execute calls, database, budgets,
timeouts, and logs. A plugin receives the least capability its external
work needs and never receives the keeper seed. Every execution gets a
stable idempotency key derived from network, contract, keeper, task id,
executor name, and executor major version. Side-effecting executors must
use it with their target system or implement `reconcile` before they may
run automatically.

The reference `ttl-extension` executor lives in its own module. The
development-only simulated executor requires an explicit unsafe flag and
is rejected on mainnet configuration.

## 5. Profitability policy

Profitability lives in `src/profitability.ts`, outside both the worker loop
and executor plugins. It runs before `claim_task` is built. Plugins report
their own bounded cost but cannot lower network costs or override the
operator's margin.

For a task reward `R` and current protocol fee `fee_bps`:

```text
protocol_fee = floor(R * fee_bps / 10_000)
keeper_reward = R - protocol_fee
total_cost = claim_fee
           + execute_fee
           + verifier_fee
           + executor_external_cost
           + amortized_withdrawal_fee
           + risk_buffer
expected_profit = keeper_reward - total_cost
```

The task is eligible only when `expected_profit >= minimum_profit` and
every component is fresher than its configured maximum age. Calculations
use `bigint` end to end.

Inputs come from:

- reward, deadline, verifier, and task data from an authoritative contract
  read immediately before the decision;
- current `get_fee_bps` from the contract, not an indexer aggregate;
- RPC simulation of `claim_task` and the best available `execute_task`
  envelope/proof;
- the executor's expected and worst-case external cost;
- current base/resource fee policy and an operator-configured fee ceiling;
- an amortized withdrawal share based on the configured withdrawal batch
  size; and
- `KEEPER_MIN_PROFIT_STROOPS` plus a percentage or absolute risk buffer.

If execute simulation is impossible before claiming, the executor's
worst-case estimate and a configured conservative ceiling are used. A
missing, failed, or stale estimate means **skip**, not "assume zero". The
full inputs, formula result, and reason code are stored in
`profitability_json` and logged without secrets.

V1 now contains a preliminary `estimateTaskProfitability` function, so v2
does not start from zero. V1 uses fixed claim/execute constants and
optional verifier simulation, however, and does not subtract the current
protocol fee or model executor/withdrawal costs. V2 reuses its fail-before-
claim intent, not its constants or inline placement.

Profitability is rechecked after a queue delay or fee-quote expiry and
immediately before signing. A reward increase can make a skipped task
eligible later; a fee increase can make a reserved task ineligible before
submission. Once a claim is confirmed, the bot may execute an operation
that has become less profitable when abandoning it would strand the claim
or violate the executor's completed side effect. That post-claim policy is
logged separately from the pre-claim decision.

## 6. Candidate sources and trust boundary

When configured, the E14 indexer WebSocket is the preferred discovery
source: subscribe to `task_registered`, persist each event cursor, and
resume with `after`. Direct paginated `getEvents` scanning remains the
fallback when no indexer is configured or its health reports lag.

The indexer never authorizes a claim. Before reserving fees and again
before submission, v2 reads the task and `is_claimable` from the chain.
Indexed history may be stale, and competing keepers are expected. The
same persistent task row deduplicates candidates seen through both
sources.

Until the indexer executable integration tracked by #582 is complete, the
direct RPC source is the default operational path.

## 7. Invariants for implementation

The implementation and tests must preserve these invariants:

1. At most one active local lease exists for a task identity.
2. A source cursor advances only with durable rows for every candidate
   before it.
3. A transaction envelope and hash are durable before first submission.
4. An ambiguous submission is reconciled; it is never replaced blindly.
5. Account sequence allocation is serialized per signing account.
6. Active fee reservations plus confirmed round spend never exceed the
   configured budget.
7. No claim is submitted without a fresh, passing profitability decision
   and an available executor.
8. Executor retries reuse the same idempotency key and checkpoint.
9. Indexed data proposes work; only current on-chain state authorizes it.
10. A restart processes reconciliation before leasing new work.

These invariants are the acceptance boundary for the E15 persistence,
concurrency, executor, profitability, and indexer-integration issues that
follow this design.
# Keeper Bot v2 Architecture & Cross-SDK Logic Parity

## 1. Executive Summary & Design Scope

The original keeper bot (`examples/keeper-bot`) was authored as a single-file CommonJS script prioritizing newcomer accessibility and contract exploration. While effective for learning, production operators running keepers competitively face requirements for concurrent task handling, granular shutdown draining, pluggable treasury/withdrawal strategies, and proactive lock-window re-checks.

**Keeper Bot v2** (`examples/keeper-bot-v2`) is introduced as a dedicated package designed for competitive operators without degrading the introductory clarity of `examples/keeper-bot`.

This document addresses:
1. **Core Architectural Decisions**: Package isolation, concurrency, persistence, shutdown, withdrawal, and scheduling models.
2. **Cross-SDK Logic Parity (Issue #405)**: A side-by-side comparison between Keeper Bot v2 and the Rust SDK (`rust-sdk` / `rust-sdk/examples/liquidation-keeper`) across **profitability calculation**, **retry classification**, and **lock-window awareness**.

---

## 2. Core Architectural Decisions

### 2.1 Package Relationship & Location
* **Decision**: Standalone package located at `examples/keeper-bot-v2`.
* **Rationale**: `CONTRIBUTING.md` establishes that `examples/keeper-bot` should remain simple, dependency-light, and beginner-friendly. Introducing worker pools, persistent databases, and multi-strategy registries into `examples/keeper-bot` would create cognitive overhead for first-time builders. Maintaining `examples/keeper-bot-v2` preserves `v1` for educational exploration while providing operators with a production-grade foundation.

### 2.2 Concurrency & Worker Management
* **Model**: Bounded worker pool where candidate tasks are claimed and executed concurrently up to a configurable concurrency limit (`CONCURRENCY_LIMIT`, default: 5).
* **Collision Prevention**: To prevent two internal workers in the same process from racing on the same task ID, candidate tasks are claimed in-memory in a pre-claim dispatch map before dispatching to the network.

### 2.3 Graceful Shutdown Under Concurrency (`src/shutdown.js`, Issue #402)
* **Guarantee**: When `SIGINT` or `SIGTERM` is captured, the bot immediately halts polling for new tasks.
* **Drain Discipline**: All active concurrent workers currently executing transactions or off-chain computations are tracked via `ShutdownCoordinator`. The process drains all in-flight workers so that no transaction is aborted mid-submission and task outcomes are cleanly recorded.
* **Bounded Drain Ceiling**: A hard timeout (`maxDrainMs`, default: 10,000ms) guarantees that a stalled RPC connection or hanging external script cannot keep the process deadlocked indefinitely.

### 2.4 Pluggable Withdrawal Strategy (`src/withdrawal.js`, Issue #400)
* **Default Parity**: `FixedThresholdStrategy` evaluates `balance >= WITHDRAW_THRESHOLD` (default 1 XLM), ensuring zero behavioral change when migrating from v1 to v2.
* **Reference Alternatives**:
  - `FixedScheduleStrategy`: Triggers withdrawals on a periodic schedule (e.g. hourly or daily) for predictable tax and accounting cycles.
  - `FeeAwareThresholdStrategy`: Lowers withdrawal thresholds during off-peak network fee windows and raises them during congestion.
* **Extensibility**: `WithdrawalManager` accepts any object or class implementing `evaluate({ balance, currentLedger, currentTimestamp, baseFee })`.

### 2.5 Lock-Window-Aware Scheduling (`src/scheduling.js`, Issue #399)
* **Contract Formula**: Mirrors `contracts/keeper-registry/src/internal.rs`:
  $$\text{unlock\_at} = \text{claim\_ledger} + \text{lock\_ledgers}$$
* **Proactive Scheduling**: When the bot discovers a task locked by a competing keeper, it computes $\text{unlock\_at}$ and tracks it in `LockWindowScheduler`. Once `current_ledger >= unlock_at`, the task is immediately re-evaluated.
* **Additive Dispatch**: Due tasks from the scheduler are merged additively with freshly polled tasks, giving priority to re-claim races while continuing to discover newly registered tasks.

---

## 3. Side-by-Side Logic Parity Review (Issue #405)

To ensure consistency across off-chain implementations interacting with the `KeeperRegistry` contract, this section reviews core logic between **Keeper Bot v2** (`examples/keeper-bot-v2`), the original bot (`examples/keeper-bot`), and the **Rust SDK** (`rust-sdk` and `rust-sdk/examples/liquidation-keeper`).

| Feature Domain | Keeper Bot v2 (`examples/keeper-bot-v2`) | Rust SDK (`rust-sdk` & `liquidation-keeper`) | Status & Agreement |
| :--- | :--- | :--- | :--- |
| **Profitability Calculation** | Pre-claim simulation estimating gas costs (`baseFee + resourceFee`), protocol fee deduction (`split_reward`), verifier proof cost, and minimum margin threshold (`netProfit >= minProfitMargin`). | `liquidation-keeper` checks `balance > 0` before calling `withdraw_rewards`. Tasks are selected by status (`Pending`) and type (`Liquidation`) without dynamic gas estimation. | **Intentional Difference**: The Rust SDK example is a minimal 55-line reference for testing client bindings. Keeper Bot v2 provides production fee-market modeling. |
| **Retry Classification** | Separates transport/network errors (transient: retried with exponential backoff & full jitter) from contract errors (permanent: simulation failure, `NotTaskClaimer`, `LockPeriodActive` never retried). | `rust-sdk/src/retry.rs` defines `RetryPolicy` and `default_classify`: `RpcCallError::Transport` is transient, `RpcCallError::Contract` is permanent. Default 4 attempts, 200ms base delay, 200ms jitter. | **Full Parity**: Exact alignment in classification semantics, backoff formula, and default retry parameters. |
| **Lock-Window Awareness** | Computes $\text{claim\_ledger} + \text{lock\_ledgers}$ with inclusive boundary ($\ge$). Proactively queues locked tasks for targeted re-check without full rescan. | Contract `internal.rs` enforces $\text{sequence} \ge \text{unlock\_at}$. The Rust SDK client exposes task status but leaves off-chain lock scheduling to consumers. | **Intentional Difference**: Contract arithmetic is mirrored identically. Scheduling is an operational feature implemented in Bot v2. |

---

### 3.1 Profitability Evaluation Analysis

#### Keeper Bot v2 Logic:
```javascript
// Step 1: Protocol fee split (matching internal.rs split_reward)
const protocolFee = (reward * BigInt(feeBps)) / 10000n;
const keeperNetReward = reward - protocolFee;

// Step 2: Transaction cost estimation (base fee + Soroban resource fee)
const totalEstimatedFees = BigInt(baseFee) + BigInt(minResourceFee) + verifierCost;

// Step 3: Profitability check against configured operator margin
const netProfit = keeperNetReward - totalEstimatedFees;
const profitable = netProfit >= BigInt(minProfitMargin);
```

#### Rust SDK Example Analysis:
In `rust-sdk/examples/liquidation-keeper/src/main.rs`:
```rust
for (idx, task_opt) in tasks.iter().enumerate() {
    if let Some(task) = task_opt {
        if task.task_type == TaskType::Liquidation && task.status == TaskStatus::Pending {
            raw_client.claim_task(&keeper_address, &task_id);
            ...
        }
    }
}
```
* **Review Finding**: The Rust SDK example does not simulate transaction costs or verify profitability before submitting `claim_task`.
* **Reasoning**: The Rust example serves as a lightweight integration test and demonstration of the `KeeperClient` API in a mocked test environment (`Env::default()`). Full gas estimation requires an active Soroban RPC server with simulation capabilities (`simulateTransaction`).
* **Conclusion**: This is an **intentional difference**. No bug or unintentional divergence was identified.

---

### 3.2 Retry Classification Analysis

#### Parity Verification:
1. **Keeper Bot (`index.js` & `v2`)**:
   - `isPermanentError`: Matches contract rejection phrases (`"simulation failed"`, `"already claimed"`, `"unauthorized"`, `"task not found"`).
   - Treats network timeouts, connection resets, and RPC `503` as transient.
2. **Rust SDK (`rust-sdk/src/retry.rs`)**:
   ```rust
   pub fn default_classify<C>(err: &RpcCallError<C>) -> ErrorClass {
       match err {
           RpcCallError::Transport(_) => ErrorClass::Transient,
           RpcCallError::Contract(_) => ErrorClass::Permanent,
       }
   }
   ```
* **Review Finding**: Both implementations follow the exact same invariant: **a decoded contract error indicates deterministic on-chain rejection and must never be retried**, whereas **transport failures indicate the call never reached the contract and may be safely retried**.
* **Conclusion**: **Full agreement**.

---

### 3.3 Lock-Window Awareness Analysis

#### Contract Invariant (`contracts/keeper-registry/src/internal.rs`):
```rust
pub(crate) fn lock_expired(e: &Env, task: &Task) -> bool {
    match task.claim_ledger {
        Some(claimed_at) => {
            let unlock_at = claimed_at.saturating_add(task.lock_ledgers);
            e.ledger().sequence() >= unlock_at
        }
        None => true,
    }
}
```

#### Keeper Bot v2 Scheduler (`src/scheduling.js`):
```javascript
function computeUnlockLedger(task) {
  const claimLedger = Number(task.claim_ledger ?? task.claimLedger);
  const lockLedgers = Number(task.lock_ledgers ?? task.lockLedgers);
  return claimLedger + lockLedgers;
}
```
* **Boundary Condition**: In both the contract and Keeper Bot v2, the boundary is **inclusive** (`>=`). At ledger $\text{claim\_ledger} + \text{lock\_ledgers}$ exactly, the lock is expired and the task is immediately claimable.
* **Review Finding**: Keeper Bot v2 tracks this boundary directly to schedule re-claims, preventing stale locks from lingering unaddressed until the next periodic poll.
* **Conclusion**: **Full agreement**.

---

## 4. Summary of Divergence Audit

During the cross-SDK audit, **no unintentional divergences or bugs were found** between Keeper Bot v2, the Rust SDK, and the core contract:
* All differences between the reference examples and production bots are deliberate design choices reflecting their respective roles (introductory documentation vs. competitive node operation).
* Arithmetic for fees, lock expiration, and retry backoff strictly adheres to the protocol specifications defined in `contracts/keeper-registry`.


## 5. Operational State, Prioritization, and Issue Requirements

### State Persistence Model

* **Problem**: v1 maintains no state across restarts or rounds, causing potential duplicate processing or lack of visibility into in-flight claims.
* **Solution**: `src/state.js` maintains task lifecycle states:
  * `DISCOVERED`: Task event picked up from ledger events or indexer.
  * `EVALUATING`: Profitability and eligibility checks in progress.
  * `CLAIMING` / `CLAIMED`: Task locked on-chain by this keeper.
  * `EXECUTING`: Off-chain computation in flight.
  * `EXECUTED`: Final `execute_task` completed on-chain.
  * `SKIPPED`: Task intentionally bypassed (with structured reason).
* Tasks marked `CLAIMING` or `CLAIMED` are locked within the local process, preventing concurrent internal workers from racing on the same task ID.

### Task Prioritization

* **Ranking by Expected Net Profit**: Candidate tasks discovered in a round are evaluated by expected net reward (`reward - estimatedGasFees`). Tasks are sorted descending by net profit.
* High-value tasks are claimed first, preventing lower-reward tasks from consuming available concurrency slots or budget allocations.

### Hard Ceiling on Per-Round Resource Spend (Issue #407)

#### Problem Statement
Concurrency and prioritization increase the volume of transactions a single keeper round can attempt. Without an explicit ceiling, candidate bursts (such as batch task registrations) or volatile network fee spikes could submit far more transactions than an operator intended, eroding margins or causing runaway fee spend.

#### Mechanism & Invariant Guarantees
1. **Configurable Ceiling**: Configured via `MAX_ROUND_SPEND_STROOPS` (default: 5,000,000 stroops = 0.5 XLM).
2. **Independent Backstop**: The spend ceiling is evaluated independently of task-level profitability. A task may have high expected profit, but if the round's cumulative spend has reached `MAX_ROUND_SPEND_STROOPS`, no further transactions (claims or executions) are dispatched in that round.
3. **Distinct Logging**: When the ceiling is reached, the keeper emits a distinct log:
   `[RESOURCE CEILING] Hard round spend ceiling reached: spent ${roundSpend} stroops (ceiling: ${maxSpend} stroops). Halting further submissions this round.`
4. **Metrics Tracking**: Increments `spend_ceiling_reached` in `src/metrics.js` and records skipped candidates under the structured skip reason `"spend_ceiling_reached"`.

---

### Multi-Keeper Competition & Lost-Race Handling (Issue #404)

#### Problem Statement
In production, multiple independent keeper bots compete to claim the same profitable tasks. In v1, an on-chain rejection due to a lost race (`TaskAlreadyClaimed`) was logged as an error and added to `summary.errors`, misrepresenting normal competitive dynamics as system failures.

#### Expected Behavior
1. **Success-with-Skip**: A lost claim race is recognized via `isLostClaimRaceError(err)` (matching error code 2 / `TaskAlreadyClaimed` / "already claimed" / "already locked" / "TaskNotPending"). It is treated as normal competition (`success-with-skip`), NOT logged as an error, and NOT appended to `summary.errors`.
2. **Round Continuation**: The bot logs `[COMPETITION] Task ${taskId} already claimed by competitor; treating as normal skip.` and immediately proceeds to evaluate remaining candidates in the queue.
3. **Metrics Distinction**: `src/metrics.js` records lost claim races under a dedicated counter `metrics.recordSkip("lost_claim_race", taskId)`, keeping it cleanly separated from `unprofitable`, `unsupported_executor`, or RPC errors.

---

### Deferral of Verifier-Aware Proof Generation (Issue #412)

#### Context and Problem Statement
Earlier backlog issues (`0090`, `0091`, and issues in the `0102`–`0140` range) proposed bot support for tasks gated by an on-chain verifier contract. Those design artifacts (`docs/VERIFIER_DESIGN.md`, `docs/VERIFIERS.md`) anticipated that keeper bots would synthesize zero-knowledge or external cryptographic proofs before executing tasks.

However, an audit of the deployed `KeeperRegistry` contract (`contracts/keeper-registry/src/`) reveals that **the contract-side verifier infrastructure does not exist**:
1. **Missing `Task.verifier` Field**: The `Task` struct on-chain has fields `id`, `owner`, `task_type`, `status`, `reward`, `calldata`, `deadline`, and `unlock_at`. It has **no** `verifier` field.
2. **Missing Entry Points**: The contract does **not** expose `update_verifier`, `set_verifier`, or `verify`.
3. **Missing Cross-Contract Invocation**: `execute_task` validates keeper locks, status, and caller authorization, but makes **no** cross-contract call to an external verifier.
4. **Placeholder Error Variant**: Only a placeholder error variant `IncompatibleVerifierInterface = 6` exists in `contracts/keeper-registry/src/errors.rs`, with no reachable code path inside the contract that ever constructs or returns it.

#### Explicit Deferral Policy
In accordance with Issue **#412**:
* **Explicit Dependency**: Verifier-aware proof generation in the bot is strictly blocked on the contract-side feature landing.
* **No Speculative Code**: **No bot code is written against an unimplemented verifier interface in keeper-bot-v2.** Building bot-side logic against a non-existent on-chain interface creates untestable dead code and misleads operators into believing the capability is operational.
* **Supersession Plan**: When the contract-side verifier capabilities are formally introduced (adding `Task.verifier`, registry verification entry points, and cross-contract validation in `execute_task`), this placeholder section will be superseded by active proof-generation implementations referencing the specific issue numbers assigned to that epic.

---

### Performance Benchmarking Methodology (Issue #413)

#### Benchmark Harness
The benchmark harness in `examples/keeper-bot-v2/benchmark/` tests Keeper Bot v1 (sequential) against Keeper Bot v2 (concurrent + prioritized) under strictly identical simulated conditions:
* **Workload**: 25 candidate tasks with heterogeneous reward distributions (50,000 to 1,500,000 stroops).
* **Simulated Network Latency**: Controlled 15ms delay per RPC simulation, claim, and execution call.
* **Contention**: 24% claim race rate (6 of 25 tasks) simulating mid-round claims by competing keeper bots.
* **v2 Concurrency**: 4 workers.
* **Spend Ceiling**: 5,000,000 stroops, enforced independently of task margins.
* **Metrics Recorded**:
  * Round Latency (ms)
  * Tasks Won / Executed
  * Net Profit Realized (stroops)
  * Error Counts & Lost Race Classification

#### Results (epic E15's evidence of value delivered)
The committed report (`examples/keeper-bot-v2/benchmark/REPORT.md`) recorded:

| Dimension | v1 (Sequential) | v2 (Concurrent & Prioritized) | Delta |
|---|---|---|---|
| Round Latency | 753 ms | 210 ms | **-72.1%** |
| Tasks Won | 19 | 19 | Same (contention bounded) |
| Net Profit | 15,960,000 stroops | 15,960,000 stroops | +0 |
| Reported Errors | 6 (false positives) | 0 | **-100%** |
| Lost Races Handled | 0 (counted as failure) | 6 (`success-with-skip`) | Resilient continuation |

The two headline results are the concurrency win (72.1% faster rounds, from overlapping RPC round trips across the worker pool rather than serializing them) and the observability fix (v1's 6 lost-claim-race false positives become 0 in v2, because a lost race is a normal competitive skip — see "Multi-Keeper Competition & Lost-Race Handling" above — not an error). Net profit and tasks won are identical, confirming v2's concurrency and spend-ceiling enforcement ("Hard Ceiling on Per-Round Resource Spend" above) do not trade correctness for speed.
