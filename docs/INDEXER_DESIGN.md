# Indexer Design

This is the design record for the event indexer (epic E14). It exists so
later issues — and operators — have a written answer rather than an
assumption that has to be rediscovered in the code.

The ingest mechanism, storage, reorg handling, backfill path, and API
shape from issue #346 belong in this document as well; they land as that
issue closes. Until they do, the schema comments in `indexer/src/schema/`
and `indexer/migrations/` are the reference for tables and columns.

Two questions were asked after the original design was scoped to a single
contract id, and they are answered here:

1. [One instance per registry deployment](#1-one-instance-per-registry-deployment)
   (issue #365)
2. [Event shape changes across contract `VERSION`](#2-event-shape-changes-across-contract-version)
   (issue #366)

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
