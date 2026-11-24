# Batch Registration Helper

> **CLI available:** This script has been ported into the `skn` CLI as
> [`skn batch register`](../../packages/cli/src/commands/batch/register.ts),
> where it shares named network profiles, signing-key sources (`--key-file`,
> `--identity`, `SKN_SECRET_KEY`), and `--json` output with the rest of the
> toolkit:
>
> ```bash
> # Validate and preview without signing or submitting:
> skn batch register examples/batch-register/tasks.example.json --dry-run
>
> # Submit against the active profile or --contract-id:
> skn batch register examples/batch-register/tasks.example.json --contract-id <C...>
> ```
>
> Both `skn batch register` and the standalone `index.js` in this folder accept
> the exact same JSON and CSV task-list formats documented below.

Owner-side tooling for dApp integrators: takes a list of tasks you want
automated and registers them all in a single `batch_register_tasks` call.

This is the counterpart to [`examples/keeper-bot`](../keeper-bot), which is
*keeper*-side — it claims and executes tasks other people registered, and has
no reason to register any itself. Neither example depends on the other; this
one is a standalone script you run when you have work to post.

Design background and the full integration guide live in
[docs/BATCH_OPERATIONS.md](../../docs/BATCH_OPERATIONS.md). This README covers
the file format and how to run the script.

## Quick start

```bash
cd examples/batch-register
npm install
cp .env.example .env
# Fill in OWNER_SECRET_KEY (funded) and REGISTRY_CONTRACT_ID

# Validate and preview without signing or sending anything:
node index.js tasks.example.json --dry-run

# Submit for real:
node index.js tasks.example.json
```

Output on success reports each returned task id next to the entry that
produced it, so you can record the mapping in your own system:

```
→  Chunk 1/1: 3 entries, max_total_reward=4500000
   tx 9f1c…c2d4

  Task id  │  Entry
  ─────────┼──────────────────────────────────────────────
        41  │  liquidate-position-1041
        42  │  liquidate-position-1042
        43  │  push-xlm-usd-price

✅  Registered 3 task(s).
```

## Task list format

Two formats, chosen by file extension — `.csv` is read as CSV, anything else
as JSON. Both produce identical results; use whichever your own tooling emits.

### JSON

Either a bare array or `{ "tasks": [ … ] }`. See
[`tasks.example.json`](tasks.example.json).

```json
{
  "tasks": [
    {
      "label": "liquidate-position-1041",
      "task_type": "Liquidation",
      "calldata": "6c69717569646174653a706f736974696f6e3a31303431",
      "reward": "1000000",
      "deadline": "4102444800",
      "ttl_ledgers": 17280,
      "lock_ledgers": 120
    }
  ]
}
```

### CSV

Header row required; `#` comment lines and blank lines are ignored. See
[`tasks.example.csv`](tasks.example.csv).

```csv
label,task_type,calldata,reward,deadline,ttl_ledgers,lock_ledgers
liquidate-position-1041,Liquidation,6c6971…3431,1000000,4102444800,17280,120
```

The CSV reader is deliberately minimal (comma-separated, optional double
quotes, `""` for an escaped quote) rather than a full RFC 4180 parser — a task
list is a short operator-authored file, and a CSV dependency would add more
surface than it removes. Use JSON if your calldata needs embedded newlines.

### Fields

| Field | Type | Notes |
|---|---|---|
| `label` | string, optional | Only used in this script's own output, to name the entry in logs and in the task-id table. Defaults to `entry #N`. |
| `task_type` | string | One of `Liquidation`, `OraclePricePush`, `FundingRateUpdate`, `LiquidityRebalance`, `TtlExtension`, `Custom`. |
| `calldata` | hex string | The bytes a keeper uses to reconstruct your target call. `0x` prefix optional; empty is allowed. Max 1024 bytes (2048 hex chars). |
| `reward` | integer | Escrowed bounty in token units (stroops for XLM). **Quote it as a string in JSON** — it is an `i128` and can exceed what a JS number holds exactly. |
| `deadline` | integer | Unix timestamp (seconds) after which the task may be expired. Must be in the future. |
| `ttl_ledgers` | integer | Storage lifetime for the task entry. Minimum 1000. |
| `lock_ledgers` | integer | Ledgers the claiming keeper holds exclusively. Must be in `[12, 17280]`. |

