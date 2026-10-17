# Batch Operations Design & Integration Guide (E05)

**Status: implemented.** `batch_register_tasks` now exists in
`contracts/keeper-registry/src/lib.rs`, together with the `MAX_BATCH_SIZE`
guard and the `max_total_reward` ceiling this document specified. This
document originally answered issue 0097's design questions and issue 0108's
integration-guide ask by pinning the interface on paper — the same pattern
`docs/VERIFIER_DESIGN.md` used for the E04 verifier field — and it is now
also the reference for the shipped behaviour.

One caveat carried over from the design phase: the batch-size ceiling
(`MAX_BATCH_SIZE`, currently **50**) is a *conservative, not yet empirically
measured* bound. Measuring the real ceiling against Soroban's per-transaction
budget is issue 0104's job (see §4); until it lands, treat 50 as a safety
guard, not a tuned optimum. Callers should read it from the contract via the
`max_batch_size()` view rather than hardcoding it, so a later revision does
not silently invalidate their chunking logic.

## 1. Why batch registration

`register_task` pays a fixed per-call overhead — owner auth, one storage
write, one instance TTL bump, one event — for every single task. A dApp with
many similar tasks to register at once (e.g. a lending protocol opening N
liquidation watches after a market listing) pays that overhead N times over
N separate transactions. `batch_register_tasks` amortizes it: one auth, one
transaction, N storage writes.

## 2. Auth model

**The batch shares one owner and one auth**, exactly like a single
`register_task` call: `owner.require_auth()` is checked once for the whole
batch, not once per entry. This matches the existing single-task UX and
avoids requiring N separate signatures for what the caller intends as one
logical action.

The risk this creates: an owner reviews and signs a transaction containing
batch contents at simulation time, but (in principle) the batch's *effect* —
total escrow pulled — could differ from what was reviewed if the entries
were mutated between simulation and submission. Soroban authorization is
scoped to the specific invocation's arguments (the signed auth entry commits
to the exact `tasks` vector and its rewards), so unlike an ERC-20-style
unlimited approval, this is **not** the same class of risk as an approve/
transferFrom mismatch — the signature is over the actual argument bytes, so
the batch itself cannot be silently swapped for a different one without
invalidating the signature. `max_total_reward` (§6, from issue 0103) exists
as an explicit, human-readable ceiling on top of that: even correctly-signed
batch contents get an extra sum check the caller doesn't have to reason
through the full argument encoding to verify at a glance.

## 3. Partial-failure semantics

**Whole-batch atomicity — no partial success.** A Soroban contract
invocation is atomic by construction: if the function returns `Err`, the
host reverts every storage write and token transfer the call made, and none
of it lands on-chain. There is no host-level primitive for "commit entries
1–7, skip entry 8" within a single function call — partial success would
have to be hand-rolled by catching per-entry failures and choosing to
continue, which this design rejects for two reasons:

- It would mean a batch could pull escrow from the owner for M ≤ N tasks
  while silently dropping the rest, requiring the caller's off-chain code to
  reconcile which task ids were actually created — the same "did my batch
  partially land" bookkeeping problem `execute_task`'s all-or-nothing
  design already avoids for a single task.
- `register_task`'s existing semantics are all-or-nothing per call; batching
  should not introduce a second, inconsistent failure model alongside it.

If any entry has an invalid `reward` (`<= 0` or below `MinReward`), an
invalid `deadline`, oversized `calldata`, or out-of-range `lock_ledgers`/
`ttl_ledgers` — or the batch's total exceeds `max_total_reward` — **the
entire call is rejected and zero transfers occur**, with a typed error
identifying which validation failed. The caller corrects the offending entry
and resubmits the whole batch.

## 4. Resource ceiling

