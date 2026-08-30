# Event Indexer Design (E14)

This is the design document for the registry event indexer — the decision
record the other issues in E14 (0219 onward) implement against. No code is
added by this document; it exists so the ingest mechanism, storage, and
schema are agreed on paper before several PRs build on top of them, the
same way E04's verifier work started with 0071.

## Context

Nothing in this project persists the registry's event history anywhere
durable. The keeper bot's own scan (`examples/keeper-bot`) recomputes a
~1000-ledger look-back window every round and discards what it reads — and
its two documented scan bugs (0032: the window is rescanned every round
because no cursor is persisted; 0038: `getEvents` is never paginated, so
`limit` silently truncates) are exactly the failure modes a real indexer
must not inherit. The consumers are concrete: the web dashboard (E17)
needs a task explorer, keeper leaderboard, and protocol stats; keeper bots
want "what is claimable right now" without re-deriving it from the chain;
integrators want a queryable event history for one contract.

## 1. Ingest mechanism

**Poll `getEvents` on an interval, with a persisted cursor and
cursor-based pagination.**

Polling is the pattern the keeper bot already proves against this
contract, and it is the only mechanism the *standard* Soroban RPC surface
guarantees: event streaming exists only as vendor-specific offerings, and
designing the indexer against one provider's stream would couple the whole
epic to that provider. Polling against `getEvents` runs identically on the
SDF testnet RPC, a self-hosted node, or any commercial provider.

Where the indexer must do better than the bot:

- **The cursor is persisted** (in the database, transactionally with the
  events it covers — see §6), so a restart resumes where ingestion stopped
  instead of rescanning a window. The RPC's `startLedger` and paging
  `cursor` are mutually exclusive inputs; the loop uses `startLedger` only
  on the very first request of a run and the returned cursor after that.
- **Every page is followed.** A page shorter than `limit` means caught up;
  anything else means keep paging before sleeping.
- **The retention window is a first-class constraint.** Public RPC nodes
  serve a bounded event history and, past it, return an error-free empty
  page — silence, not failure. The loop must treat "my resume point is
  older than the servable window" as an explicit condition (surfaced
  loudly, lag metric pinned — see 0231), never as "no new events".

One loop, one code path; backfill is the same loop with a different
starting point (§4).

## 2. Storage

**PostgreSQL, accessed from a Rust service (`indexer/`, a new workspace
member) via `sqlx`.**

Rust because the repository is a Rust workspace with a stable-toolchain CI
already in place, and the indexer wants the same event-shape knowledge the
contract crate defines — a second language buys nothing but a second
toolchain in CI (the bot stays JavaScript because it is an *example*; the
indexer is infrastructure). Postgres because the workload is append-mostly
and query-heavy: fifteen event types against one contract, written once,
queried by task id, owner, keeper, and time range. That is a relational
workload with a hard requirement the idempotency issue (0230) makes
explicit — a database-enforced unique key on events — and Postgres gives
that, plus the aggregate queries the leaderboard and stats issues need,
with the most boring operational story available. `sqlx` because it is the
idiomatic async Rust choice and its built-in migration runner answers
0232's "use idiomatic tooling, do not hand-roll" directly.

Considered and rejected: SQLite (fine for a laptop, but the API service
and ingest loop write and read concurrently, and the deployment story for
E17's dashboard wants a server database); an event-sourced queue (Kafka
et al.) between ingest and store (a second moving part that buys replay we
already get from the chain itself — the chain *is* the event log).

## 3. Reorg handling

**No reorg machinery. On Stellar this is not a real risk, and the
defensive posture for RPC-node bugs is idempotent, replayable ingestion —
which we need anyway.**

These motivate different handling, so plainly: Stellar Consensus Protocol
externalizes a ledger exactly once — there is no probabilistic finality
window and no chain reorganization to unwind, unlike Nakamoto-style
chains. An indexer for Stellar that carries rollback machinery is
modelling a failure its chain cannot produce.

What *can* happen is an RPC node misbehaving: redelivering events it
already served (a retried poll after a timeout whose response actually
landed), serving a truncated window silently, or — in the bug limit —
serving wrong data. The first two are handled structurally: every event
carries a database-unique key (§6), so redelivery is a no-op (0230), and
re-ingesting any ledger range is always safe, so the recovery action for
"this node served something suspect" is "point at a healthy node and
re-run the range", not a rollback protocol. Wrong data from a trusted RPC
is out of scope for the indexer, as it is for every other consumer of that
RPC in this project.