Underscores in numeric fields (`1_000_000`) are accepted and stripped.

## Recipes

Each recipe ships a sample input under [`recipes/`](recipes) that passes
`--dry-run`. A test (`npm test`) re-runs that dry run for every sample, so the
files cannot silently go stale. The samples use a deadline in the year 2100 so
they stay valid; for real use, generate deadlines relative to the current time
(see [staggered deadlines](#recipe-staggered-deadlines)).

All commands below run from `examples/batch-register` with
`REGISTRY_CONTRACT_ID` set. `--dry-run` does not need `OWNER_SECRET_KEY`.

### Recipe: many TTL extensions

Use case: keep a set of your own storage entries alive by registering one
`TtlExtension` task per entry. [`recipes/ttl-extensions.json`](recipes/ttl-extensions.json)
has 12 entries that differ only in `label` and `calldata`.

```bash
node index.js recipes/ttl-extensions.json --dry-run
node index.js recipes/ttl-extensions.json
```

- Shared fields (`task_type`, `reward`, `deadline`, `ttl_ledgers`,
  `lock_ledgers`) repeat on every row. Generate the file from your own list of
  storage keys rather than editing it by hand.
- Keep `reward` just above the registry's `min_reward`. The dry run reads it
  from the chain only when `OWNER_SECRET_KEY` is set; with a key, a reward
  below `min_reward` is reported locally for every offending entry at once.
- Lists longer than the registry's `max_batch_size()` are split into several
  atomic transactions automatically. See
  [Chunking](#chunking-and-the-batch-size-ceiling).

### Recipe: staggered deadlines

Use case: spread tasks over time so they do not all expire at the same moment.
[`recipes/staggered-deadlines.csv`](recipes/staggered-deadlines.csv) gives
eight `LiquidityRebalance` tasks whose deadlines are one hour apart.

```bash
node index.js recipes/staggered-deadlines.csv --dry-run
```

The sample deadlines are fixed placeholders. To stagger from the current time,
generate the column when you build the file, for example:

```bash
node -e '
const start = Math.floor(Date.now() / 1000) + 3600; // first deadline: +1 h
const step = 3600;                                  // one hour apart
for (let i = 0; i < 8; i++) console.log(start + i * step);
'
```

Deadlines must be in the future when the transaction is submitted, so leave
margin for review time. The dry run rejects any entry whose deadline has
already passed, and reports all of them at once.

### Recipe: recovering from a partially failed batch

Each chunk is its own atomic transaction (see
[Chunking](#chunking-and-the-batch-size-ceiling)): a chunk either registers
every entry or none. A *list* spanning several chunks can therefore land
partway. Files for this recipe are in
[`recipes/partial-failure/`](recipes/partial-failure): `batch.json` is the
original 6-entry list and `batch.remaining.json` is what you would resubmit if
the first 3 entries had landed.

When a chunk fails, the script prints which chunks already landed, which chunk
registered nothing, and which entries to resubmit (`entries N..M`), followed by
the table of task ids it did register. To resume safely:

1. **Do not rerun the original file.** Registration is not idempotent: running
   it again would register the landed entries a second time and escrow their
   rewards twice.
2. **Save the task-id table the script printed.** It maps each registered task
   to its `label`. Task ids are the only link between your list and the chain.
3. **Check the failed chunk really failed.** If the error says
   `Transaction <hash> failed: NOT_FOUND`, the script gave up polling but the
   transaction may still land later. Look the hash up on a block explorer or
   via RPC `getTransaction` and wait until it is `SUCCESS` or `FAILED` (or has
   expired) before continuing. Resubmitting while the first attempt is still
   pending can register the same entries twice. A `Simulation failed` or
   `Send failed` error means nothing was submitted.
4. **Fix the cause.** Typical causes are an entry the contract rejects, a
   registry that is paused, or an owner balance that does not cover the chunk.
5. **Build the resume file** from the entries that did not land, keeping their
   original order. Using `jq`:

   ```bash
   # Entries 4..6 of the original list (the script's "entries 4..6" message).
   jq '{tasks: .tasks[3:]}' recipes/partial-failure/batch.json > batch.remaining.json
   ```

6. **Dry-run, then submit:**

   ```bash
   node index.js recipes/partial-failure/batch.remaining.json --dry-run
   node index.js recipes/partial-failure/batch.remaining.json
   ```

If you are unsure what landed, call `skn task view <task-id>` for the ids you
hold, or read the registry's task events, before building the resume file. When
in doubt, resubmit fewer entries: a task you forgot to register can be added
later, but a duplicate costs you a `cancel_task` and a refund round trip.

## How `max_total_reward` is set — and why

**The script sets `max_total_reward` to the exact sum of the chunk it is
submitting.** No padding, no round-number buffer.

`max_total_reward` is a ceiling on how much escrow one call may pull from the
owner. The reasoning for the exact sum:

- The call is **atomic** — either every entry in it registers or none does
  ([docs §3](../../docs/BATCH_OPERATIONS.md)). There is no partial-success
  case that a buffer would rescue; a batch that would exceed a tight ceiling
  fails just as completely as one that exceeds a loose one.
- So padding buys nothing, and costs something: it widens the window in which
  the transaction could move more escrow than you reviewed. That is precisely
  the risk this parameter exists to close. A ceiling set to "some big number to
  be safe" is not a ceiling, it is a rubber stamp.
- The sum is computed with `BigInt`, so a long list of large rewards cannot
  silently lose precision the way floating-point addition would — a rounding
  error here would either fail the whole batch or authorize more than intended.

The script prints the sum before submitting so you can check it against what
you expected.

If your workflow genuinely needs headroom — for instance, an operator appends
entries to the file between review and submission — set
`MAX_TOTAL_REWARD_BUFFER_BPS` in `.env`. It is `0` by default, deliberately,
and the script prints a warning on every run where it is not.

## Chunking and the batch-size ceiling

The contract enforces a `MAX_BATCH_SIZE` (currently **50**) and rejects
anything larger with a typed `BatchTooLarge` error. The script reads the live
value from the registry's `max_batch_size()` view rather than hardcoding it,
then splits a longer list into that many entries per transaction.

Two things worth knowing:

- **50 is a conservative guard, not a measured ceiling.** Measuring the real
  limit against Soroban's per-transaction budget is still open work (backlog
  issue 0104), so the constant may be revised. That is why the script reads it
  from the chain — and why your own integration should too.
- **Entry count is only half the story.** Each entry writes a task whose
  `calldata` may be up to 1024 bytes, so 50 maximum-sized entries is already
  ~50 KB of ledger writes before the per-entry token transfer and event are
  counted. A list combining large payloads *and* many entries can exhaust the
  transaction budget below the 50-entry cap. If you hit resource errors, chunk
  smaller — the script's chunk size is derived from the contract's cap, not
  from your payload sizes.

**Each chunk is an independent atomic transaction** with its own
`max_total_reward` — never the sum across chunks. If chunk 3 of 5 fails, the
script reports that chunks 1–2 already landed, chunk 3 registered nothing and
moved no escrow, and chunks 4–5 were not attempted, along with which entries
to put in the resubmission.

## Pre-flight validation

Before sending anything, the script checks every entry locally against the
contract's own bounds (reward positive and at or above the registry's
`min_reward`, deadline in the future, calldata within 1024 bytes, `lock_ledgers`
and `ttl_ledgers` in range) and reports **all** failures at once.

This matters because the contract rejects the *whole* batch on the first bad
entry it encounters — so without a local pass, fixing a list with three
mistakes in it costs three failed transactions.

## Notes

- The owner account must hold enough of the registry's reward token to cover
  the full sum, plus fees. All escrow is pulled from the one signing account:
  entries carry no per-entry owner, and the whole batch is authorized by a
  single signature.
- Registered tasks are ordinary tasks. Each entry's escrow is refundable
  independently via `cancel_task` or `expire_task`; nothing about having been
  registered in a batch ties them together afterwards.
- The registry must not be paused — `batch_register_tasks` opens new escrow
  exposure and is blocked while paused, like `register_task`.