**Enforced at 50 entries (`MAX_BATCH_SIZE`), not yet empirically tuned.** The
contract rejects a batch over that size with `KeeperError::BatchTooLarge`
before doing any work, so an oversized batch fails with an actionable typed
error rather than an opaque host-level resource-exhaustion failure. Measuring
the *real* ceiling against Soroban's per-transaction CPU/memory budget remains
issue 0104's job; 50 is deliberately conservative until then. What informs it:

- Entry count is only half the story. Each entry writes one `Task`, whose
  `calldata` alone may be up to `MAX_CALLDATA_LEN` (1024) bytes — 50 entries
  is already ~50 KB of ledger writes before the rest of the `Task` struct, the
  per-entry token transfer, and the per-entry event are counted. A batch of
  small-`calldata` entries has far more headroom than a batch of
  maximum-sized ones, and a caller who packs both large payloads and many
  entries can still exhaust the budget *below* the 50-entry cap.
- Read the cap from the contract (`max_batch_size()`) rather than hardcoding
  50, so issue 0104's revision does not silently break your chunking.

The rest of this section is the original design-phase reasoning, retained
because it is what issue 0104 should follow when it measures:

- `register_task`'s own per-call cost (auth, one storage write of a
  `Task`-sized value, one TTL bump, one event) is the per-entry unit cost a
  batch of N entries roughly multiplies by N, plus the batch call's own
  fixed overhead (one auth check, iterating the input `Vec`, one aggregate
  `max_total_reward` sum check up front).
- Issue 0107 adds pinned CPU-instruction ceiling tests for `claim_task` and
  `execute_task` using `env.cost_estimate().budget()`
  (`contracts/keeper-registry/src/test/perf.rs`). The same measurement technique
  applies directly to `register_task` and, once implemented,
  `batch_register_tasks` — issue 0104 should measure the real batch call at
  increasing N until it approaches Soroban's per-transaction instruction
  budget, and pin the largest N that stays comfortably under it as the
  practical ceiling, exactly as issue 0104's acceptance criteria describe.
- Until that measurement exists, treat any batch size guidance as
  provisional. The worked example in §7 below illustrates the *reasoning*
  a dApp should apply, using a placeholder ceiling — substitute the real
  number issue 0104 measures and documents.

**The contract enforces an explicit `MAX_BATCH_SIZE` constant**, to be resized
from that measurement with headroom, so a caller that submits too large a
batch gets a clear typed error (`KeeperError::BatchTooLarge`) rather than an
opaque host-level resource-exhaustion failure. This is what issue 0104's
regression test pins against.

## 5. Return shape

`register_task` returns a single `u64`. A batch call returns a `Vec<u64>` in
the same order as the input `tasks` vector, so the caller can zip its own
input list against the result to know which task id corresponds to which
entry it submitted.

## 6. Function signature (as shipped)

```rust
/// One entry in a `batch_register_tasks` call — the same fields
/// `register_task` takes, minus `owner` (shared across the whole batch).
#[contracttype]
#[derive(Clone)]
pub struct BatchTaskParams {
    pub task_type: TaskType,
    pub calldata: Bytes,
    pub reward: i128,
    pub deadline: u64,
    pub ttl_ledgers: u32,
    pub lock_ledgers: u32,
    /// Optional pre-claim condition. `None` preserves the original behavior.
    pub condition: Option<Address>,
}

/// Registers every entry in `tasks` under a single owner auth. Rejects the
/// entire call (zero transfers, zero tasks registered) if any entry fails
/// `register_task`'s existing per-entry validation, if `tasks` exceeds
/// `MAX_BATCH_SIZE`, or if the sum of all entries' `reward` exceeds
/// `max_total_reward`. Returns task ids in the same order as `tasks`.
pub fn batch_register_tasks(
    e: Env,
    owner: Address,
    tasks: Vec<BatchTaskParams>,
    max_total_reward: i128,
) -> Result<Vec<u64>, KeeperError>;

/// Read-only: the deployed contract's own `MAX_BATCH_SIZE`. Chunk against
/// this rather than a hardcoded constant.
pub fn max_batch_size(e: Env) -> u32;
```

