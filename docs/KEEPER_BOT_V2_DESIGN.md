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
