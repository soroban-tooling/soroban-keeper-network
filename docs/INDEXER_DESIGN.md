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
| Retention | Keep the complete raw event history for the lifetime of the instance; no automatic archival or pruning |

## Original design status

This section is the proposal the E14 implementation began from. The
implementation is now far enough along that its actual contract and the
places it diverged are recorded in the
[E14 retrospective](#e14-retrospective-and-consumer-handoff) below. Where
the proposal and retrospective disagree, the retrospective describes the
code that exists.
# Indexer Design

This is the design record for the event indexer (epic E14). It exists so
later issues — and operators — have a written answer rather than an
assumption that has to be rediscovered in the code.

The ingest mechanism, storage, reorg handling, backfill path, and API
shape from issue #346 belong in this document as well; they land as that
issue closes. Until they do, the schema comments in `indexer/src/schema/`
and `indexer/migrations/` are the reference for tables and columns.

Three questions were asked after the original design was scoped to a single
contract id, and they are answered here:

1. [One instance per registry deployment](#1-one-instance-per-registry-deployment)
   (issue #365)
2. [Event shape changes across contract `VERSION`](#2-event-shape-changes-across-contract-version)
   (issue #366)
3. [Data retention and archival](#3-data-retention-and-archival)
   (issue #375)

How to actually run an instance is in
[`INDEXER_DEPLOYMENT.md`](INDEXER_DEPLOYMENT.md). This document does not
restate that guide.

---

## 1. One instance per registry deployment

**Decision:** one indexer process tracks exactly one registry contract id,
on one network. Operators who need testnet, futurenet, and mainnet — or
a second mainnet deployment after a migration — run one instance per
`(network, contract id)` pair, each with its own database.

**Not chosen:** one process tracking several contract ids at once.

### Rationale

The original design (issue #218) was scoped to one contract id. That was
not an oversight that this issue is reversing; it is the model the
indexer is built around, and it stays the model for four independent
reasons.

**Networks do not share an RPC.** Testnet, futurenet, and mainnet are
different `getEvents` endpoints. A process that "indexed several
deployments" would still need one RPC client, one poll loop, and one
cursor per network. That is several instances running in one binary, not
a simpler operator story.

**Task ids are per-contract.** `next_task_id` is a per-deployment `u64`
(invariant I-7 in [`ARCHITECTURE.md`](ARCHITECTURE.md)). Two registries
in one `events` table would collide on `task_id`, and every derived view
— current task state, keeper balances, current config — would mix
unrelated deployments into a single answer. The only way to prevent
that is a `contract_id` column on every table, which is a schema rewrite
this issue is not expanding into.

**The checkpoint is single-tenant.** Ingestion progress is one row. The
idempotency keys (`(tx_hash, event_index)` in the event log, and
`(ledger, tx_index, event_index)` on the keeper and admin tables) do not
include a contract id. Two contracts on the same network can emit in the
same ledger; without a contract id in those keys, their events would
collide or silently overwrite.

**Operational isolation is the point.** A stuck testnet backfill, a
rate-limited public RPC, or a bad start-ledger should not stall mainnet
ingestion. Separate processes and separate databases give that isolation
for free. Sharing a database between instances is not supported: the
schema has no tenant key, so two instances writing to the same tables
would corrupt each other's checkpoint and history.

A future mainnet migration that deploys a new contract id is the same
situation as "we also have testnet": start a new instance against the
new id, and keep the old instance if the old history still needs to be
served. That is the operational model this decision is choosing, not a
workaround.

### What this means for operators

`INDEXER_CONTRACT_ID` (the contract id the process filters `getEvents`
on) is a single `C...` value, not a list. One process, one database, one
contract. The topology, including "do not share a database across
instances," is in [`INDEXER_DEPLOYMENT.md`](INDEXER_DEPLOYMENT.md).

### What this does not do

No `contract_id` column is added to the tables from issues #220–#222. If
multi-contract support is ever revisited, that schema change is a new
issue — it is not a silent expansion of this one.

---

## 2. Event shape changes across contract `VERSION`

**Decision:** coordinated indexer release. The indexer does not read the
contract's `VERSION` at ingest time and dispatch to a version-specific
parser.

The contract's `VERSION` constant exists so off-chain clients can detect
which ABI they are talking to. Event shapes are part of that ABI. When
a `VERSION` bump changes an event's payload, the indexer that is going
to ingest those events must already understand the new shape. Because
the indexer lives in this repository, that coordination is a same-repo
release: the parser change lands before, or in, the same revision that
bumps `VERSION` for an event-shape change.

**Not chosen:** reading `version()` on the live contract at ingest time
and switching parsers. After an `upgrade`, that view returns the *new*
VERSION for the entire history walk, including events emitted under the
old WASM. Dispatching on live `VERSION` would misparse everything from
before the upgrade the moment the contract is upgraded.

### How events are parsed today

`ingest::parse::parse_event` is the single decoder for both backfill and
steady-state ingestion. It already distinguishes two failure modes, and
this policy keeps both:

- **Unknown topic pair** — skipped, not fatal. A future contract version
  that *adds* an event must not halt ingestion of the events this indexer
  already understands. Those new events are a gap until the indexer is
  upgraded with a new match arm; they are not a crash.
- **Known topic, malformed payload** — an error, and it fails the batch.
  A recognised event whose fields no longer match is the contract's shape
  changing underneath the indexer. Silently dropping a `TaskExecuted`
  (or any other known event) would leave a hole in the history that
  nothing reports, and the derived keeper-balance view would disagree
  with the contract. Loud failure is the signal to ship the coordinated
  indexer release, not a bug.

### Parsing events from before a version change

Already-ingested rows are never re-parsed, migrated, or deleted when
`VERSION` changes. History is append-only: the row stored from a
pre-upgrade `TaskRegistered` stays that row. Derived views keep folding
it together with whatever is ingested after the upgrade.

Re-backfill from genesis after a breaking payload change is **not** a
supported recovery path on a parser that only understands the new
shape. The supported path is resume-from-checkpoint: the database
already holds the pre-upgrade history, and the upgraded indexer continues
from the last committed ledger. Wiping the database and replaying from
genesis is only safe when the parser still accepts every shape this
instance has ever stored — which, under this policy, means a payload
change is additive (see below) or the operator starts a new instance
instead of replaying.

### Parsing events from after a version change

Three kinds of `VERSION` bump, three indexer responses:

| What the upgrade did | Indexer behaviour |
| --- | --- |
| No event-shape change (new entry point, new error variant, bounded calldata — the v2 and v3 bumps were this kind) | Nothing. The same parser keeps working. A `VERSION` bump is not by itself an ingest event. |
| New event type (new topic pair) | The running indexer skips the new events and keeps ingesting the rest. Upgrade the indexer to start storing them; there is a gap for that event type until then, and it is visible as the `unrecognised` ingest counter. |
| Changed payload of a known event (added required field, changed a type, reordered fields) | The running indexer errors on the first such event and stops. Deploy the coordinated indexer release *before* (or as) the contract is upgraded so this path is never hit in production. |

"After the version change" therefore means: the upgraded indexer is
already running, and it parses the new shape. An old indexer that meets
a changed known payload is not asked to guess; it fails loudly.

### Already-ingested data

The rows already in the database are the history from before the
version change. They are not rewritten to look like the new shape.

- **Additive change** (new optional field, new event type): old rows
  keep their columns; a new nullable column may appear for the new
  field and stays `NULL` on old rows. Derived views that do not read
  the new field keep returning the same answers they did before.
- **Incompatible change** (a field's type or meaning changes): the
  indexer cannot fold old and new rows into one typed column without
  lying. That class of upgrade is treated as a new deployment under
  [§1](#1-one-instance-per-registry-deployment): freeze the existing
  instance as a historical archive, and start a new instance (new
  database, start ledger at the upgrade) against the new WASM. Mixing
  the two streams in one database is how derived balances would silently
  disagree with the contract.

### Why not `VERSION`-dispatch

A version-specific parser *keyed on the event's emission-time VERSION*
is a reasonable design for a project that must ingest mixed history
from many independently-upgraded deployments. It is the wrong design
here:

- Emission-time VERSION is not on the event. The contract does not
  stamp `VERSION` onto every payload. After `upgrade`, `version()`
  returns only the live WASM's value, so a dispatch table keyed on
  that call would be wrong for every historical event.
- Reconstructing emission-time VERSION from `Upgraded` events and
  ledger ranges is possible, but it is a second source of truth next
  to the already-append-only event log, and it is only needed if this
  instance is expected to re-parse mixed history. Under §1 it is not:
  one instance, one contract, resume-from-checkpoint, no genesis
  replay across a breaking shape change.
- The indexer and the contract share a repository. The coordinated
  release is a pull request, not a distributed-systems handshake.

If a future epic needs genesis replay across breaking shape changes,
that is the moment to introduce versioned parsers (one module per
contract `VERSION`, dispatched by ledger range bounded by `Upgraded`
events — never by live `version()`). It is a follow-up issue, not a
silent expansion of this one. Today's `parse_event` is the VERSION-3
decoder; a later VERSION-4 decoder would sit beside it rather than
replace it.

### What a coordinated release looks like

When a contract change will alter a known event's payload:

1. Update `parse_event` (and the stored payload type) to accept the
   new shape. If the old shape must remain readable — additive field —
   keep the existing arm and accept the extra field; do not rewrite the
   VERSION-3 arm out of existence.
2. Land that indexer change.
3. Then (or in the same revision) bump contract `VERSION` and upgrade
   the deployment.
4. Restart the indexer so it is running the new parser before the first
   post-upgrade event arrives.

A `VERSION` bump that does not touch event shapes needs no indexer
release.

---

## 3. Data retention and archival

**Decision:** keep every successfully ingested raw event in the primary
database for the full lifetime of an indexer instance. There is no
age-based expiry, automatic archival tier, aggregation-and-delete job, or
operator-supported pruning procedure.

This is a deliberate full-retention policy, not the absence of a policy.
The database grows monotonically, and the operator accepts that storage
cost in exchange for a complete audit trail.

### Why full retention wins

The raw event log is the indexer's evidence. It records which on-chain
events produced every answer exposed by the API and makes an independent
audit possible without trusting a mutable summary. That matters to E19's
audit-readiness work: a task state or keeper total can be traced to its
source events rather than accepted as an unexplained database value.

It is also part of the current correctness model, not merely historical
data. `TaskState`, keeper summaries, admin configuration, leaderboards,
and protocol statistics are folded from `events` on read. Dropping raw
rows after writing aggregates would make those aggregates a new source of
truth and would remove the documented ability to rebuild derived state.
Doing that safely would require versioned snapshots, reconciliation, and
restore tooling that the service does not have.

Finally, the upstream RPC retention window is finite. Once an old event
falls outside that window, a pruned indexer may not be able to reconstruct
it from the public RPC at all. Moving the only retained copy to a cold
format would save primary-disk cost but make ordinary audit and support
queries depend on a second storage system and a restore path. For one
registry deployment's compact event stream, that complexity is not
justified by measured storage pressure.

### Cost and operating rules

Full retention means disk use is unbounded over an unbounded service
lifetime. Operators must therefore treat database capacity as a normal
resource to provision and monitor:

- Alert on database-file size, free disk, and growth rate early enough to
  expand or move the volume before writes are affected.
- Take regular, tested backups of the entire SQLite database. A backup is
  disaster recovery, not an archive tier: it does not permit deleting the
  corresponding primary rows.
- Preserve the database when retiring an old contract deployment. Under
  the one-instance-per-deployment policy, that read-only database is the
  historical record for that deployment.
- Use API pagination and query limits to bound request cost. Those are
  serving controls and do not change what is retained.

Schema migrations must not delete historical event rows as routine
maintenance. `VACUUM` may reclaim unused SQLite pages after a migration or
recovery operation, but it is not a retention mechanism. Manual deletion
of old rows produces an unsupported, incomplete index and must not be
presented as a healthy full-history instance.

### Revisit trigger

There is intentionally no time or size threshold that starts deletion.
If measured growth makes full primary retention operationally
unacceptable, that is a new design decision and implementation issue. It
must define, before any row is removed, a versioned archive format,
integrity manifest, durable destination, restore procedure, and a query
path that clearly distinguishes online from archived history. Until that
work is reviewed and shipped, the only supported policy is full retention
forever.

---

## E14 retrospective and consumer handoff

E14 produced a typed fifteen-event model, idempotent ingestion, a
cursor-paged SQLite event store, state folds, backfill/checkpoint logic,
REST and WebSocket handlers, caching, rate limiting, authentication
primitives, OpenAPI generation, and repeatable load tests. This section
is the contract E15, E16, and E17 should use instead of reconstructing the
epic from its individual issues.

It is also an honest boundary statement: the components are implemented
and tested as library/router code, but the checked-in executable does not
yet run the ingestion loop or bind the HTTP server. That integration and
the duplicate storage paths are tracked in
[#582](https://github.com/soroban-tooling/soroban-keeper-network/issues/582).
This document does not describe the service as deployed until that issue
is resolved.

### What changed from the original design

| Area | Original decision | What was built and why |
| --- | --- | --- |
| Primary database | PostgreSQL through `sqlx`, with mutable derived tables | The API/backfill path uses an embedded SQLite `Store` and `sqlx` migrations. One process owns one contract database, so SQLite keeps deployment and tests self-contained without a database service. The tradeoff is that multi-process writers and horizontal database scaling are not supported. |
| Derived state | `tasks`, `keepers`, and `admin_state` tables updated transactionally with the raw log | The SQLite path keeps `events` authoritative and folds task, keeper, admin, leaderboard, and statistics state on read. This prevents a derived row from drifting from its evidence and makes replay deterministic, at the cost of aggregate query work that needs caching and request bounds. |
| Event identity | RPC event id as the primary key | `(tx_hash, event_index)` is the idempotency key. A separate monotonic SQLite `cursor` provides stable API pagination. This matches the identity the implemented decoder retains and makes overlapping backfill pages harmless. |
| API shape | General `/tasks` filters and `/keepers` aggregates | The implemented v1 routes are task detail, owner tasks, keeper tasks, admin config, leaderboard, event feed, and health. There is no claimable/status-filtered task collection. The route set follows the concrete handlers and generated OpenAPI file rather than the proposal table. |
| Live updates | Deferred WebSocket layer | `/v1/stream` ships the same `IndexedEvent` representation as REST, adds filters and replay from `after`, and then switches to live broadcast delivery. |
| Event projections | Dedicated relational columns and tables for each concern | The SQLite event table stores a typed JSON payload plus indexed task/owner/keeper columns. API response types remain independent of that schema, so a storage migration need not become an API break. |
| Deployment topology | One contract was assumed, not closed as a policy | Issue #365 made it explicit: one process and database per `(network, contract id)`. Multi-contract tenancy is not supported. |
| Event-version handling | Not specified beyond following the current contract | Issue #366 chose coordinated contract/indexer releases. Unknown new topics are skipped; a malformed payload for a known topic stops the batch rather than silently corrupting derived state. |

The crate still exports older `tokio-postgres` schema and ingest modules
alongside the SQLite path. They are not the v1 API's storage contract and
must not be combined with the SQLite migrations. Removing or consolidating
that second path is part of #582.

### Stable v1 consumer surface

Every HTTP path is rooted at `/v1`. The committed
`indexer/openapi.yaml`, generated from the Rust handlers and response
types, is authoritative for REST field names and types. Consumers should
ignore unknown response fields so additive v1 fields remain compatible.
A removal, rename, or meaning change requires a new API version.

| Method and path | Contract |
| --- | --- |
| `GET /v1/health` | Liveness plus `last_ingested_ledger` and `backfill_complete`. Consumers must use this freshness signal rather than assume a successful HTTP response means the index is caught up. |
| `GET /v1/tasks/{task_id}` | Current `TaskState` folded from indexed events plus observed task history; `404` means the registration has not been indexed. |
| `GET /v1/owners/{owner}/tasks` | Task states registered by an owner, newest task id first. |
| `GET /v1/keepers/{keeper}/tasks` | Task states claimed or executed by a keeper, newest task id first. |
| `GET /v1/admin/config` | Current configuration folded from public admin events. Optional fields mean the setting event has not been observed. |
| `GET /v1/leaderboard?rank_by=&since=&limit=` | Ranks by `executions` (default) or `reward`; ties are deterministic; `limit` is clamped to 200. |
| `GET /v1/events?after=&limit=&event_type=&address=` | Oldest-first event page. `limit` defaults to 50 and is clamped to 500. Pass `next_cursor` back as `after`; `null` means the current end. |
| `GET /v1/stream?after=&event_type=&address=` | WebSocket replay followed by live events. `event` contains exactly the REST `IndexedEvent`; `subscribed` confirms filters/replay, and `closed` gives a resumable reason. |

All `i128` token amounts are decimal strings in JSON. Timestamps are Unix
seconds, ledgers are unsigned integers, event names use snake case, and
errors use `{ "error": <stable code>, "message": <human text> }`.
Clients may branch on `error`, not on message wording.

The route names, event envelope, cursor meaning, and core response fields
above are the stable v1 contract. Request-cost policy is not yet final:
task/address pagination and leaderboard-window constraints may be tightened
by #580, and WebSocket connection/replay limits by #581. Those changes must
preserve resumability and use additive response fields where possible.
Authentication and higher-limit API-key behavior are also provisional
until #579. Anonymous public reads remain the baseline contract.

### Handoff by consumer

**E15 keeper bot v2.** Use `/v1/stream?event_type=task_registered` for
candidate discovery and persist the last processed cursor. On reconnect,
pass that cursor as `after` before consuming live events. The indexer is
advisory: always call the contract's `is_claimable` view immediately before
claim submission, because another keeper may win or ingestion may lag.
There is no v1 `status=registered`/claimable-work endpoint. Keep direct RPC
event scanning as the fallback until #582 produces a deployable service.

**E16 CLI tooling.** Generate or validate REST types from
`indexer/openapi.yaml`. Page `/events` by cursor rather than by offset and
surface health/backfill state with query results. Do not import SQLite
tables or the legacy PostgreSQL schema as an external contract.

**E17 dashboard.** Use task and address routes for detail views,
`/leaderboard` for rankings, and the WebSocket event envelope for live
updates. Display indexed freshness from `/health`. Treat aggregate data as
eventually consistent within ingestion lag plus the configured cache TTL;
do not present it as an authoritative on-chain precondition for a write.

### Resolved and deferred questions

- **Retention is resolved, not deferred:** issue #375 records deliberate
  full raw-event retention for the lifetime of each instance. There is no
  automatic pruning or cold archive.
- **Multi-contract indexing is resolved, not deferred:** run one isolated
  instance and database per deployment. A tenant key is absent by design.
- **Breaking event shapes are resolved, not deferred:** coordinate the
  indexer parser release with the contract release; do not dispatch by the
  contract's live `VERSION` while replaying old ledgers.
- **General availability is deferred:** #579, #580, and #581 are the
  mandatory findings from the public-API security review. They cover
  authenticated/bounded limiter identity, bounded REST work, and bounded
  WebSocket sessions/replay.
- **Runnable service integration is deferred:** #582 must converge the
  SQLite and legacy PostgreSQL paths and wire ingestion plus HTTP serving
  into `main.rs`.
- **Protocol statistics and the unified address activity projection are
  not public API:** query modules exist, but no v1 handlers or OpenAPI paths
  expose them. Consumers must not depend on those Rust functions as a
  remote contract.
- **Bulk export and a checked-in TypeScript indexer client are not present
  in this revision.** E16 should consume OpenAPI directly; large-history
  export remains future work and must use bounded or authenticated serving
  controls.

These gaps are named so later epics do not mistake source files or the
original proposal for capabilities available from the deployed v1 API.