### Error variants introduced

| Variant | Discriminant | Raised when |
|---|---|---|
| `BatchTooLarge` | 20 | `tasks.len() > MAX_BATCH_SIZE` |
| `EmptyBatch` | 21 | `tasks` is empty — rejected rather than treated as a no-op, so a caller whose off-chain filter produced nothing finds out instead of paying for a transaction that registered nothing |
| `BatchRewardCeilingExceeded` | 22 | `sum(tasks[].reward) > max_total_reward` |

A batch also returns any of `register_task`'s existing per-entry errors
(`InvalidReward`, `DeadlinePassed`, `CalldataTooLarge`, `InvalidTaskParams`),
plus `ContractPaused` and `InvalidReward` for a non-positive
`max_total_reward`. Per-entry validation is shared with `register_task`
through one internal helper, so the two paths cannot drift into accepting
different task shapes.

The shared helper also receives each entry's optional `condition`. Condition
addresses are permissionless, exactly as they are in `register_task`: the
registry validates the bounded `Option<Address>` shape at registration and
evaluates a configured contract only when a keeper claims the task. A mixed
batch may therefore contain conditioned and unconditional entries. Omitting the
field (`None`) behaves exactly like the pre-condition batch path.

**Validation happens before any transfer.** The implementation sweeps every
entry and totals the rewards up front, then checks the ceiling, and only then
performs the escrow transfers. A batch that will be rejected therefore never
pays for even one cross-contract token transfer first.

## 7. `max_total_reward` and batch-size tradeoffs

These are the two levers a dApp integrator actually controls, and they pull
in opposite directions:

- **`max_total_reward` too tight** (set to exactly the batch's current sum,
  or below it): protects the owner precisely, but any legitimate late
  addition to the batch — or simply computing the sum with a rounding bug —
  makes the whole call fail, including the valid entries within it (§3: no
  partial success). Guidance: set it to the actual sum of the batch you are
  submitting, not a round-number guess; since the whole call is atomic, there
  is no benefit to padding it — padding only widens the window in which a
  batch could authorize more escrow than the caller reviewed, which is the
  exact risk this parameter exists to close (§2).
