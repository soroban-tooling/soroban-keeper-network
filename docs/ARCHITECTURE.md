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
