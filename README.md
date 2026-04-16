# Soroban Keeper Network

> **The decentralized automation & upkeep layer for the Stellar/Soroban ecosystem.**
> Chainlink Keepers — but native to Soroban.

[![CI](https://github.com/arandomogg/soroban-keeper-network/actions/workflows/ci.yml/badge.svg)](https://github.com/arandomogg/soroban-keeper-network/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Built on Soroban](https://img.shields.io/badge/built%20on-Soroban-blueviolet)](https://soroban.stellar.org)

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

- [ ] **On-chain execution verifier interface** — target contracts implement `IKeeperVerifier` and the registry calls them to verify execution succeeded
- [ ] **Batch task registration** — register multiple tasks in one transaction
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
│  │  ┌──────────┬─────────┬────────┬─────────────┬───────────────────┐ │  │
│  │  │  Admin   │ FeeBps  │ Paused │ TaskCounter  │   RewardToken     │ │  │
│  │  └──────────┴─────────┴────────┴─────────────┴───────────────────┘ │  │
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
- `pause`/`unpause` MUST gate `register_task`, `claim_task`, `execute_task`.
- `set_fee_bps` MUST reject values > 10 000.
- `transfer_admin` MUST require auth from BOTH current admin AND new admin.
- `upgrade` MUST use `deployer().update_current_contract_wasm`.

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

| Key | Type | Storage | TTL |
|-----|------|---------|-----|
| `Admin` | `Address` | Instance | Instance lifetime |
| `FeeBps` | `u32` | Instance | Instance lifetime |
| `Paused` | `bool` | Instance | Instance lifetime |
| `TaskCounter` | `u64` | Instance | Instance lifetime |
| `RewardToken` | `Address` | Instance | Instance lifetime |
| `Task(u64)` | `Task` struct | Persistent | `task.ttl_ledgers` |
| `KeeperReward(Address)` | `i128` | Persistent | ~1 year (6.3M ledgers) |

#### Events

All events use two-topic format `(verb_symbol, noun_symbol)` for efficient filtering.

| Event | Topics | Data |
|-------|--------|------|
| `TaskRegistered` | `("reg", "task")` | `(task_id, owner, reward, deadline)` |
| `TaskClaimed` | `("claim", "task")` | `(task_id, keeper, ledger_seq)` |
| `TaskExecuted` | `("exec", "task")` | `(task_id, keeper, net_reward, proof)` |
| `TaskExpired` | `("exp", "task")` | `(task_id,)` |
| `TaskCancelled` | `("cancel", "task")` | `(task_id, owner)` |
| `RewardsWithdrawn` | `("withdraw", "reward")` | `(keeper, amount)` |

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
);
```

**Step 3 — React to execution** (optional Phase 2 — verifier interface):

```rust
// Your contract implements this trait (Phase 2 only)
pub trait IKeeperVerifiable {
    fn verify_execution(env: Env, task_id: u64, proof: Bytes) -> bool;
}
```

---

### Tokenomics

#### Phase 1 — XLM Rewards

- Task owners deposit XLM (or any SAC-wrapped token) as the reward.
- Keepers earn `reward * (1 - fee_bps/10000)` per task.
- Protocol fee (`fee_bps`) is configurable by admin (default 3%).
- Fees accumulate in the contract; admin sweeps to a treasury address.

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
git clone https://github.com/arandomogg/soroban-keeper-network
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

Security issues should be reported per [SECURITY.md](SECURITY.md).

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
