# Architecture

This document describes how the Soroban Keeper Network fits together and the
invariants the `keeper-registry` contract enforces.

## Components

### Keeper registry contract

The registry owns the task lifecycle and stores:

- the administrator and pause state;
- the configured reward token;
- the next task id;
- fee configuration and the accrued-fee accumulator;
- task records; and
- credited keeper balances.

Every state transition publishes an event, and events are the query primitive
for off-chain indexers and keeper bots. This document deliberately does not
restate the topic and data shapes: the single canonical table lives in the
[README events section](../README.md#events) and is transcribed from the `emit_*`
functions in `contracts/keeper-registry/src/lib.rs`. Keep it there rather than
duplicating it here, so the two cannot drift apart.

### Reward token

The registry transfers the configured token when a task is registered, topped up, cancelled, expired, executed, or when a keeper withdraws rewards. The registry is therefore written against a token contract boundary and must preserve its safety properties even when token transfers are treated as external interactions.

### Owners and keepers

An owner creates and funds a task. A keeper may claim an eligible task, execute it with the required proof or calldata, and receive the net reward as a credited balance. A keeper withdraws that balance independently of the task lifecycle.

| Component | Location | Role |
|-----------|----------|------|
| `KeeperRegistry` contract | `contracts/keeper-registry` | On-chain coordination: task registry, escrow, fee accounting, admin controls |
| Keeper bot (example) | `examples/keeper-bot` | Off-chain worker that claims, executes, and settles tasks |
| Deploy / optimize scripts | `scripts/` | Build, optimize, and deploy the contract |

## Task lifecycle

```
                 register_task              claim_task            execute_task (verifier pass)
   dApp/owner ───────────────▶  PENDING ───────────────▶ CLAIMED ───────────────────────────▶ EXECUTED
                                   │                         │ ▲
                       cancel_task │                         │ │ execute_task (verifier reject, retryable)
                                   ▼              expire_task │ │ (returns to CLAIMED for retry)
                               CANCELLED       (deadline      │ │
                                               passes)        ▼ │
                                                           EXPIRED│
                                                                  └──────────────────────────┘
```

- **PENDING** — funded and waiting. Owner may `cancel_task` (refund),
  `increase_reward` (top up), or `extend_deadline`.
- **CLAIMED** — a keeper holds an exclusive lock for `lock_ledgers`. After the
  window elapses, any keeper may re-claim (prevents squatting). When a task
  includes a verifier callback and the verifier rejects the execution, the
  task may return to CLAIMED state for retry (retryable failure), distinct
  from terminal failure states.
- **EXECUTED** — the keeper submitted proof; its net reward is credited to an
  internal balance and later withdrawn.
- **CANCELLED / EXPIRED** — terminal refund states.

## Storage layout

| Scope | Key | Value |
|-------|-----|-------|
| Instance | `Admin`, `FeeBps`, `Paused`, `TaskCounter`, `RewardToken`, `FeesAccrued`, `MinReward` | Global config + counters |
| Persistent | `Task(id)` | Full `Task` record |
| Persistent | `KeeperReward(addr)` | A keeper's withdrawable balance |

## TTL / archival strategy

Soroban archives a storage entry once its TTL reaches zero; an archived entry
is inaccessible (every entry point that reads it fails) until explicitly
restored. The registry renews TTL per storage class as follows:

| Scope | Key | Renewed on | Amount |
|-------|-----|------------|--------|
| Instance | `Admin`, `FeeBps`, `Paused`, `TaskCounter`, `RewardToken`, `FeesAccrued`, `MinReward` | Every state-mutating entry point (`register_task`, `claim_task`, `execute_task`, `cancel_task`, `expire_task`, `withdraw_rewards`, admin functions, …) | `extend_ttl(INSTANCE_BUMP_THRESHOLD = 50_000, INSTANCE_BUMP_LEDGERS = 100_000)` |
| Persistent | `Task(id)` | Every write via `save_task` (register, top-up, extend deadline, claim, execute, cancel, expire) | `extend_ttl(task.ttl_ledgers, task.ttl_ledgers)`, caller-supplied per task |
| Persistent | `KeeperReward(addr)` | Credited in `execute_task` / zeroed in `withdraw_rewards` | `extend_ttl(KEEPER_BALANCE_BUMP_THRESHOLD = 50_000, KEEPER_BALANCE_BUMP_LEDGERS = 100_000)` |

All instance-storage keys are read by nearly every entry point, so instance
TTL is the highest-stakes case: previously it was only extended once, inside
`initialize`, meaning a contract that saw no traffic for ~6 days (100,000
ledgers at ~5s/ledger) could have its instance archived and become
unusable until someone submitted a `RestoreFootprint` operation. Every
state-mutating function now calls `bump_instance`, which uses a threshold
below the bump amount so the extension is a no-op on most calls and only
costs resources once the entry is genuinely close to expiry.

**Read-only views deliberately do not bump TTL.** Views (`get_task`,
`task_count`, `keeper_balance`, `fees_accrued`, `is_paused`, etc.) are
simulated by clients for free; giving them a storage-write side effect would
mean a "free" call sometimes silently costs real resources, and the effect
only actually lands when the call is submitted as a real transaction rather
than simulated — an unreliable way to keep the contract alive. Liveness is
kept up by write traffic only. A registry that is completely idle (no
registrations, claims, executions, or admin calls) for the full TTL window
can still archive; that's an accepted tradeoff, and any actual write
immediately restores headroom via `bump_instance`.

**`KeeperReward(addr)` is a known asymmetric case.** It is only renewed when
the balance is written (credited on execution, zeroed on withdrawal). A
keeper that executes exactly one task and never calls the contract again has
a balance entry whose TTL is never touched afterward — like any other
persistent entry, it can be archived if left untouched long enough. The
entry's value is not lost, just inaccessible until restored via
`RestoreFootprint`; `keeper_balance` does not renew on read, for the same
side-effect-free-views reasoning as instance storage above.

## Money invariants

The contract holds exactly the funds it owes. At any time:

```
contract_token_balance == Σ(escrow of PENDING/CLAIMED tasks)
                        + Σ(KeeperReward balances)
                        + FeesAccrued
```

That top-level statement is decomposed into seven named invariants,
`I-1` through `I-7`. Each is referenced by this identifier elsewhere in the
repo (property tests, the shared invariant-checker module, fuzz targets) so
a single name always means the same check.

- **I-1 — Solvency.** The registry's token balance always equals open task
  escrow plus credited keeper balances plus accrued fees (the equation
  above, taken as a whole).
- **I-2 — Escrow recoverability.** Every escrowed reward has at least one
  reachable path back out: to the owner via `cancel_task` or `expire_task`,
  or to a keeper via `execute_task` then `withdraw_rewards`. No state
  strands funds permanently.
- **I-3 — Single payout.** Each task's reward is paid out exactly once —
  never zero times, never twice. (Wave 1 fixed two concrete CEI-ordering
  violations of this, issues 0002/0003.)
- **I-4 — Fee bounding.** The protocol never takes more than `fee_bps` of a
  reward, and the admin can never sweep more than has accrued. The fee is
  floored by integer division, so the protocol may take marginally *less*
  than the nominal rate — never more.
- **I-5 — Escrow isolation.** Admin functions can never touch task escrow
  or credited keeper balances. `sweep_fees` is bounded by the
  `FeesAccrued` accumulator specifically to enforce this.
- **I-6 — Withdrawal liveness.** A keeper's credited balance is always
  withdrawable, including while the contract is paused — this is the
  promise that makes pausing acceptable to keepers.
- **I-7 — Monotonic task ids.** Task ids are unique and never reused, so an
  external reference to a task id (an off-chain indexer, a keeper bot's
  local state, a dApp's UI) is stable forever. `next_task_id` increments a
  `u64` counter and never decrements it.
- **I-8 — Verifier trust boundary.** A task's attached verifier (if any) can
  only return a boolean (or fail) from `execute_task`'s perspective; by
  construction, it has no capability to transfer tokens, credit keeper
  balances, or mutate any `Task` field. When a verifier is present, the
  call is invoked via `Env::try_invoke_contract` with immutable parameters
  (`task_id`, `keeper`, `proof`) **before any state mutation** occurs
  (`credit_keeper`, `accrue_fee`, task status update); the verifier's
  return value only gates an if-branch that permits the remainder of
  execution to proceed. If the verifier returns `false` or panics, the
  execution fails with no state changes; if it returns `true`, execution
  proceeds normally with crediting. (Per issue 0074.)

Enforced by:

- **Escrow on register / top-up**, released exactly once on execute (split into
  keeper credit + accrued fee), cancel, or expire. (I-1, I-2, I-3)
- **Checks-Effects-Interactions** in `withdraw_rewards` and `sweep_fees`: the
  stored balance is zeroed *before* the token transfer, so a re-entrant reward
  token cannot double-spend. (I-3, I-6)
- **`sweep_fees` bounded by `FeesAccrued`**, so admin can never touch task
  escrow or keeper balances. (I-4, I-5)
- **`next_task_id`** is a monotonically incrementing `u64` counter with no
  decrement or reset path. (I-7)
- **Verifier call precedes state mutation** in `execute_task`: the verifier
  is invoked via `try_invoke_contract` with immutable proof before any
  crediting or status update. The call's return value only gates an
  if-branch; a failing or panicking verifier prevents state changes but does
  not revert the whole transaction. (I-8)

### Staking invariants (E06)

Staking (`contracts/keeper-registry/src/staking.rs`, `docs/STAKING_DESIGN.md`)
introduces three new money invariants, numbered I-9 through I-11 continuing
the sequence above. These follow the original four-part shape (Statement,
Why, Enforced by, Breaks if) issue 0050 established, kept as their own
subsection here rather than folded into the bullet list above so the
existing I-1 through I-8 references elsewhere in the repo (property tests,
`invariants.rs`, fuzz targets) are not renumbered.

#### I-9: Staked funds are never spendable as task escrow or keeper reward

**Statement.** A keeper's bonded stake (`DataKey::KeeperStake`) is never
read, credited, or debited by any task-lifecycle function (`register_task`,
`claim_task`, `execute_task`, `cancel_task`, `expire_task`,
`withdraw_rewards`), and a task's escrow or a keeper's reward balance is
never read, credited, or debited by any staking function (`stake_deposit`,
`initiate_unbond`, `withdraw_stake`, `slash`).

**Why.** Stake exists as collateral an admin can slash for misbehavior. If
it were reachable from task-reward accounting, a bug in one path could
silently drain or inflate the other, exactly the failure mode
`FeesAccrued`'s existing separation from task escrow was designed to
prevent (see I-1's decomposition above). Conflating the two would also make
I-1 solvency itself unprovable, since the equation would have no way to
attribute a given token movement to the right bucket.

**Enforced by.** `DataKey::KeeperStake(Address)` is a storage key entirely
distinct from `DataKey::KeeperReward(Address)` and `DataKey::Task(u64)`;
`internal.rs`'s `read_keeper_stake`/`write_keeper_stake` are called only
from `staking.rs`, and `credit_keeper` (the reward-side equivalent) is
called only from `task.rs`. No function in the codebase reads one key
family and writes the other.

**Breaks if.** A future entry point reuses `KeeperReward`'s storage key (or
vice versa) as a shortcut; a refactor merges `credit_keeper` and
`write_keeper_stake` into one generic "credit an address" helper without
also merging the concepts they represent; `slash` is extended to also debit
`KeeperReward` without a corresponding, separately-reviewed design decision.

#### I-10: A slash never exceeds a keeper's current stake

**Statement.** For any successful `slash` call, `amount <= keeper_stake`
strictly at the moment the call executes, and the keeper's stake afterward
is `keeper_stake - amount >= 0`. The stored stake value can never go
negative.

**Why.** A slash beyond a keeper's actual collateral would make the
contract insolvent (I-1) by transferring tokens out of the contract that
were never actually held on that keeper's behalf, effectively paying the
treasury from other keepers' or task owners' funds.

**Enforced by.** `slash`'s explicit `if amount > current_stake { return
Err(SlashExceedsStake) }` check, evaluated *before* any state write and
*before* the token transfer, rejecting the whole call outright rather than
clamping the amount down (`docs/STAKING_DESIGN.md`'s "Slash bounds
decision").

**Breaks if.** The bounds check is removed or reordered after the state
write; `SlashExceedsStake` is changed from a hard rejection to a silent
clamp, which would still keep the stored stake non-negative but would
misrepresent to the caller how much was actually slashed; a future
multi-slash batch entry point sums several slash amounts without
re-checking the running total against the keeper's stake after each one.

#### I-11: Unbonding funds are not double-counted as both staked and withdrawable

**Statement.** At any time, a keeper's total claim on the contract's held
tokens is exactly `KeeperStake` (which already includes any amount
currently mid-unbond) plus `KeeperReward`, counted once each, never twice.
An amount that is mid-unbond is never simultaneously reflected in some
separate "withdrawable" accumulator while also still counted in
`KeeperStake`.

**Why.** `initiate_unbond` deliberately does not move any tokens or reduce
`KeeperStake` (`docs/STAKING_DESIGN.md` §3) — it only starts a delay. If a
second, separate balance were incremented at that point to represent "ready
to withdraw soon," the same funds would be counted in two places
simultaneously, breaking I-1 solvency the moment `token.balance(registry)`
is compared against the sum of all tracked buckets.

**Enforced by.** There is no separate "pending withdrawal" balance key at
all. `DataKey::UnbondRequest(Address)` stores only `(amount,
release_ledger)` as a request record, not a second pool of funds;
`KeeperStake` is reduced exactly once, by `withdraw_stake`, at the moment
tokens actually leave the contract, not at `initiate_unbond` time.

**Breaks if.** A future change adds a "pending withdrawal" accumulator
alongside `KeeperStake` for UI-convenience reasons; `initiate_unbond` is
changed to decrement `KeeperStake` immediately instead of only recording
the request; `withdraw_stake`'s own defensive `amount.min(current_stake)`
clamp (needed because a slash can reduce stake below a pending unbond's
requested amount) is removed, which would let a stale unbond request
release more than the keeper's current stake actually allows.

`property_i1_solvency_holds_across_staking_operations`
(`contracts/keeper-registry/src/test/property.rs`) extends the existing I-1
property-test coverage across randomized sequences of `stake_deposit`,
`initiate_unbond`, `withdraw_stake`, and `slash`, using the same
`assert_solvent` helper (now summing `keeper_stake` per known keeper,
`contracts/keeper-registry/src/invariants.rs`) the pre-staking I-1 property
tests already share. I-9 through I-11 are otherwise enforced structurally
(distinct storage keys, ordering of checks) rather than by a dedicated
`assert_*` function each, since each is a property of the storage layout
and check ordering itself rather than a numeric relationship a snapshot
comparison can directly assert.

The `test_multi_keeper_end_to_end_conserves_funds` and
`test_split_reward_invariants` tests guard these invariants with fixed
scenarios. `contracts/keeper-registry/src/invariants.rs` exposes one
`assert_*` function per `I-N` invariant, shared between the `proptest`-based
property tests in `test.rs` and the fuzz targets under `fuzz/fuzz_targets/`,
so both call the same assertion logic instead of maintaining parallel
copies that can drift apart.

## Events

Every state transition emits an event so off-chain keepers and indexers can
react without polling storage: `reg`, `claim`, `exec`, `exp`, `cancel`,
`topup`, `extend` (task topics) and `paused`, `fee`, `admin`, `wdraw`
(governance / settlement topics).

## Trust model
- **Keepers are permissionless** — anyone can claim and execute; correctness is
  enforced by the contract, not a whitelist.
- **Admin** controls fee rate, pause, min-reward, upgrade, and fee sweeping —
  but can never seize task escrow or keeper earnings.
- **Owners** fund their own tasks and can always recover funds via cancel
  (pending) or the permissionless expiry path (after deadline).
