# Changelog

All notable changes to the Soroban Keeper Network are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — bounded batch task reads (#25)

- New read-only views `get_tasks(ids)` and `get_tasks_range(from, count)` let
  an indexer or keeper bot inspect many tasks in one call instead of one RPC
  round trip per task. Both are bounded by `MAX_BATCH_READ` (50) and return
  the new `BatchTooLarge` error when exceeded, rather than silently truncating
  a page — a clipped result is indistinguishable from the end of a range.
- The result is positionally aligned with the request: entry `i` is
  `Some(task)` if the id at position `i` exists and `None` if it does not, so
  one missing id does not fail the whole call. `Vec<Option<Task>>` is used
  rather than a compacted `Vec<Task>` because `Task` carries no `task_id`,
  which would make the mapping from result back to requested id unrecoverable.
- No storage iteration is introduced: every read is still O(1) by key against
  `DataKey::Task(id)`, and the caller supplies the bounded key set.
- `get_tasks_range` rejects a window whose last id would exceed `u64::MAX` with
  `ArithmeticOverflow` rather than wrapping around to low-numbered tasks. A
  window ending exactly on `u64::MAX` is still accepted.
- `Task` now derives `PartialEq`/`Eq`, matching `TaskType` and `TaskStatus`, so
  batched results can be compared. Additive only — no XDR or behaviour change.
- `VERSION` is deliberately unchanged: these are purely additive read-only
  views and no existing function's behaviour is affected.

### Documented — protocol fee rounding guarantee (#26)

- `split_reward`'s rounding direction is now a stated guarantee rather than an
  undocumented artifact of integer division: the fee is
  `floor(reward * fee_bps / 10_000)` and the keeper receives the remainder, so
  the protocol can never collect more than the nominal rate and the error is
  bounded by one stroop per execution, always in the keeper's favour.
- The `min_reward` / `fee_bps` dust threshold is documented in the README
  tokenomics section: the fee is non-zero only once
  `min_reward >= ceil(10_000 / fee_bps)`. Below that the protocol earns
  nothing on a task while still bearing its storage cost — a relationship
  between two parameters that were previously set independently.
- Boundary tests pin the behaviour at `reward = 1`, the first reward yielding a
  non-zero fee, `fee_bps = 0`, and `fee_bps = 10_000`. No behaviour change.

### Added — batch task registration (VERSION bumped to 3)

Epic E05's batch-registration slice. Full design rationale and integrator
guidance: [docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md).

- **`batch_register_tasks(owner, tasks, max_total_reward) -> Vec<u64>`** —
  registers many tasks in one transaction under a **single** owner auth,
  amortizing the per-call overhead (auth, instance TTL bump) `register_task`
  otherwise pays once per task across N separate transactions. Task ids are
  returned in the same order as the input entries, so a caller can zip its own
  worklist against the result.
- **`BatchTaskParams`** — one batch entry: the same fields `register_task`
  takes, minus `owner` (shared across the batch).
- **`max_total_reward` ceiling** — an explicit, human-readable cap on the total
  escrow a batch may pull from the owner, checked against the sum of the
  batch's rewards *before* any transfer occurs. Set it to the exact sum of the
  batch you are submitting; padding it only widens the window in which the call
  could move more escrow than was reviewed
  ([docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md) §7).
- **No partial success** — if any entry fails validation, or the batch exceeds
  either ceiling, the entire call is rejected: zero tasks registered, zero
  escrow moved. Integrators never have to reconcile "how many of my N tasks
  actually landed" (§3).
- **`MAX_BATCH_SIZE` = 50, and a `max_batch_size()` view** — a batch larger
  than this is rejected with a typed `BatchTooLarge` error rather than failing
  as opaque host-level resource exhaustion.

  ⚠️ **Practical limit for integrators.** 50 is a **conservative guard, not an
  empirically measured ceiling** — measuring the real limit against Soroban's
  per-transaction CPU and ledger-write budgets is still open as backlog issue
  0104, and this constant should be revised once that lands. Two things follow
  for anyone integrating today: (1) read the cap from the contract via
  `max_batch_size()` rather than hardcoding 50, so a later revision does not
  silently break your chunking; and (2) **entry count is only half the story** —
  each entry writes a `Task` whose `calldata` may be up to `MAX_CALLDATA_LEN`
  (1024) bytes, so 50 maximum-sized entries is already ~50 KB of ledger writes
  before the per-entry token transfer and event are counted. A batch that
  combines large payloads *and* many entries can exhaust the transaction budget
  below the 50-entry cap; size against your own payloads, not just the count.
- **New error variants** (these are the ABI change `VERSION` exists to signal):
  - `BatchTooLarge` (21) — more than `MAX_BATCH_SIZE` entries.
  - `EmptyBatch` (22) — empty `tasks` vector; rejected rather than treated as a
    silent no-op, so a caller whose off-chain filter produced nothing finds out
    instead of paying for a transaction that registered nothing.
  - `BatchRewardCeilingExceeded` (23) — the batch's reward sum exceeded
    `max_total_reward`.
- A new public entry point plus three new error variants change the contract's
  ABI — `VERSION` bumped from 2 to 3.
- **Unchanged by design:** batch-registered tasks are ordinary tasks. Each
  entry's escrow is transferred and recorded per task, so `cancel_task` and
  `expire_task` refund each one independently of the rest of its batch; nothing
  about how a task was created affects claim, execution, or refund.
- Per-entry validation is shared with `register_task` through one internal
  helper, so a batch can never accept a task shape a single registration would
  reject.

### Added — escrow-transfer batching study

- [docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md) §9: can
  `batch_register_tasks`' N escrow transfers be collapsed into one? Finds that
  per-task escrow is already bookkeeping over a pooled balance, so the collapse
  is accounting-neutral — per-task refunds and the I-1 solvency invariant are
  untouched. Estimates a single token transfer at ~155k CPU instructions (by
  differencing structurally identical entry points in the resource baseline),
  making the transfers ~60% of a 50-entry batch's CPU cost. Recommends
  implementing, gated on issue 0104's measurement, and flags the one real
  hazard it introduces: the sum becomes the money, so a totalling bug becomes
  a silent solvency violation rather than a wrong ceiling check. Filed as
  backlog issue 0202.

### Added — batch cancel feasibility study

- [docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md) §10: is a
  `batch_cancel_tasks` worth building, given that issue 0099's cross-keeper
  race objections do not apply to a single-owner, single-auth operation?
  Recommends building it, ranked below issues 0104 and 0202, and filed as
  backlog issue 0203. The reentrancy question is answered rather than assumed
  away: batching turns one re-entry window into N, and a "gather, then refund"
  structure copied from `batch_register_tasks` is a **double-spend** — a
  re-entrant cancel of a not-yet-reached task refunds it, and the outer loop
  then refunds its stale cached copy again. Each task must be loaded fresh
  inside the loop; collapsing the refunds into one transfer after all effects
  removes the window class entirely.

### Fixed — restore work silently reverted by an unrelated merge

- `split_reward`'s return type (`Result<(i128, i128), KeeperError>`) and its
  three call sites, a missing closing brace in
  `contracts/keeper-registry/src/test.rs`, and `docs/CI.md` had all been
  silently reverted/deleted by an unrelated commit (`fee3b2d`, ostensibly a
  keeper-bot lint fix), leaving `keeper-registry` unable to compile at all.
  Restored to the state an earlier fix (`038f6c7`) had already established.

### Added — batch claim/execute feasibility study

- [docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md): naive all-or-nothing
  batch claiming is strictly worse than independent claims under Soroban's
  transaction atomicity; recommends `claim_first_available` instead
  (backlog issue 0101, already scoped) and defers batch execute pending
  epic E04 (backlog issue 0201, filed alongside this study).

### Added — advisory CI: fuzz jobs, resource cost report

- `fuzz-pr` (`ci.yml`): runs every registered `cargo-fuzz` target for 60s on
  PRs touching `contracts/keeper-registry/` or `fuzz/`.
- `fuzz-nightly` (`.github/workflows/fuzz-nightly.yml`): the same targets
  for 15 minutes each, on a daily schedule, with a persistent cached corpus.
- `resource-cost` (`ci.yml`): reports CPU instructions and memory bytes per
  state-changing entry point via `soroban-sdk`'s budget testutils, diffed
  against a checked-in baseline.
- Both documented in [docs/CI.md](docs/CI.md) (restored — see Fixed above).

### Added — partial verifier resource cost catalog

- [docs/VERIFIERS.md](docs/VERIFIERS.md): baseline (no-verifier) measurement
  methodology in place; per-verifier deltas blocked pending epic E04's
  reference verifiers, which do not exist in this repo yet.

### Fixed — task parameter validation

- `register_task` now rejects `lock_ledgers` outside `[MIN_LOCK_LEDGERS,
  MAX_LOCK_LEDGERS]` and `ttl_ledgers` below `MIN_TTL_LEDGERS`, returning the
  new `InvalidTaskParams` error. Previously a `lock_ledgers` of `0` let any
  keeper instantly re-claim a task from another keeper, an oversized
  `lock_ledgers` let one unresponsive keeper hold a task hostage until the
  deadline, and a `ttl_ledgers` of `0` risked stranding escrowed funds.

### Added — calldata size bound (VERSION bumped to 2)

- `register_task` now rejects `calldata` larger than `MAX_CALLDATA_LEN`
  (1024 bytes) with a new `CalldataTooLarge` error. Previously `calldata` was
  unbounded, so a task owner could register a payload that every later
  lifecycle call (`claim_task`, `execute_task`, the permissionless
  `expire_task`) would have to re-read and re-write in full, pushing the
  storage and re-serialisation cost onto keepers and passers-by rather than
  the owner who chose the payload size.
- Empty `calldata` is intentionally still accepted; documented in the README.
- Adding `CalldataTooLarge` changes the contract's error ABI — `VERSION`
  bumped from 1 to 2.

### Added — live testnet deployment

- Deployed `KeeperRegistry` to Stellar testnet
  (`CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4`) and ran a full
  register → claim → execute → withdraw cycle on-chain.
- Added [docs/DEMO.md](docs/DEMO.md) (transaction-by-transaction trace) and
  [DEPLOYMENTS.md](docs/DEPLOYMENTS.md) (canonical address record); surfaced the live
  deployment in the README.

### Added — contract capabilities & views

- `increase_reward` — owners can top up a task bounty (Pending/Claimed).
- `extend_deadline` — owners can push out a task's deadline.
- `set_min_reward` + `min_reward` view — admin-set anti-dust floor for new tasks.
- `is_claimable` view — cheap keeper-side eligibility check.
- `version` view + `VERSION` constant for ABI detection.
- Governance events on pause/unpause, fee change, and admin transfer, plus
  `topup`/`extend` task events.

### Added — tests

- `split_reward` accounting-invariant sweep (conservation, bounds, formula).
- Multi-keeper end-to-end conservation test across execute/expire/cancel.
- Test count grown from 38 to 52.

### Added — contributor infrastructure

- CONTRIBUTING-facing repo setup: `.editorconfig`, `rustfmt.toml`, `.gitignore`,
  Code of Conduct, issue templates (bug / feature / good-first-issue) + chooser,
  PR template, `CODEOWNERS`, a Wave-Program label taxonomy, and a `Makefile`.
- `docs/ARCHITECTURE.md` and `docs/DEPLOYING.md`; README documentation index.
- `scripts/optimize.sh` build/optimize helper.

### Changed

- CI: concurrency control (cancels superseded runs) and `--locked` builds.
- Repository references updated to the `soroban-tooling` org.

### Fixed

- Cleared all compiler and `clippy -D warnings` findings and applied `rustfmt`
  so the CI lint/format gates pass. Removed the ignored child-manifest
  `[profile.release]`.

### Added — MVP contract feature-complete

The `KeeperRegistry` contract's core lifecycle is now fully implemented and
tested (38 unit tests, full happy-path and error-path coverage):

- **`claim_task`** — permissionless first-come-first-served claiming, with
  re-claim allowed only after the prior claimer's lock window elapses.
- **`execute_task`** — execution-proof submission, reward split between keeper
  and protocol fee, and CEI-safe keeper crediting.
- **`cancel_task`** — owner reclaims escrow of a still-Pending task.
- **`expire_task`** — permissionless deadline enforcement; anyone can refund a
  stuck task's escrow to its owner after the deadline.
- **`withdraw_rewards`** — keeper pulls its accrued balance (balance zeroed
  before transfer to prevent re-entrant double-spend).
- **`sweep_fees`** + `FeesAccrued` accumulator — admin moves accrued protocol
  fees to a treasury; can never touch task escrow or keeper balances.
- **Admin controls** — `pause`/`unpause` (funds-recovery paths stay open during
  a pause), `set_fee_bps` (bounded, future-effective), `transfer_admin` (dual
  auth to prevent lock-out), and `upgrade`.
- **Views** — `fees_accrued`, alongside the existing task/keeper/state views.

### Added — keeper-bot

- Retry with exponential back-off + jitter on transient RPC errors, skipping
  retries on permanent contract errors.
- Graceful shutdown (SIGINT/SIGTERM) that drains the in-flight round so a task
  is never left claimed-but-unexecuted.
- Optional permissionless expiry of past-deadline tasks to refund owners.

### Fixed

- Pinned `ed25519-dalek` to 2.2.0 and committed `Cargo.lock` so the test build
  is reproducible (`soroban-env-host` was resolving an incompatible 3.0.0).
