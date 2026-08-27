# Soroban Keeper Network

> **The decentralized automation & upkeep layer for the Stellar/Soroban ecosystem.**
> Chainlink Keepers — but native to Soroban.

[![CI](https://github.com/soroban-tooling/soroban-keeper-network/actions/workflows/ci.yml/badge.svg)](https://github.com/soroban-tooling/soroban-keeper-network/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI docs](https://img.shields.io/badge/CI-docs-informational)](docs/CI.md)
[![Built on Soroban](https://img.shields.io/badge/built%20on-Soroban-blueviolet)](https://soroban.stellar.org)
[![Live on Testnet](https://img.shields.io/badge/testnet-live-brightgreen.svg)](https://stellar.expert/explorer/testnet/contract/CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4)

> **🟢 Live on Stellar testnet:** [`CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4`](https://stellar.expert/explorer/testnet/contract/CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4) — a full register → claim → execute → withdraw run is traced on-chain in [docs/DEMO.md](docs/DEMO.md).

---

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Live demo](docs/DEMO.md) | Deployed testnet contract + full on-chain transaction trace |
| [Architecture](docs/ARCHITECTURE.md) | Components, task lifecycle, storage, money invariants, trust model |
| [Fuzzing & property testing](docs/FUZZING.md) | Running/adding fuzz targets, the shared invariant module, crash-to-regression convention |
| [Verifier design (E04)](docs/VERIFIER_DESIGN.md) | `IKeeperVerifier` interface for optional on-chain proof verification |
| [Indexer design](docs/INDEXER_DESIGN.md) | One instance per deployment, event-shape versioning policy |
| [Indexer deployment](docs/INDEXER_DEPLOYMENT.md) | Provisioning, backfill, and operating an indexer instance |
| [Batch operations (E05)](docs/BATCH_OPERATIONS.md) | Proposed `batch_register_tasks` design + integration guide |
| [Storage layout survey](docs/STORAGE_LAYOUT.md) | `Task` struct storage-cost findings and recommendations |
| [Audit scope](docs/AUDIT_SCOPE.md) | Surfaces and primary artifacts an external auditor should review, including the verifier integration |
| [Events for a future indexer](docs/EVENTS.md) | Verifier-related event schema (epic E14 scope), field-by-field indexer purpose |
| [CI](docs/CI.md) | What each CI job checks and which are advisory vs. required |
| [Deploying & running](docs/DEPLOYING.md) | Testnet deploy walkthrough and keeper-bot operator guide |
| [Deployments](docs/DEPLOYMENTS.md) | Canonical record of on-chain addresses |
| [Contributing](CONTRIBUTING.md) | How to pick up an issue and open your first PR |
| [Changelog](CHANGELOG.md) | Notable changes |

**Quick start:** `make help` lists every common command (build, test, fmt, lint, wasm, optimize, bot).

---

## Problem & Solution

### The Problem

Every DeFi protocol running on Soroban has **time-sensitive operations** that must be triggered by an external agent:

- **Liquidations** — health factor drops below threshold → position must be liquidated
- **Oracle price pushes** — off-chain price must be written on-chain every N seconds
- **Funding rate updates** — perpetuals markets need periodic rate settlements
- **LP rebalancing** — concentrated liquidity positions fall outside active range
- **TTL extensions** — Soroban's storage expiry model means contract data expires unless refreshed

Today, each protocol runs its own centralised bot, creating:

| Pain | Impact |
|------|--------|
| Single point of failure | Missed liquidations → bad debt, insolvency |
| High ops burden | Every team re-invents the same infrastructure |
| No economic incentives | Bots run at a loss; sustainability risk |
| Opaque | No on-chain record of who executed what and when |

### The Solution — Soroban Keeper Network

A **shared, permissionless, on-chain coordination layer** where:

- **dApps** register automation tasks with an XLM reward bounty.
- **Anyone** can run a keeper bot to claim and execute tasks, earning rewards.
- **The registry contract** enforces fairness, handles escrow, and emits events.
- **No trust required** — keepers are economically incentivised, not whitelisted.

```
┌─────────────────────────────────────────────────────────┐
│                    dApp / Protocol                      │
│  (lending protocol, DEX, perps, oracle aggregator...)   │
└────────────────┬────────────────────────────────────────┘
                 │  register_task(reward, calldata, deadline)
                 ▼
┌─────────────────────────────────────────────────────────┐
│              KeeperRegistry Contract                    │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ Task Storage │  │  Fee Logic  │  │  Auth / Pause │  │
│  └──────────────┘  └─────────────┘  └───────────────┘  │
└────────────────┬────────────────────────────────────────┘
                 │  events: TaskRegistered, TaskClaimed, TaskExecuted
                 ▼
┌──────────────────────────────────────────────────────────────┐
│                 Off-Chain Keeper Bots (permissionless)        │
│  Bot A   Bot B   Bot C   ... (anyone can run one)            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 1. Listen to events                                    │  │
│  │ 2. claim_task(task_id)                                 │  │
│  │ 3. Execute underlying action (liquidate, push price…)  │  │
│  │ 4. execute_task(task_id, proof)                        │  │
│  │ 5. withdraw_rewards()                                  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Key Features

### MVP (v1 — This Repo)

- [x] **Task Registry** — any Soroban contract or EOA registers tasks with XLM reward
- [x] **Permissionless claiming** — first keeper to claim wins lock rights
- [x] **Lock period** — prevents spam claims while giving the claimer time to execute
- [x] **Re-claim after lock expiry** — unresponsive keepers lose their lock
- [x] **Execution proof** — keepers submit a tx hash / state witness for transparency
- [x] **Reward escrow** — XLM held in contract until task is executed or expired
- [x] **Auto-expiry** — permissionless `expire_task` refunds owner after deadline
- [x] **Task cancellation** — owner can cancel a Pending task and receive refund
- [x] **Protocol fee** — configurable basis-point fee taken from rewards
- [x] **Upgradeable** — admin can upgrade WASM via Soroban's native pattern
- [x] **Pause/unpause** — emergency circuit breaker
- [x] **Full event log** — `TaskRegistered`, `TaskClaimed`, `TaskExecuted`, `TaskExpired`, `TaskCancelled`

### Phase 2 (Roadmap)

- [x] **On-chain execution verifier interface** — target contracts implement `IKeeperVerifier` and `execute_task` calls them before crediting the keeper (see [docs/VERIFIER_DESIGN.md](docs/VERIFIER_DESIGN.md)); an admin-curated allowlist and the reference verifiers (signature/oracle/tx-inclusion) remain open follow-up issues
- [x] **Batch task registration** — `batch_register_tasks` registers up to `MAX_BATCH_SIZE` tasks in one transaction under a single owner auth, with a `max_total_reward` escrow ceiling (see [docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md))
- [ ] **EIP-like task conditions** — on-chain `checkUpkeep` callback before claiming
- [ ] **Keeper reputation scores** — slash stake for missed executions
- [ ] **Keeper staking** — stake XLM or governance token for priority and dispute resolution
- [ ] **Governance token ($KPRS)** — vote on fee parameters, upgrades, whitelists
- [ ] **Treasury contract** — protocol fees flow to stakers
- [ ] **Subgraph / indexer** — TheGraph-style event indexing for analytics

### Phase 3 (Vision)

- [ ] **Cross-contract task composition** — chain multiple operations as a single task
- [ ] **Decentralized oracle integration** — task conditions driven by Reflector/Band
- [ ] **SDK libraries** — TypeScript + Rust SDKs so dApps integrate in < 1 hour
- [ ] **Keeper DAO** — fully on-chain governance of protocol parameters
- [ ] **Stellar Community Fund grant round** — sustained ecosystem funding

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        Soroban Keeper Network                              │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    KeeperRegistry Contract                          │  │
│  │                                                                     │  │
│  │  Instance Storage (hot, short-TTL)                                  │  │
│  │  ┌──────────┬─────────┬────────┬─────────────┬─────────────┬──────┐ │  │
│  │  │  Admin   │ FeeBps  │ Paused │ TaskCounter  │ RewardToken │ Fees │ │  │
│  │  └──────────┴─────────┴────────┴─────────────┴─────────────┴──────┘ │  │
│  │                                                                     │  │
│  │  Persistent Storage (task lifetime)                                 │  │
│  │  ┌────────────────────────────────────────────────────────────┐    │  │
│  │  │  Task(id) → { owner, type, calldata, reward, deadline,     │    │  │
│  │  │               status, claimer, claim_ledger, lock_ledgers } │    │  │
│  │  └────────────────────────────────────────────────────────────┘    │  │
│  │  ┌────────────────────────────────────────────────────────────┐    │  │
│  │  │  KeeperReward(address) → i128  (claimable balance)         │    │  │
│  │  └────────────────────────────────────────────────────────────┘    │  │
│  │                                                                     │  │
│  │  External (Token)                                                   │  │
│  │  ┌────────────────────────────────────────────────────────────┐    │  │
│  │  │  SAC / XLM token contract (transfer, balance)              │    │  │
│  │  └────────────────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌────────────────┐    ┌─────────────────────────┐    ┌───────────────┐   │
│  │  dApp Contract │───▶│  register_task (XLM dep) │───▶│  TaskRegistered│  │
│  └────────────────┘    └─────────────────────────┘    │     Event     │   │
│                                                        └───────┬───────┘   │
│  ┌────────────────┐    ┌─────────────────────────┐            │           │
│  │  Keeper Bot A  │───▶│  claim_task             │◀───────────┘           │
│  └────────────────┘    └─────────────────────────┘                        │
│         │              ┌─────────────────────────┐    ┌───────────────┐   │
│         └─────────────▶│  execute_task + proof   │───▶│ TaskExecuted  │   │
│                        └─────────────────────────┘    │     Event     │   │
│                                                        └───────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Product Requirements Document (PRD)

### User Stories

#### dApp Developers / Protocol Owners

| As a... | I want to... | So that... |
|---------|-------------|-----------|
| Lending protocol | Register a liquidation task when a position is undercollateralised | My protocol remains solvent without running my own bot |
| Oracle provider | Register periodic price-push tasks with a time deadline | Prices stay fresh without centralised infrastructure |
| Perp DEX | Register funding rate settlement tasks every 8 hours | Settlement never misses even if my team is offline |
| AMM | Register LP rebalancing tasks with custom calldata | Liquidity is always in range without manual intervention |
| Any Soroban contract | Cancel a task if the underlying condition resolves itself | I don't pay keepers for work that's no longer needed |

#### Keeper Operators

| As a... | I want to... | So that... |
|---------|-------------|-----------|
| Keeper | Listen to on-chain events and claim profitable tasks | I earn XLM rewards for providing upkeep |
| Keeper | See the reward amount before claiming | I can calculate profitability vs gas |
| Keeper | Re-claim a task if the original claimer vanished | No task is permanently stuck |
| Keeper | Withdraw my accumulated balance in one transaction | I minimise transaction overhead |

#### Protocol/Admin

| As a... | I want to... | So that... |
|---------|-------------|-----------|
| Admin | Pause the registry in emergencies | No new tasks can be registered during an incident |
| Admin | Upgrade the WASM hash | Bug fixes and new features can be deployed without redeployment |
| Admin | Adjust fee basis points | Protocol economics can be tuned by governance |
| Admin | Sweep accumulated fees to treasury | Revenue flows to stakeholders |

---

### Functional Requirements

#### FR-1: Task Registration
- `register_task` MUST escrow the full reward amount from the caller.
- Task ID MUST be monotonically increasing and globally unique.
- `deadline` MUST be strictly in the future at registration time.
- `calldata` MUST NOT exceed `MAX_CALLDATA_LEN` (1024 bytes), rejected with
  `CalldataTooLarge` otherwise. Empty `calldata` is accepted.
- `reward` MUST be greater than zero.
- MUST emit `TaskRegistered` event with `(task_id, owner, reward, deadline)`.

#### FR-2: Task Claiming
- `claim_task` MUST be callable by any address (permissionless).
- MUST reject if task is not in `Pending` or `Claimed` (with expired lock) state.
- MUST reject if `deadline` has passed.
- MUST record the `claimer` address and `claim_ledger`.
- A second keeper MUST be able to claim after `lock_ledgers` have elapsed.
- MUST emit `TaskClaimed` event.

#### FR-3: Task Execution
- `execute_task` MUST only be callable by the current `claimer`.
- MUST reject if task deadline has passed.
- MUST credit `(reward * (10000 - fee_bps) / 10000)` to the keeper's balance.
- Protocol fee MUST remain in the contract (swept separately by admin).
- MUST emit `TaskExecuted` with net reward and proof bytes.
- Task status MUST transition to `Executed` (immutable after this point).

#### FR-4: Task Cancellation
- `cancel_task` MUST only be callable by the task owner.
- MUST only be callable when task is in `Pending` state.
- MUST refund the full reward to the owner.
- MUST emit `TaskCancelled`.

#### FR-5: Task Expiry
- `expire_task` MUST be callable by anyone.
- MUST only succeed when `ledger.timestamp >= task.deadline`.
- MUST refund the full reward to the task owner.
- MUST emit `TaskExpired`.

#### FR-6: Reward Withdrawal
- `withdraw_rewards` MUST transfer the keeper's full credited balance.
- MUST zero the balance before transfer (CEI pattern).
- MUST emit `RewardsWithdrawn`.
- MUST revert if balance is zero.

#### FR-7: Admin Controls
- `pause`/`unpause` MUST gate `register_task`, `claim_task`, `execute_task`,
  `increase_reward`, and `extend_deadline` — the first four open new escrow
  or reward exposure, and `extend_deadline` can keep escrow locked in a
  contract the admin has declared unsafe if left open.
- `pause`/`unpause` MUST NOT gate `cancel_task`, `expire_task`, or
  `withdraw_rewards` — these only let already-escrowed value flow back to
  whoever already owns it, which must always stay available so an admin
  pause can never become a fund freeze. Read-only views are likewise never
  gated.
  See the `pause`/`unpause` doc comment in
  `contracts/keeper-registry/src/lib.rs` and the
  `test_pause_policy_matrix_entry_point_by_entry_point` test in
  `contracts/keeper-registry/src/test.rs` for the authoritative, verified
  matrix.
- `set_fee_bps` MUST reject values > 10 000.
- `transfer_admin` MUST require auth from BOTH current admin AND new admin.
- `upgrade` MUST use `deployer().update_current_contract_wasm`, and MUST
  emit `Upgraded` (admin + new WASM hash) before doing so.

#### FR-8 — Batch Task Registration

`batch_register_tasks` is implemented; see
[docs/BATCH_OPERATIONS.md](docs/BATCH_OPERATIONS.md) for the full design and
integration guide.
- `batch_register_tasks` MUST require the owner's auth once for the entire
  batch, not per entry.
- MUST reject the whole call, with zero transfers, if the sum of the
  batch's rewards exceeds the caller-supplied `max_total_reward`.
- MUST reject the whole call, with zero transfers, if any single entry fails
  the same validation `register_task` applies.
- MUST reject a batch larger than `MAX_BATCH_SIZE` with `BatchTooLarge`,
  rather than letting it fail as opaque resource exhaustion.
- MUST return task ids in the same order as the input entries.

Note that `MAX_BATCH_SIZE` is currently a conservative guard rather than a
measured ceiling — issue 0104 owns the empirical measurement. Read the live
value from the `max_batch_size()` view instead of hardcoding it.

#### FR-8: Batch Task Reads
- `get_tasks(ids: Vec<u64>) -> Vec<Option<Task>>` MUST read every requested id
  in a single call, so an indexer or keeper bot does not need one RPC round
  trip per task.
- `get_tasks_range(from: u64, count: u32) -> Vec<Option<Task>>` MUST read the
  contiguous ids `from … from + count - 1`. It is the convenience form for the
  common "scan recent tasks" case, so a caller walking backwards from
  `task_count` need not build a `Vec<u64>`.
- Both MUST accept at most `MAX_BATCH_READ` (50) ids. The bound exists because
  each id costs exactly one Persistent storage read charged against the
  transaction's read-entry and read-bytes limits; at `MAX_CALLDATA_LEN` (1 KiB)
  per task, 50 reads stay comfortably inside a single simulation.
- Exceeding the bound MUST return `BatchTooLarge` rather than truncating — a
  silently clipped page is indistinguishable from the genuine end of a range.
- A range whose last id would exceed `u64::MAX` MUST return
  `ArithmeticOverflow` rather than wrapping around to low ids.
- **Missing ids** MUST be returned as `None` in place, not omitted: the result
  is *positionally aligned* with the request (`out.len() == ids.len()`, and
  `out[i]` corresponds to `ids[i]`). A single absent id MUST NOT fail the whole
  call. `Vec<Option<Task>>` is used rather than a compacted `Vec<Task>` because
  `Task` carries no `task_id` field — omitting missing ids would make the
  mapping from result back to requested id unrecoverable. `None` is a void XDR
  variant, so the alignment costs almost nothing on the wire.
- `count == 0` and an empty `ids` MUST return an empty vector, not an error.
- Duplicate ids are permitted and each is resolved independently.
- Both are read-only views and are therefore never gated by `pause`.

---

### Non-Functional Requirements

#### Security
- All state-mutating functions require `address.require_auth()`.
- No re-entrancy vectors: token transfers happen after all state mutations (CEI pattern).
- No unchecked arithmetic — Rust's `checked_*` methods or overflow-checks = true.
- Admin cannot drain escrowed task rewards; only sweeps protocol fees.
- Upgrade requires admin auth — no anonymous upgrades.

#### Gas Efficiency
- Instance storage for hot/shared data (admin, counter, flags).
- Persistent storage for per-task data with explicit TTL management.
- No unbounded iteration — no `Vec<task_id>` scanned in O(n); queries are by key.
  This is a constraint on *storage*: the contract keeps no growing list that any
  operation has to walk. It does not forbid a read-only view over a bounded,
  caller-supplied set of keys — `get_tasks` / `get_tasks_range` (FR-8) are still
  O(1) per key against `DataKey::Task(id)`, the caller supplies the keys, and
  the count is capped by the `MAX_BATCH_READ` constant.
- Events are the query primitive for off-chain indexers.

#### Scalability
- Task IDs are u64 — supports 18 quintillion tasks.
- Reward balance is aggregated per keeper — single persistent entry regardless of tasks executed.
- Storage TTL managed per entry; expired tasks are naturally evicted by the ledger.

#### Liveness
- Tasks with expired lock periods are always re-claimable.
- `expire_task` is permissionless — anyone can trigger it to unblock a stuck task.
- Contract pause does not affect reward withdrawal (keepers can always pull earned funds).

---

### Technical Specifications

#### Storage Model

| Key | Type | Storage | TTL | Default when unset |
|-----|------|---------|-----|---------------------|
| `Admin` | `Address` | Instance | Instance lifetime | — |
| `FeeBps` | `u32` | Instance | Instance lifetime | `0` (see `DEFAULT_FEE_BPS`) |
| `Paused` | `bool` | Instance | Instance lifetime | `false` |
| `TaskCounter` | `u64` | Instance | Instance lifetime | `0` |
| `RewardToken` | `Address` | Instance | Instance lifetime | — |
| `Task(u64)` | `Task` struct | Persistent | `task.ttl_ledgers` | — |
| `KeeperReward(Address)` | `i128` | Persistent | ~1 year (6.3M ledgers) | `0` |

`Task.calldata` is capped at `MAX_CALLDATA_LEN` = 1024 bytes, enforced at
`register_task`. `save_task` re-writes the whole `Task` struct (including
`calldata`) on every lifecycle mutation — `claim_task`, `execute_task`, the
permissionless `expire_task`, `increase_reward`, `extend_deadline` — and those
calls are frequently made by a keeper or third party, not the task owner. An
unbounded `calldata` would let an owner push arbitrarily large re-serialisation
and storage cost onto whoever touches the task next. 1024 bytes comfortably
covers a realistic encoded contract call — a target `Address` (~40 bytes XDR),
a function `Symbol` (up to 32 bytes), and several scalar or address arguments —
with headroom for XDR/Vec overhead. Empty `calldata` is accepted, since some
task types (e.g. a `TtlExtension` against a well-known key) need no extra
encoded parameters.

#### Events

All events use two-topic format `(verb_symbol, noun_symbol)` for efficient filtering.

```text
contracts/keeper-registry/  Soroban keeper registry contract
examples/keeper-bot/         Example keeper bot (keeper side)
examples/batch-register/     Batch registration helper (task-owner side)
a fuzz/                        Fuzzing targets and shared support code
docs/                        Architecture, deployment, and demo documentation
```

## Development
### Events

Events are the integration contract for off-chain consumers. The table below is
transcribed from the `emit_*` functions in `contracts/keeper-registry/src/lib.rs`
(all grouped under the `Events` banner) and lists every event the contract
emits, and nothing it does not. Build event filters from the **Topics** column
only — the `Event` names are documentation labels, not on-chain values.

Every event publishes exactly two topic symbols. Both are `symbol_short!`
literals, which Soroban limits to **9 characters**; that is why several topics
are abbreviated (`wdraw`, not `withdraw`; `minrwd`, not `min_reward`). The
abbreviations are part of the on-chain interface and cannot be "corrected"
without breaking existing consumers.

| Event | Emitted by | Topics | Data (in order, with type) |
|-------|-----------|--------|----------------------------|
| `Initialized` | `initialize` | `("init", "admin")` | `(admin: Address, reward_token: Address, fee_bps: u32)` — emitted at most once |
| `TaskRegistered` | `register_task` | `("reg", "task")` | `(task_id: u64, owner: Address, reward: i128, deadline: u64)` |
| `RewardIncreased` | `increase_reward` | `("topup", "task")` | `(task_id: u64, new_reward: i128)` — the new **total** reward, not the delta |
| `DeadlineExtended` | `extend_deadline` | `("extend", "task")` | `(task_id: u64, new_deadline: u64)` |
| `TaskClaimed` | `claim_task` | `("claim", "task")` | `(task_id: u64, keeper: Address, ledger_seq: u32)` |
| `TaskExecuted` | `execute_task` | `("exec", "task")` | `(task_id: u64, keeper: Address, net_reward: i128, proof: Bytes)` |
| `TaskCancelled` | `cancel_task` | `("cancel", "task")` | `(task_id: u64, owner: Address)` |
| `TaskExpired` | `expire_task` | `("exp", "task")` | `(task_id: u64,)` |
| `RewardsWithdrawn` | `withdraw_rewards` | `("wdraw", "reward")` | `(keeper: Address, amount: i128)` |
| `Paused` | `pause` / `unpause` | `("paused", "admin")` | `(paused: bool,)` — `true` from `pause`, `false` from `unpause` |
| `FeeUpdated` | `set_fee_bps` | `("fee", "admin")` | `(old_bps: u32, new_bps: u32)` |
| `MinRewardUpdated` | `set_min_reward` | `("minrwd", "admin")` | `(old_min: i128, new_min: i128)` |
| `AdminTransferred` | `transfer_admin` | `("admin", "xfer")` | `(old_admin: Address, new_admin: Address)` |
| `FeesSwept` | `sweep_fees` | `("sweep", "admin")` | `(treasury: Address, amount: i128, remaining: i128)` |
| `Upgraded` | `upgrade` | `("upgrade", "admin")` | `(admin: Address, new_wasm_hash: BytesN<32>)` — emitted before the executable is swapped |

Notes:

- `net_reward` in `TaskExecuted` is the keeper's share **after** the protocol
  fee, not the task's gross reward.
- `("admin", "xfer")` is the only event whose first topic is `"admin"`; every
  other admin event uses `"admin"` as its *second* topic. Filter on both topics,
  not just one.
- `VerifierUpdated` and `TaskVerificationFailed` are epic E04 (verifier
  integration) events; see [`docs/EVENTS.md`](docs/EVENTS.md) for their
  full schema and indexer-relevant purpose per field, and note that
  epic's current implementation status there before building against
  them.
| Event | Topics | Data |
|-------|--------|------|
| `TaskRegistered` | `("reg", "task")` | `(task_id, owner, reward, deadline)` |
| `TaskClaimed` | `("claim", "task")` | `(task_id, keeper, ledger_seq)` |
| `TaskExecuted` | `("exec", "task")` | `(task_id, keeper, net_reward, proof)` |
| `TaskExpired` | `("exp", "task")` | `(task_id,)` |
| `TaskCancelled` | `("cancel", "task")` | `(task_id, owner)` |
| `RewardsWithdrawn` | `("withdraw", "reward")` | `(keeper, amount)` |
| `Initialized` | `("init", "admin")` | `(admin, reward_token, fee_bps)` — emitted at most once |
| `MinRewardUpdated` | `("minrwd", "admin")` | `(old_min, new_min)` |
| `FeesSweep` | `("sweep", "admin")` | `(treasury, amount, remaining)` |

#### Task Lifecycle State Machine

```
              register_task()
NONE ─────────────────────────────────▶ PENDING
                                           │
               ┌──────────────────────────┘│
               │ claim_task()              │ cancel_task()
               ▼                          ▼
            CLAIMED                    CANCELLED
               │
       ┌───────┴──────────┐
       │ execute_task()   │ expire_task() (deadline passed)
       ▼                  ▼
    EXECUTED           EXPIRED

    (re-claim possible if lock_ledgers elapsed without execute)
```

---

### Integration Guide

#### How Other Soroban Contracts Call This

**Step 1 — Approve the reward amount** (ERC-20 / SEP-41 style):

```rust
// In your dApp contract, approve the registry to transfer reward tokens
token_client.approve(
    &env.current_contract_address(), // from: your contract
    &registry_contract_id,           // spender: the registry
    &reward_amount,
    &(env.ledger().sequence() + 1000), // expiry ledger
);
```

**Step 2 — Register the task**:

```rust
// Cross-contract call to register a task
let registry = KeeperRegistryClient::new(&env, &registry_contract_id);
let task_id = registry.register_task(
    &env.current_contract_address(), // owner
    &TaskType::Liquidation,
    &calldata,                        // encoded liquidation params
    &reward_amount,                   // XLM in stroops
    &(env.ledger().timestamp() + 3600), // deadline: 1 hour from now
    &17_280u32,                       // TTL: ~1 day
    &120u32,                          // lock: ~10 minutes
    &None,                            // verifier: Some(addr) to require on-chain proof verification
);
```

**Step 3 — Optional on-chain proof verification** (see
[docs/VERIFIER_DESIGN.md](docs/VERIFIER_DESIGN.md)):

```rust
// Implement this trait on a contract of your choosing, then pass its
// address as register_task's `verifier` argument (Some(addr) instead of
// None above). execute_task calls it before crediting the keeper, and
// rejects with KeeperError::VerificationFailed if it returns false.
pub trait IKeeperVerifier {
    fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool;
}
```

---

### Tokenomics

#### Phase 1 — XLM Rewards

- Task owners deposit XLM (or any SAC-wrapped token) as the reward.
- Keepers earn `reward * (1 - fee_bps/10000)` per task.
- Protocol fee (`fee_bps`) is configurable by admin (default 3%).
- Fees accumulate in the contract; admin sweeps to a treasury address.

##### Fee rounding and the dust threshold

The fee is computed with integer division, so it always rounds **down**:

```text
fee        = floor(reward * fee_bps / 10_000)
keeper_net = reward - fee
```

This is a guarantee, not an accident of the implementation. The protocol can
never collect more than the nominal `fee_bps` rate; it may collect very
slightly less, and the shortfall is bounded by **one stroop per execution**,
always in the keeper's favour. `keeper_net + fee == reward` holds exactly for
every input, so nothing is created or destroyed by the split.

Anyone reconciling expected protocol revenue against actual accrued fees should
expect a deficit of up to one stroop per executed task. That is this rule, not
a bug.

**The dust threshold.** For small rewards the fee rounds to zero entirely. The
fee is non-zero only once:

```text
min_reward >= ceil(10_000 / fee_bps)
```

At the 300 bps (3%) default that threshold is **34 stroops**:

| `reward` | `fee_bps` | `fee` | `keeper_net` | effective rate |
|---------:|----------:|------:|-------------:|---------------:|
| 1 | 300 | 0 | 1 | 0% |
| 33 | 300 | 0 | 33 | 0% |
| 34 | 300 | 1 | 33 | 2.9% |
| 100 | 300 | 3 | 97 | 3% |
| 10 000 000 | 300 | 300 000 | 9 700 000 | 3% |

This connects two parameters that are otherwise set independently. Choosing a
`min_reward` below the threshold means the protocol earns **nothing** on those
tasks while still bearing their storage cost, so `min_reward` and `fee_bps`
should be chosen together. Setting `fee_bps` to `0` is also legal and gives the
keeper the whole reward; `10_000` (100%) is legal too, and is the one setting
where a keeper executes a task for no reward at all.

#### Phase 2 — Governance Token ($KPRS)

| Attribute | Value |
|-----------|-------|
| Name | Keeper Token |
| Symbol | KPRS |
| Total Supply | 100,000,000 |
| Distribution | 40% Keepers (emissions over 4 years), 20% Team (4-year vest), 20% Ecosystem fund, 10% Early supporters, 10% Treasury |
| Utility | Vote on fee params, propose upgrades, stake for priority queue |
| Emissions | Proportional to tasks executed and stake weight |

---

## Deployment & Usage

### Prerequisites

```bash
# Rust + WASM target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Soroban CLI
cargo install --locked stellar-cli --features opt

# Node.js ≥ 18 (for keeper bot)
node --version
```

### Local Development

```bash
git clone https://github.com/soroban-tooling/soroban-keeper-network
cd soroban-keeper-network

# Run all tests
cargo test --all --features testutils

# Build WASM
cargo build --release --target wasm32-unknown-unknown --package keeper-registry
```

### Testnet Deployment

```bash
# Fund a testnet account
stellar keys generate --global deployer
stellar keys fund deployer --network testnet

export DEPLOYER_SECRET_KEY=$(stellar keys show --secret deployer)
export ADMIN_ADDRESS=$(stellar keys address deployer)

# Deploy
./scripts/deploy.sh testnet
```

### Running the Keeper Bot

```bash
cd examples/keeper-bot
npm install
cp .env.example .env
# Edit .env with your secret key and contract ID
npm run start:testnet
```

### Registering Tasks in Bulk

The owner-side counterpart: reads a JSON or CSV task list and registers the
whole list in one `batch_register_tasks` call. See
[examples/batch-register/README.md](examples/batch-register/README.md) for the
file format and the reasoning behind how it sets `max_total_reward`.

```bash
cd examples/batch-register
npm install
cp .env.example .env
# Edit .env with your funded owner secret key and contract ID
node index.js tasks.example.json --dry-run   # validate + preview
node index.js tasks.example.json             # submit
```

#### Executor Interface

The bot dispatches off-chain execution to a per-`task_type` executor rather
than performing (or faking) the work inline. This exists because the
registry's trust model (see "Known Design Decisions" #1 below) has no
on-chain verification of a keeper's proof — the bot itself is the only
thing standing between "did the work" and "claimed the reward for work it
didn't do", so the reference implementation refuses unhandled task types
instead of fabricating proof for them.

An executor is an async function with this contract:

```js
/**
 * @param {object} task
 *   { taskId, taskType, taskTypeName, calldata (Buffer), reward, deadline }
 * @param {object} ctx
 *   { server, keypair, networkPassphrase, log }
 * @returns {Promise<Buffer|null>}
 *   Proof bytes on success; null if the work could not be completed.
 *   Returning null (or throwing) means the bot will NOT call execute_task —
 *   the task is left for another keeper or for expiry.
 */
async function myExecutor(task, ctx) { /* ... */ }
```

Register one per task type in `EXECUTORS` (`examples/keeper-bot/index.js`):

```js
const EXECUTORS = {
  TtlExtension: ttlExtensionExecutor, // worked example, included
  // Liquidation: myLiquidationExecutor,
};
```

There is no default executor that fabricates a proof. A task type with
nothing registered is skipped and logged, not faked — set
`SIMULATE_EXECUTION=true` (development only, see `.env.example`) if you
need the daemon loop to complete a round without a real executor in place.

---

## Security Considerations & Audit Plan

### Known Design Decisions

1. **No on-chain execution verification (MVP)** — The registry trusts the claimer to submit proof. A malicious keeper could claim-and-execute-fake. Phase 2 adds an optional verifier callback.
2. **Fee sweep is manual** — Protocol fees are batched and swept by admin. In Phase 2 this flows automatically to a staking/treasury contract.
3. **No slashing (MVP)** — Unresponsive keepers lose their lock but face no economic penalty. Phase 2 introduces staking + slashing.

### Security Properties

- **No re-entrancy** — State transitions happen before token transfers (CEI pattern throughout).
- **Auth on all mutations** — Every write function calls `address.require_auth()`.
- **Overflow protection** — `overflow-checks = true` in release profile + `checked_*` arithmetic.
- **Bounded storage** — No dynamic `Vec` in storage; all reads are O(1) by key.
- **Upgrade is admin-gated** — WASM upgrade requires admin auth; new WASM must be pre-uploaded.

### Audit Plan

| Phase | Scope | Target |
|-------|-------|--------|
| Pre-audit | Internal review + fuzzing | Q3 2026 |
| Formal audit | `keeper-registry` contract | Q4 2026 |
| Ongoing | Automated invariant testing with `cargo-fuzz` | Continuous |

Security issues should be reported per [SECURITY.md](SECURITY.md). See
[`docs/AUDIT_SCOPE.md`](docs/AUDIT_SCOPE.md) for the per-surface scope an
external auditor should review, including the verifier integration's
trust boundary.

---

## Stellar Community Fund / SDF Grant Readiness

This project is designed to qualify for:

- **Stellar Community Fund (SCF)** — Open source infrastructure grant
- **SDF Build program** — Soroban DeFi tooling
- **Meridian hackathon** — Infrastructure track

**Grant readiness checklist:**
- [x] Open source (Apache-2.0)
- [x] On Soroban / Stellar ecosystem
- [x] Novel infrastructure (no equivalent exists)
- [x] Composable — designed to be used by other protocols
- [x] Fully documented + testable
- [x] Roadmap beyond MVP

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide including branch strategy, commit conventions, and PR process.

---

## License

[Apache-2.0](LICENSE) — see the LICENSE file for full terms.