## 4. Backfill

**The steady-state loop, started from the beginning, against an RPC that
retains the range.** No separate backfill implementation.

First run with an empty database: the cursor table is empty, so the loop
starts from `INDEXER_START_LEDGER` (the contract's deployment ledger,
required configuration — there is no point scanning before the contract
existed) and pages forward at full speed; "caught up" and "steady state"
are the same condition (a short page), at which point the loop is simply
polling. There is no slow path distinct from the fast path — the only
difference between backfill and steady state is how many pages come back
before a sleep.

The honest constraint: a from-genesis backfill needs an RPC whose
retention covers the contract's lifetime. Against a standard public node
that retains days, a fresh indexer can only reconstruct what the node
still serves; the runbook answer is to run the backfill against an
archival endpoint (configuration, not code), and the loop's
retention-window detection (§1) makes the truncated alternative loud
instead of silent.

## 5. API shape

**REST, read-only, driven by the three named consumers.** WebSocket push
(0226) layers on later without schema changes.

| Consumer | Need | Endpoint |
| --- | --- | --- |
| Dashboard (E17) task explorer | tasks by status/owner, paginated, newest first | `GET /tasks?status=&owner=&limit=&offset=` |
| Dashboard task detail | one task + its full event history | `GET /tasks/{task_id}` |
| Dashboard leaderboard (0227) | per-keeper aggregates | `GET /keepers?order=lifetime_earned` |
| Keeper bots | claimable work without chain scans | `GET /tasks?status=registered` (plus deadline filters) |
| Integrators | raw history by task / address / time | `GET /events?type=&task_id=&address=&from_ledger=&to_ledger=` |
| Operators (0231) | lag + verdict | `GET /health` |

Queries the schema must serve cheaply, therefore indexed: task by id;
tasks by (status, deadline); tasks by owner; events by task id (the
`events.task_id` column exists for exactly this); events by
(type, ledger); keeper aggregates by keeper address. Anything not listed
here (full-text, arbitrary joins) is explicitly not a goal.

## 6. Schema

The tables 0220–0222 implement, and the raw table everything rides on.
Payload fields below are exactly `events.rs` today — fifteen events, no
more (the README's event table currently also lists two verifier events
that do not exist in code; this schema follows the code).

### `ingest_cursor`

| column | type | notes |
| --- | --- | --- |
| `id` | `text primary key` | single row, `'ingest'` |
| `last_ledger` | `bigint not null` | last fully ingested ledger |
| `updated_at` | `timestamptz not null` | |

### `events` — raw, append-only, the idempotency boundary (0230)

| column | type | notes |
| --- | --- | --- |
| `event_id` | `text primary key` | the RPC event id — a TOID-derived token encoding (ledger, tx application order, operation index, event index). Deterministic per protocol, so **stable across backfill and steady-state**, both of which read the same `getEvents` surface. This is the documented uniqueness key: duplicates are dropped by `on conflict do nothing`, and derived-table effects apply only when the raw insert actually inserted. |
| `ledger` | `bigint not null` | |
| `closed_at` | `timestamptz not null` | ledger close time |
| `contract_id` | `text not null` | one contract today; keyed for honesty |
| `type` | `text not null` | one of the fifteen names below |
| `task_id` | `bigint null` | the task a task-scoped event concerns, extracted from the payload; null for admin/keeper-scoped events. Indexed (partial, where not null) so the task detail page's "events for this task" query — a first-class need in §5 — is an index hit, not a jsonb scan |
| `payload` | `jsonb not null` | decoded fields, exactly as listed below |

Event names, topic pairs, and payload fields (verbatim from `events.rs`):

