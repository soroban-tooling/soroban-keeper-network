# Architecture

This document describes how the Soroban Keeper Network fits together and the
invariants the `keeper-registry` contract enforces.

## Components

| Component | Location | Role |
|-----------|----------|------|
| `KeeperRegistry` contract | `contracts/keeper-registry` | On-chain coordination: task registry, escrow, fee accounting, admin controls |
| Keeper bot (example) | `examples/keeper-bot` | Off-chain worker that claims, executes, and settles tasks |
| Deploy / optimize scripts | `scripts/` | Build, optimize, and deploy the contract |

## Task lifecycle

```
                 register_task              claim_task            execute_task
   dApp/owner ───────────────▶  PENDING ───────────────▶ CLAIMED ───────────────▶ EXECUTED
                                   │                         │
                       cancel_task │                         │ (deadline passes, unexecuted)
                                   ▼                         ▼
                               CANCELLED                  expire_task ──▶ EXPIRED
```

- **PENDING** — funded and waiting. Owner may `cancel_task` (refund),
  `increase_reward` (top up), or `extend_deadline`.
- **CLAIMED** — a keeper holds an exclusive lock for `lock_ledgers`. After the
  window elapses, any keeper may re-claim (prevents squatting).
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

Enforced by:

- **Escrow on register / top-up**, released exactly once on execute (split into
  keeper credit + accrued fee), cancel, or expire.
- **Checks-Effects-Interactions** in `withdraw_rewards` and `sweep_fees`: the
  stored balance is zeroed *before* the token transfer, so a re-entrant reward
  token cannot double-spend.
- **`sweep_fees` bounded by `FeesAccrued`**, so admin can never touch task
  escrow or keeper balances.

The `test_multi_keeper_end_to_end_conserves_funds` and
`test_split_reward_invariants` tests guard these invariants.

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