- **`max_total_reward` too loose** (e.g. an arbitrary large constant "to be
  safe"): defeats the purpose entirely — it stops being a meaningful ceiling
  the owner reviewed and becomes a rubber stamp. Always compute it from the
  batch you are actually about to submit.
- **Batch size too large**: more amortization of the fixed per-call
  overhead, but higher risk of hitting Soroban's per-transaction resource
  budget (§4) — and if it does, the *entire* batch fails atomically, so an
  oversized batch doesn't even partially help. Guidance: chunk large
  worklists into batches at or under the measured/documented ceiling (§4),
  not in one unbounded call.
- **Batch size too small**: safely under budget, but reduces to close to
  `register_task`'s per-call overhead again, eroding the reason to batch at
  all. Guidance: batch as close to the measured ceiling as comfortably fits,
  not the smallest number that "feels safe."

## 8. Worked example — a dApp with N pending tasks

Scenario: a lending protocol has identified 40 undercollateralized positions
after a price move and needs a liquidation task registered for each one,
in one submission rather than 40 separate transactions.

**Sizing against the ceiling (§4):** sizing is a single division against the
enforced `MAX_BATCH_SIZE` (currently 50 — read it from `max_batch_size()`
rather than hardcoding, since issue 0104 may revise it). This dApp's 40
positions fit in one batch. If the same dApp instead had 500 positions to
register, it would split into `ceil(500 / 50) = 10` batches of at most 50
entries each, computing a separate `max_total_reward` per batch (the sum of
*that batch's* rewards only — never the sum across batches, since each is an
independent atomic call per §3).

### Raw contract-call context (Rust cross-contract call)

```rust
// In the calling dApp contract. `registry` is the KeeperRegistry contract
// address; `positions` is this contract's own list of undercollateralized
// position ids, already computed off-chain or by a prior on-chain step.
let registry = KeeperRegistryClient::new(&env, &registry_contract_id);

let mut tasks: Vec<BatchTaskParams> = Vec::new(&env);
let mut total_reward: i128 = 0;
for position_id in positions.iter() {
    let reward = liquidation_bounty_for(&env, position_id); // this dApp's own sizing logic
    total_reward = total_reward.checked_add(reward).expect("reward sum overflow");
    tasks.push_back(BatchTaskParams {
        task_type: TaskType::Liquidation,
        calldata: encode_liquidation_calldata(&env, position_id),
        reward,
        deadline: env.ledger().timestamp() + 3600,
        ttl_ledgers: 17_280,
        lock_ledgers: 120,
        condition: None,
    });
}

// max_total_reward is the exact sum just computed above — not padded (§7).
match registry.try_batch_register_tasks(&env.current_contract_address(), &tasks, &total_reward) {
    Ok(Ok(task_ids)) => {
        // task_ids[i] corresponds to positions[i] — zip them to record locally.
    }
    Ok(Err(KeeperError::BatchTooLarge)) => {
        // Split `positions` into smaller chunks (§4/§7) and resubmit each
        // chunk as its own batch call — do not assume any entries landed.
    }
    Ok(Err(_)) | Err(_) => {
        // Any other rejection: zero tasks were registered, zero escrow
        // moved (§3). Fix the flagged entry and resubmit the whole batch.
    }
}
```

### Off-chain context (Node.js)

A runnable owner-side script implementing exactly this flow — reading a task
list from JSON or CSV, validating entries locally, chunking against
`max_batch_size()`, and reporting the returned ids — lives in
[`examples/batch-register/`](../examples/batch-register/README.md). Its README
covers the file format and walks through the `max_total_reward` choice in §7
terms.

### Raw contract-call context (Soroban CLI)

```bash
stellar contract invoke \
  --id "$REGISTRY_CONTRACT_ID" \
  --source owner \
  --network testnet \
  -- \
  batch_register_tasks \
  --owner "$OWNER_ADDRESS" \
  --tasks '[{"task_type":"Liquidation","calldata":"...","reward":"1000000","deadline":"1780000000","ttl_ledgers":17280,"lock_ledgers":120}, ...]' \
  --max_total_reward "40000000"
```

### Handling a rejected batch

Because failure is all-or-nothing (§3), the caller's error-handling only has
two cases to reason about, not "how many of my 40 tasks actually landed":

1. **Validation error on a specific entry** (bad reward, oversized calldata,
   etc.) or **sum exceeds `max_total_reward`**: zero tasks were registered.
   Fix the flagged entry (or recompute the sum) and resubmit the identical
   batch — no cleanup of partially-created state is ever needed.
2. **`BatchTooLarge`** (or an opaque resource-exhaustion failure, which the
   `MAX_BATCH_SIZE` guard in §4 is meant to prevent from ever surfacing this
   way): split the worklist into smaller batches at or under the documented
   ceiling and submit them as separate calls.

---

## 9. Can the N escrow transfers be collapsed into one?

**Study, not a change.** `batch_register_tasks` as shipped does one
`token.transfer` per entry — the same number of cross-contract calls that
calling `register_task` N times would make, just inside one transaction. Each
of those is a call into the reward token contract with its own resource cost.
This section asks whether they can be collapsed into a single transfer of the
total, and concludes with a recommendation.

### 9.1 The accounting question, addressed first

The complication worth reasoning through carefully: a collapsed transfer moves
`sum(rewards)` from the owner to the registry in one call, but each task still
needs its own reward amount recorded and refundable independently later, via
`cancel_task` or `expire_task`. Is that an accounting change?

**No — and this is the central finding.** Per-task escrow is already
*bookkeeping*, not a separate token holding:

- The registry holds **one pooled balance** of the reward token. There is no
  per-task sub-account, no per-task token authorization, nothing on the token
  side that distinguishes "the 1 XLM escrowed for task 41" from "the 1.5 XLM
  escrowed for task 42". The only thing that distinguishes them is the
  `reward` field on each `Task` in persistent storage.
- Refunds already reflect that. `cancel_task` and `expire_task` read
  `task.reward` and transfer that amount out of the pooled balance — they do
  not "return the specific tokens task 41 brought in", because no such notion
  exists.

So a collapsed transfer changes *how much moves per call*, not *what is
recorded*. Each `Task` is still written with its own `reward`, and every later
refund path reads that field exactly as it does today. **No intermediate
accounting step is needed**, and the per-task refund logic requires no change
at all.

**Solvency (I-1) is likewise unaffected.** The invariant is

```text
token_balance == open_escrow + keeper_balances + fees_accrued
```

where `open_escrow` is the sum of `Task.reward` over Pending and Claimed
tasks (`contracts/keeper-registry/src/invariants.rs`, `assert_solvent`). Both
sides of the equation are aggregates. Whether the registry received
`sum(rewards)` as one transfer or as N transfers, `token_balance` increases by
the same amount and `open_escrow` increases by the same amount. I-1 holds
identically either way — it cannot distinguish the two, which is precisely why
the collapse is accounting-neutral.

### 9.2 The complication that *is* real

Collapsing does introduce one genuine new hazard, and it is not the one the
issue anticipated.

Today the sum is used **only** for the `max_total_reward` ceiling check. The
money that actually moves is each entry's own `reward`, transferred inside the
loop. If the sum were computed wrongly — an entry skipped, an overflow
mishandled — the consequence would be a wrong *ceiling check*, and every task
would still be funded correctly.

After collapsing, the sum **is** the money. A sum that disagrees with what the
loop later records as `Task.reward` values produces a direct I-1 violation:
the registry would hold less (or more) than the escrow it claims to owe, with
no error raised anywhere. The two loops — the one that totals and the one that
writes — must provably iterate the same entries with the same values.

This is manageable, not disqualifying, but it is a real cost and any
implementation must carry:

- The total and the per-task writes derived from a single pass, or from two
  passes over the same immutable `Vec` with no possibility of divergence.
- An invariant test asserting I-1 immediately after a batch registration, over
  a batch with heterogeneous rewards — the cheap check that would catch the
  entire class of bug.

Two lesser consequences, both documentable rather than blocking:

- **Observability.** The reward token (a SAC) emits its own `transfer` event
  per call. An off-chain indexer reconciling per-task escrow from *token*
  events would see one lump-sum event instead of N. The registry's own
  `TaskRegistered` events still carry per-task rewards, so anything
  reconciling from the registry's event stream — including
  `examples/keeper-bot` — is unaffected.
- **Wallet review.** The owner's signed auth tree would contain one
  `transfer(owner, registry, total)` sub-invocation instead of N itemized
  ones. A wallet UI showing "transfer 45 XLM" conveys less than N line items.
  `max_total_reward` already exists as the explicit ceiling covering exactly
  this (§2), so the loss is small.

Non-issues, checked: overflow of the sum is already `checked_add`-guarded for
the ceiling; fee-on-transfer or rebasing tokens would break per-task escrow
accounting equally in both designs (`register_task` already records `reward`
rather than a measured received delta), so collapsing introduces no new
exposure there.

### 9.3 Resource-cost comparison — N transfers vs 1

Estimated from `contracts/keeper-registry/resource-baseline.json`, by
differencing entry points that are structurally identical **except** for a
token transfer:

| Pair | With transfer | Without transfer | Implied transfer cost |
|---|---|---|---|
| `cancel_task` vs `claim_task` | 262,257 CPU / 44,499 B | 104,711 CPU / 19,889 B | ~157,500 CPU / ~24,600 B |
| `expire_task` vs `claim_task` | 252,526 CPU / 42,371 B | 104,711 CPU / 19,889 B | ~147,800 CPU / ~22,500 B |
| `sweep_fees` vs `set_fee_bps` | 267,037 CPU / 50,539 B | 99,296 CPU / 20,174 B | ~167,700 CPU / ~30,400 B |

Each pair does the same storage reads/writes, event, and instance TTL bump;
the delta is one cross-contract call into the reward token. **A single token
transfer costs roughly 150k–170k CPU instructions and ~25 KB of memory.** Call
it ~155k CPU.

`register_task` measures 251,855 CPU total, so its non-transfer work — the
validation, the counter increment, the `Task` write, the event, the TTL bump —
is roughly 97k CPU. That gives a per-entry model for a batch:

| Batch size | N transfers (CPU) | 1 transfer (CPU) | Saving |
|---|---|---|---|
| 10 | ~1.55M + ~0.97M = **~2.5M** | ~0.16M + ~0.97M = **~1.1M** | ~55% |
| 25 | ~3.88M + ~2.4M = **~6.3M** | ~0.16M + ~2.4M = **~2.6M** | ~59% |
| 50 (`MAX_BATCH_SIZE`) | ~7.75M + ~4.85M = **~12.6M** | ~0.16M + ~4.85M = **~5.0M** | ~60% |

So the saving is large in relative terms: **the transfers are the majority of
a batch's CPU cost, and collapsing them removes about 60% of it at
`MAX_BATCH_SIZE`.**

### 9.4 …but the saving is in the resource that is not binding

The number that decides whether this matters: Soroban's per-transaction CPU
limit is on the order of 100M instructions. A 50-entry batch is estimated at
~12.6M with N transfers — comfortably inside it, and ~5.0M collapsed. **CPU is
not what caps `MAX_BATCH_SIZE` at 50.**

What caps it is **ledger write bytes** (§4): 50 entries write 50 `Task`
records, each carrying up to 1024 bytes of `calldata`, so ~50 KB of writes
before anything else. A collapsed transfer does not remove a single one of
those writes.

The honest framing, therefore:

- Collapsing is a **fee reduction**, not a capability increase. It makes a
  batch cheaper; it does not let a batch be larger.
- ~60% off the CPU term is still real money for a dApp registering batches
  routinely, and CPU instructions are a priced resource in Soroban's fee model.
- But it will not raise `MAX_BATCH_SIZE`, and anyone hoping it would should
  read §4 instead.

### 9.5 Recommendation

**Implement it**, with the safeguards in §9.2 — but sequence it after issue
0104's measurement, and treat that measurement as the gate.

Reasoning:

1. The accounting objection does not survive contact with the code (§9.1).
   Escrow is already pooled and per-task refunds already read `Task.reward`;
   there is nothing to restructure. The change is essentially: hoist the
   `token.transfer` out of the registration loop, transferring `total_reward`
   — a value already computed for the ceiling check — once before it.
2. The complexity is genuinely small, and the one real hazard it introduces
   (§9.2) is closed by an invariant test that should exist regardless.
3. The saving is substantial in relative terms (~60% of batch CPU) even though
   it does not relieve the binding constraint.

Why gate on 0104 rather than doing it now: every number in §9.3 is *derived by
differencing a baseline that does not yet contain `batch_register_tasks`*. The
transfer cost estimate is sound — three independent pairs agree within ~13% —
but the per-entry non-transfer cost inside a batch is extrapolated from
`register_task`, and a batch amortizes some of that (one auth, one instance
TTL bump, one ceiling check for the whole call) in ways this model does not
capture. Once 0104 measures `batch_register_tasks` at several N, the saving
becomes an observed number rather than an estimated one, and the change lands
with a before/after to point at.

Filed as its own implementation issue:
[`.github/backlog/issues/0202-batch-register-collapse-escrow-transfers.md`](../.github/backlog/issues/0202-batch-register-collapse-escrow-transfers.md).

---

## 10. Feasibility — batch cancel for an owner's own pending tasks

**Study, not a change.** Issue 0099 examined batch claim and batch execute and
found both risky: they are permissionless, contested between competing keepers,
and an all-or-nothing batch turns one lost race into N lost claims.
`cancel_task` has none of that risk profile. It is single-owner,
single-auth, and only ever touches tasks the caller already owns — Pending
ones, or Claimed ones whose lock window has lapsed. So the atomicity objections
from 0099 mostly do not apply, and the question becomes whether
`batch_cancel_tasks` is worth building on its own merits.

### 10.1 Is there real demand?

The motivating case is a dApp winding down: a lending protocol that registered
40 liquidation-watch tasks after a market move, then saw the price recover and
wants its escrow back rather than leaving 40 bounties outstanding. Today that
is 40 transactions, 40 signatures, 40 fees.

But unlike registration, cancellation has a **free alternative**:
`expire_task` is permissionless and refunds the owner. An owner who simply
waits for the deadline gets every task's escrow back without signing or paying
for anything — a keeper bot scanning for work will typically expire stale tasks
as a courtesy (`examples/keeper-bot` does exactly this). Batch registration has
no such fallback: tasks do not register themselves.

So the demand is narrower than for registration, and it reduces to one thing:
**how much the owner values getting its capital back now rather than at the
deadline.** For a protocol with 40 × 1 XLM outstanding and a 1-hour deadline,
the answer is "not much". For one running long-dated tasks (`ttl_ledgers` and
deadlines measured in days) with meaningful sums escrowed, waiting out the
deadline is a real balance-sheet cost, and the alternative is paying N
transaction fees to unwind. That case is real but not universal.

Secondary, and worth naming because it is not about capital: an owner
correcting a mistake — 40 tasks registered with wrong calldata — wants them
gone *now*, before a keeper executes against the bad payload and earns the
bounty. Deadline-waiting does not help there, because the failure mode is
execution, not expiry.

### 10.2 Is the implementation as simple as it looks?

The naive shape is "loop the existing single-task validation and refund logic,
all under one owner auth", and structurally that is right. The per-task work
is unchanged: check owner, check status (Pending, or Claimed with an elapsed
lock), mark Cancelled, save, refund.

**But the reentrancy question is not answerable by "cancel_task is simple",
and batching does change the analysis.** Working through it properly:

`cancel_task` today is CEI-ordered: it writes `status = Cancelled` and saves
*before* calling `token.transfer`. A re-entrant `cancel_task` for the same id
finds the task already Cancelled and is rejected by the status guard. That is
the property the comment in `contracts/keeper-registry/src/lib.rs` claims, and
it holds.

Now batch it. A loop of `{validate, mark, save, transfer}` performs **N
transfers, and therefore opens N re-entry windows in one transaction**, where
`cancel_task` opens one. Each window is entered mid-batch, with tasks `1..i`
already Cancelled-and-refunded and tasks `i+1..N` still Pending. Three things
to check:

1. **Can a re-entrant call double-refund a task the outer loop already
   handled?** No. Those tasks are already `Cancelled` in storage — the write
   happened before the transfer that opened the window. The status guard
   rejects them. This is exactly the single-task guarantee, and batching does
   not weaken it.

2. **Can a re-entrant call cancel a task the outer loop has not reached yet,
   and cause a double refund when the loop gets there?** This is the one that
   matters, and **the answer depends on an implementation detail that the
   naive shape gets wrong.**

   If the batch loads all N tasks up front — the natural "gather, validate,
   then refund" structure, and the one that makes the up-front validation
   sweep in `batch_register_tasks` (§6) look like the pattern to copy — then
   the loop is working from a **stale snapshot**. A re-entrant cancel of task
   `j > i` would mark `j` Cancelled and refund it; the outer loop would later
   reach its cached copy of `j`, still showing `Pending`, mark it Cancelled
   again, and refund it a **second time**. The status guard never fires,
   because it was evaluated against the snapshot. That is a straightforward
   double-spend out of pooled escrow, and it breaks I-1.

   If instead each iteration loads the task fresh from storage immediately
   before validating it, the re-entrant cancel is visible: the outer loop's
   load returns `Cancelled`, the status guard rejects, and the whole batch
   reverts atomically. Safe.

   So: **`batch_cancel_tasks` must load each task inside the loop, not
   pre-load a snapshot.** This is the opposite of what `batch_register_tasks`
   does, and for a good reason — registration validates *inputs*, which cannot
   change under it, while cancellation validates *stored state*, which can.
   Anyone copying the registration structure onto cancellation would introduce
   this bug, which is precisely why the question was worth asking rather than
   waving through.

3. **Does anything about the CEI discussion in issues 0002/0057 change?** The
   ordering rule itself does not: effects before interaction, per task. What
   changes is that the batch now interleaves *another task's* effects after
   an interaction, so "CEI holds for this function" has to be read as "CEI
   holds for each iteration, and no iteration's interaction can invalidate a
   later iteration's checks" — which is point 2, and which the fresh-load
   requirement is what actually secures.

Note that a re-entrant `cancel_task` also needs its own owner authorization to
succeed at all: Soroban's auth framework scopes auth to a specific invocation,
so a nested call from the token contract is not covered by the outer batch's
auth entry. That makes the attack require either a contract account with a
permissive `__check_auth`, or an owner who signed for it. **This is a mitigating
factor, not the guarantee** — the fresh-load requirement should stand on its own
rather than resting on an auth argument about a malicious reward token, since
the reward token is admin-configured and a compromised or malicious one is
exactly the threat model CEI exists for.

### 10.3 The refunds should be collapsed, and here it is strictly safer

§9 recommended collapsing `batch_register_tasks`' N inbound transfers into one.
For cancellation the same move is available and the security argument is
*stronger*, not merely neutral:

- Mark all N tasks Cancelled and save them, accumulating the total refund.
- Then perform **one** transfer of `sum(refunds)` to the owner.

That reduces the re-entry windows from N to exactly one, and places that single
window *after every effect in the call* — textbook checks-effects-interactions,
and a better posture than `cancel_task` × N achieves today across N separate
transactions. It also sidesteps point 2 entirely: with all writes committed
before any transfer, there is no "task the loop has not reached yet".

The §9.2 hazard transfers across too: the summed refund becomes the money, so
the total must be accumulated from the same `task.reward` values that were
written, and an I-1 assertion after a batch cancel is the test that catches the
whole class of bug.

### 10.4 Recommendation

**Build it** — but rank it below the outstanding measurement work (issue 0104)
and the §9 transfer collapse (issue 0202), and only with the constraints below,
which are what make it safe rather than merely simple.

Reasoning:

- The risk profile genuinely differs from 0099's batch claim/execute. There is
  no cross-keeper race to lose: the caller owns every task, holds sole
  authority over it, and no competing party can invalidate an entry between
  simulation and submission. All-or-nothing atomicity, which was the fatal
  flaw for batch claim, is here just the same semantics `cancel_task` already
  has.
- The demand is real but narrower than for registration (§10.1), because
  `expire_task` gives owners a free unwind path that registration has no
  analogue for. That is the reason to rank it below 0104/0202, not a reason to
  decline it.
- The reentrancy analysis (§10.2) turns up a concrete, non-obvious bug that a
  reasonable implementer would write, which is an argument for building it
  *deliberately with that constraint documented* rather than leaving it to be
  filed later by someone who did not do this analysis.

Filed as its own implementation issue:
[`.github/backlog/issues/0203-batch-cancel-tasks.md`](../.github/backlog/issues/0203-batch-cancel-tasks.md).