| type | topics | payload fields |
| --- | --- | --- |
| `task_registered` | `("reg","task")` | `task_id: u64, owner: Address, reward: i128, deadline: u64` |
| `task_claimed` | `("claim","task")` | `task_id: u64, keeper: Address, ledger: u32` |
| `task_executed` | `("exec","task")` | `task_id: u64, keeper: Address, net_reward: i128, proof: Bytes` |
| `task_expired` | `("exp","task")` | `task_id: u64` |
| `task_cancelled` | `("cancel","task")` | `task_id: u64, owner: Address` |
| `rewards_withdrawn` | `("wdraw","reward")` | `keeper: Address, amount: i128` |
| `paused` | `("paused","admin")` | `paused: bool` |
| `fee_updated` | `("fee","admin")` | `old_bps: u32, new_bps: u32` |
| `admin_transferred` | `("admin","xfer")` | `old_admin: Address, new_admin: Address` |
| `reward_increased` | `("topup","task")` | `task_id: u64, new_reward: i128` (new total, not delta) |
| `deadline_extended` | `("extend","task")` | `task_id: u64, new_deadline: u64` |
| `min_reward_updated` | `("minrwd","admin")` | `old_min: i128, new_min: i128` |
| `fees_swept` | `("sweep","admin")` | `treasury: Address, amount: i128, remaining: i128` |
| `initialized` | `("init","admin")` | `admin: Address, reward_token: Address, fee_bps: u32` |
| `upgraded` | `("upgrade","admin")` | `admin: Address, new_wasm_hash: BytesN<32>` |

(Filter gotcha the ingest loop inherits from the README: `("admin","xfer")`
is the only event with `"admin"` as its *first* topic — filtering "admin
events" means matching both topic positions.)

### `tasks` — derived (0220)

| column | type | fed by |
| --- | --- | --- |
| `task_id` | `bigint primary key` | `task_registered` |
| `owner` | `text not null` | `task_registered` |
| `reward` | `numeric not null` | `task_registered`, `reward_increased` |
| `deadline` | `bigint not null` | `task_registered`, `deadline_extended` |
| `status` | `text not null` | `registered → claimed → executed`, or `expired` / `cancelled`; a lock-expired reclaim is another `task_claimed` |
| `claimed_by` | `text null` | `task_claimed` |
| `claimed_at_ledger` | `bigint null` | `task_claimed` |
| `executed_by` / `net_reward` / `proof` | `text / numeric / bytea, null` | `task_executed` |
| `created_ledger` / `updated_ledger` | `bigint not null` | bookkeeping |

Indexes: `(status, deadline)`, `(owner)`.

### `keepers` — derived (0221)

| column | type | fed by |
| --- | --- | --- |
| `keeper` | `text primary key` | first appearance |
| `balance` | `numeric not null` | `+ net_reward` on `task_executed`, `- amount` on `rewards_withdrawn` — mirrors the contract's accrual accounting |
| `lifetime_earned` | `numeric not null` | `+ net_reward` on `task_executed` |
| `tasks_executed` | `bigint not null` | count of `task_executed` |
| `tasks_claimed` | `bigint not null` | count of `task_claimed` |

### `admin_state` + the raw log — derived (0222)

Current values in one row (`fee_bps`, `min_reward`, `paused`, `admin`,
`reward_token`, `wasm_hash`, each with its `updated_ledger`); history needs
no table of its own — it is a `type`-filtered query on `events`.

### Derived-view discipline

Derived tables are projections of `events` and carry no information of
their own: every derived write happens in the same transaction as its raw
insert, applies only if that insert was not a duplicate (0230), and any
derived table can be rebuilt by replaying `events` from zero. That last
property is the §3 recovery story and the schema-evolution escape hatch in
one.

## Summary of decisions

| Question | Decision |
| --- | --- |
| Ingest | Poll `getEvents`; persisted cursor, full pagination, retention-window detection |
| Storage | PostgreSQL via `sqlx` from a Rust workspace member (`indexer/`) |
| Reorgs | Not a real risk under SCP finality; RPC misbehaviour is absorbed by keyed, replayable ingestion |
| Backfill | Same loop from `INDEXER_START_LEDGER`; archival RPC is configuration, not a code path |
| API | Read-only REST per the consumer table; WebSocket later, schema-compatible |
| Uniqueness key | RPC event id (TOID-derived: ledger, tx order, op index, event index), unique-constrained in `events` |

## Status

Proposed. Per this issue's own acceptance criteria, 0219 onward should
wait for a maintainer to review and lock these decisions — this document
is the basis for that review, not a substitute for it. (0219's scaffold is
being prepared against it in parallel; everything scaffolded is what this
document specifies.)
