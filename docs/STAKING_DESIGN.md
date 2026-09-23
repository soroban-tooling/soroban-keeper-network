# Staking and Slashing Architecture (E06)

This is the architectural design document for Keeper Staking and Slashing in
the Soroban Keeper Network — the decision record against which issues
0289–0316 are implemented.

**Status: Design Phase.** Opens Epic E06. Defines the collateral, unbonding,
dispute, and slashing mechanisms that introduce economic accountability to
keepers while preserving protocol solvency and permissionless participation.

---

## 1. Context and Problem Statement

In the wave-1 MVP and wave-2 releases, the keeper registry relies entirely on a
time-based lock window (`lock_ledgers`) to mitigate keeper misbehavior
(specifically task squatting, issue 0016). When a keeper claims a task via
`claim_task`, it receives exclusive execution rights for `lock_ledgers`. If the
keeper fails to submit `execute_task` before the lock window lapses, any other
keeper can reclaim the task.

However, this mechanic alone provides **no accountability beyond time loss**:
1. **Zero Financial Disincentive for Fraud**: Keepers post no collateral. A
   keeper can submit fraudulent execution proofs or spam malicious claims at
   virtually zero financial risk beyond minimal network transaction fees.
2. **Squatting Griefing**: A malicious keeper can claim high-value tasks across
   consecutive rounds, holding them hostage for `lock_ledgers` blocks at a time,
   intentionally delaying critical DeFi automations (liquidations, oracle pushes)
   without incurring any capital penalty.
3. **Reputation Blindness**: Integrators and task owners cannot differentiate
   between reliable, well-capitalized professional node operators and ephemeral
   or adversarial actors.

Epic E06 introduces **Keeper Staking and Slashing**: keepers post collateral in
escrow, and verifiable misbehavior results in slashing a portion or all of that
collateral.

---

## 2. What Counts as Slashable & Verifier Dependency

### 2.1 The Dependency on Epic E04 (Verifier Work)

**Explicit Finding and Decision:**
In Epic E04 (`docs/VERIFIER_DESIGN.md`), the `IKeeperVerifier` interface was
designed and the core contract slice was implemented (`Task.verifier: Option<Address>`,
and the verifier invocation hook in `execute_task`). However:
1. `execute_task`'s verifier hook only performs **pre-execution gating**: if
   the verifier returns `false` or panics, `execute_task` returns
   `KeeperError::VerificationFailed`, aborting the execution and leaving the
   task in its claimed state for retry. It does **not** slash the keeper.
2. The deployed contracts do not have a deterministic, universally audited suite
   of on-chain verifiers covering all task types, nor does every registered task
   have a verifier attached (`Task.verifier` is optional and defaults to `None`).
3. If an automated on-chain verifier failure directly triggered immediate
   slashing in the core contract, a malicious task owner could register a task
   pointing to a verifier contract that maliciously returns `false` or panics,
   weaponizing the registry to arbitrarily seize keeper collateral.

**Decision: Slashing in v1 is Dispute-Based with Challenge Windows, NOT Automatic on Verifier Panic.**
Epic E06 **does NOT depend** on full on-chain verifier automation landing first.
Instead, version 1 of staking adopts a **hybrid dispute-resolution model**:
- **Execution Path**: `execute_task` proceeds with existing checks (and verifier
  validation if attached).
- **Post-Execution Dispute Window**: Following `execute_task`, a task enters a
  bounded challenge period (`dispute_window_ledgers`).
- **Slash Trigger**: Slashing is triggered via an authorized `slash` entry
  point resulting from an upheld dispute (raised by the task owner or protocol
  dispute resolver) or an explicit governance/admin decision.

### 2.2 Enumeration of Slashable Offenses

The protocol recognizes three distinct slashable conditions:

| Offense | Detection Mechanism | Penalty | Destination |
| :--- | :--- | :--- | :--- |
| **Fraudulent Proof / Invalid Execution** | Disputed within `dispute_window_ledgers` and verified invalid | Fixed penalty or up to 100% of task reward value in stake | Restitution to task owner + Protocol Treasury |
| **Malicious Task Abandonment / Squatting** | Repeated lock window expirations by the same claimer without execution (when `min_stake` is enforced) | Configurable slash penalty (`slash_abandonment_fee`) | Protocol Treasury (`FeesAccrued`) |
| **Proof Equivocation / Double Submission** | Cryptographic proof that keeper submitted conflicting execution states | Full slash of minimum stake | Protocol Treasury (`FeesAccrued`) |

---

## 3. Where Stake Lives: Architecture & Tradeoffs

A fundamental question for E06 is whether stake collateral lives inside the
existing registry contract or in a separate dedicated staking contract.

### 3.1 Architectural Tradeoffs

```text
Option A: Separate Dedicated Staking Contract
┌─────────────────────────┐         cross-contract call         ┌─────────────────────────┐
│     KeeperRegistry      │ ──────────────────────────────────▶ │     StakingContract     │
│  (Tasks & Rewards Pool) │ ◀────────────────────────────────── │     (Collateral Pool)   │
└─────────────────────────┘         authorization check         └─────────────────────────┘

Option B: In-Contract Isolated Storage (Chosen)
┌─────────────────────────────────────────────────────────────┐
│                       KeeperRegistry                        │
│                                                             │
│  ┌─────────────────────────┐     ┌───────────────────────┐  │
│  │   Task Escrow & Fees    │     │  Keeper Stake Storage │  │
│  │    DataKey::Task(_)     │     │  DataKey::KeeperStake │  │
│  │    DataKey::FeesAccrued │     │  DataKey::Unbonding   │  │
│  └─────────────────────────┘     └───────────────────────┘  │
│           ▲                                   ▲             │
│           └─────────── Strictly Isolated ─────┘             │
└─────────────────────────────────────────────────────────────┘
```

| Evaluation Dimension | Dedicated Staking Contract (Option A) | In-Contract Isolated Storage (Option B) |
| :--- | :--- | :--- |
| **Failure Isolation** | High: Staking bugs cannot directly mutate task escrow data. | High: Strict `DataKey` isolation prevents cross-domain corruption. |
| **Gas & CPU Consumption** | High: Cross-contract call on every `claim_task` and `execute_task` to check stake eligibility. | Minimal: In-memory/host ledger read using native `DataKey`. |
| **Transaction Atomicity** | Complex: Two-phase commit or cross-contract reentrancy risks on slash/claim. | Guaranteed: Atomic transaction execution native to Soroban host. |
| **Upgradability** | Separate upgrades, but complicates address authorization and trust handshakes. | Unified versioning via registry's existing `VERSION` and contract upgrades. |

### 3.2 Decision and Rationale

**Decision: In-Contract Isolated Storage (Option B).**
Stake collateral is held directly in `KeeperRegistry` under dedicated, isolated
`DataKey` variants:
- `DataKey::KeeperStake(Address)`
- `DataKey::UnbondingStake(Address)`

**Rationale:**
1. **High-Frequency Efficiency**: Every `claim_task` call must verify that the
   claiming keeper meets the minimum required stake. A cross-contract call on
   every claim introduces unnecessary CPU and latency overhead into time-sensitive
   DeFi liquidations.
2. **Strict Domain Separation**: Following the pattern established by
   `FeesAccrued` (which is kept strictly distinct from task escrow and keeper
   rewards), `KeeperStake` uses dedicated storage keys. Reward accounting
   (`KeeperReward`) and stake accounting (`KeeperStake`) can never touch or
   corrupt each other's balances.
3. **Solvency Guarantee**: All token deposits transfer into the contract's
   escrow balance, tracked by rigorous mathematical invariants.

---

## 4. Unbonding Mechanics

### 4.1 The Need for an Unbonding Delay

If a keeper could withdraw stake instantaneously, the staking guarantee would
be economically meaningless: a malicious keeper could submit a fraudulent proof
in transaction $N$, and immediately invoke `withdraw_stake` in transaction $N+1$
before the task owner or dispute monitor can inspect the proof.

### 4.2 Unbonding Rules and Lifecyle

1. **Unbonding Request (`initiate_unbond`)**:
   - A keeper specifies an `amount` to unbond.
   - The unbonding amount is immediately deducted from `KeeperStake(keeper)`.
   - The unbonding amount is credited to `UnbondingStake(keeper)` with an
     expiration watermark: `unlock_ledger = current_ledger + unbonding_delay_ledgers`.
2. **Immediate Loss of Active Claim Power**:
   - The moment unbonding is initiated, the funds no longer count towards the
     keeper's active stake. If the remaining active stake drops below
     `min_stake`, subsequent `claim_task` calls will fail with
     `KeeperError::InsufficientStake`.
3. **Delay Duration**:
   - `unbonding_delay_ledgers` is configurable by admin (default: `17,280` ledgers,
     approximately 24 hours at 5 seconds per ledger).
4. **Final Withdrawal (`withdraw_stake`)**:
   - Only succeeds if `current_ledger >= unlock_ledger`.
   - Transfers the unbonded token amount from contract escrow back to the keeper's
     Stellar address.

```text
┌────────────────┐     initiate_unbond()     ┌────────────────┐     current_ledger >= unlock     ┌────────────────┐
│  Active Stake  │ ────────────────────────▶ │ Unbonding Pool │ ────────────────────────────────▶ │ Keeper Wallet  │
│  (Backs Tasks) │   (deducted immediately)  │ (Locked Delay) │         withdraw_stake()          │  (Liquid XLM)  │
└────────────────┘                           └────────────────┘                                   └────────────────┘
```

---

## 5. Dispute Window & Resolution

### 5.1 Dispute Period Mechanics

To enable dispute-based slashing without blocking keeper liquidity forever:
1. **Execution Watermark**: When `execute_task` completes, the task record is
   annotated with `executed_ledger = current_ledger`.
2. **Dispute Window**: For `dispute_window_ledgers` (default: `1,200` ledgers ~ 100
   minutes), the task remains open to disputes.
3. **Reward Holding**:
   - The keeper's earned reward for this specific task remains in a pending
     state (`DataKey::PendingReward(task_id)`), preventing immediate withdrawal
     via `withdraw_rewards` until the window lapses.
   - Once `current_ledger > executed_ledger + dispute_window_ledgers`, the reward
     automatically matures and can be withdrawn.

### 5.2 Dispute Raising and Arbitration

1. **Who can raise a dispute (`raise_dispute`)**:
   - The `Task.owner` who funded the task.
   - A designated protocol `DisputeResolver` or the contract `Admin`.
2. **Dispute Collateral / Bond**:
   - To prevent griefing disputes against honest keepers, raising a dispute
     requires posting a dispute bond (`dispute_bond`).
   - If the dispute is frivolous, the bond is forfeited to the keeper.
3. **State While Dispute is Pending**:
   - The task transitions to `TaskStatus::Disputed`.
   - The keeper's reward for that task remains locked.
   - The keeper cannot unbond stake while an active dispute is pending.
4. **Resolution (`resolve_dispute`)**:
   - Authorized by `Admin` or multi-sig `DisputeResolver`.
   - **Dispute Upheld (Keeper at fault)**:
     - Keeper is slashed for `slash_amount`.
     - Task reward is refunded to task owner.
     - Slashed stake is distributed: restitution to owner + fee to protocol treasury.
     - Dispute bond returned to challenger.
   - **Dispute Dismissed (Keeper honest)**:
     - Task transitions to `Executed`.
     - Keeper reward is released for withdrawal.
     - Challenger's dispute bond is awarded to the keeper for griefing compensation.

---

## 6. Interaction with Existing Mechanics

### 6.1 `claim_task` Eligibility

1. **Configurable Minimum Stake (`min_stake`)**:
   - Admin configures `min_stake` via `set_min_stake(admin, min_stake)`.
   - Default value: `0` (opt-in staking, backward compatible with existing testnets).
2. **Enforcement**:
   - If `min_stake > 0`: `claim_task` queries `keeper_stake(keeper)`. If
     `active_stake < min_stake`, the transaction reverts with
     `KeeperError::InsufficientStake`.
3. **Lock Windows and Execution Parity**:
   - In version 1, all keepers meeting `min_stake` operate under identical
     rules: same `lock_ledgers` duration, same fee structures.
   - Staked keepers do not receive artificial execution priority in the contract
     (preserving the core architectural invariant I-5 of open, fair competition).

---

## 7. Storage Layout, Error Variants, and Interface Signatures

### 7.1 Storage Layout (`DataKey` Additions)

```rust
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // Existing keys
    Admin,
    FeeBps,
    Paused,
    TaskCounter,
    RewardToken,
    Task(u64),
    KeeperReward(Address),
    FeesAccrued,
    MinReward,

    // ─── E06 Staking Storage Keys ───
    /// Active stake collateral per keeper.
    KeeperStake(Address),
    /// Pending unbonding records per keeper.
    UnbondingStake(Address),
    /// Global minimum stake floor required to claim tasks.
    MinStake,
    /// Configured unbonding delay in ledgers.
    UnbondingDelay,
    /// Configured dispute window in ledgers following task execution.
    DisputeWindow,
    /// Dispute record for a disputed task.
    TaskDispute(u64),
    /// Pending reward holding record prior to dispute window expiry.
    PendingReward(u64),
}

/// Unbonding record tracking in-flight stake withdrawals.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnbondingRecord {
    pub amount: i128,
    pub unlock_ledger: u32,
}

/// Dispute status and metadata.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeRecord {
    pub task_id: u64,
    pub challenger: Address,
    pub keeper: Address,
    pub bond_amount: i128,
    pub created_ledger: u32,
    pub resolved: bool,
}
```

### 7.2 Error Variants (`KeeperError` Additions)

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum KeeperError {
    // Existing variants 1..27 ...

    // ─── E06 Staking Errors ───
    /// Keeper active stake is below the required minimum stake floor.
    InsufficientStake = 28,
    /// Stake withdrawal requested before the unbonding delay has elapsed.
    UnbondingNotReady = 29,
    /// An unbonding request is already in progress for this keeper.
    UnbondingAlreadyPending = 30,
    /// No unbonding record exists for this keeper.
    NoUnbondingRecord = 31,
    /// Operation disallowed while a task dispute is active.
    DisputePeriodActive = 32,
    /// Dispute does not exist or has already been resolved.
    DisputeNotFound = 33,
    /// Stake deposit or unbond amount must be strictly positive.
    InvalidStakeAmount = 34,
    /// Caller is not authorized to raise or resolve a dispute.
    UnauthorizedDispute = 35,
    /// Task has already passed its dispute window.
    DisputeWindowExpired = 36,
}
```

### 7.3 Entry Point Signatures

```rust
pub trait IKeeperStaking {
    /// Post collateral into active keeper stake.
    fn stake_deposit(env: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;

    /// Initiate unbonding for an amount of active stake.
    fn initiate_unbond(env: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;

    /// Withdraw matured unbonded stake back to the keeper's wallet.
    fn withdraw_stake(env: Env, keeper: Address) -> Result<i128, KeeperError>;

    /// Slash a keeper's stake following an authorized dispute or governance action.
    fn slash(
        env: Env,
        admin: Address,
        keeper: Address,
        amount: i128,
        reason: Symbol,
    ) -> Result<(), KeeperError>;

    /// Query the current active stake of a keeper.
    fn keeper_stake(env: Env, keeper: Address) -> i128;

    /// Query any active unbonding record for a keeper.
    fn keeper_unbonding_stake(env: Env, keeper: Address) -> Option<UnbondingRecord>;

    /// Set the minimum stake floor required to claim tasks.
    fn set_min_stake(env: Env, admin: Address, min_stake: i128) -> Result<(), KeeperError>;

    /// Read the minimum stake floor.
    fn get_min_stake(env: Env) -> i128;

    /// Raise a dispute against an executed task within the dispute window.
    fn raise_dispute(env: Env, challenger: Address, task_id: u64, reason: Bytes) -> Result<(), KeeperError>;

    /// Resolve an open dispute.
    fn resolve_dispute(env: Env, admin: Address, task_id: u64, slash_keeper: bool) -> Result<(), KeeperError>;
}
```

### 7.4 Event Topics and Payloads

Following the standard `(verb, noun)` topic convention:

| Event | Topics | Data Payload |
| :--- | :--- | :--- |
| `StakeDeposited` | `("stake", "deposit")` | `(keeper: Address, amount: i128)` |
| `UnbondInitiated` | `("stake", "unbond")` | `(keeper: Address, amount: i128, unlock_ledger: u32)` |
| `StakeWithdrawn` | `("stake", "withdraw")` | `(keeper: Address, amount: i128)` |
| `KeeperSlashed` | `("stake", "slash")` | `(keeper: Address, amount: i128, reason: Symbol)` |
| `DisputeRaised` | `("dispute", "raised")` | `(task_id: u64, keeper: Address, challenger: Address)` |
| `DisputeResolved`| `("dispute", "resolved")`| `(task_id: u64, keeper: Address, slashed: bool)` |

---

## 8. Summary of Decisions

| Architectural Question | Decision | Rationale |
| :--- | :--- | :--- |
| **What counts as slashable?** | Dispute-based in v1 (fraudulent proofs, malicious task squatting, equivocation). | Prevents griefer task owners from weaponizing reverting verifiers against honest keepers. |
| **Dependency on Epic E04?** | No dependency on automatic on-chain verifier slashing. | Post-execution dispute window provides robust economic security without waiting for complex zk/oracle on-chain verifiers. |
| **Where does stake live?** | In-contract storage with isolated `DataKey` entries. | Eliminates cross-contract call gas overhead during high-frequency claims; ensures atomic state consistency. |
| **Unbonding policy?** | Mandatory delay (`unbonding_delay_ledgers`, default ~24h). | Prevents keepers from front-running disputes and draining collateral immediately after fraudulent execution. |
| **Dispute window?** | Bounded challenge period (`dispute_window_ledgers`, default ~100 min) with held rewards. | Provides task owners sufficient time to challenge bad proofs before rewards leave contract escrow. |
| **Claiming interaction?** | Configurable `min_stake` floor (default 0). | Backwards-compatible; when set, prevents uncollateralized bots from hoarding task claims. |

---

## 9. Implementation Roadmap (Epics 0289–0316)

1. **0289**: Stake storage and the `stake_deposit` entry point (`KeeperStake` storage key, event, tests).
2. **0290**: Unbonding delay implementation (`initiate_unbond`, `withdraw_stake`, ledger boundary tests).
3. **0291**: Slash entry point and authorization model (penalty routing to treasury/owner).
4. **0292**: Minimum stake requirement in `claim_task`.
5. **0293**: Dispute window between execution and reward finality (`PendingReward`, dispute flow).
6. **0294–0316**: Solvency property tests, storage TTL extensions, indexer schema, and SDK bindings.
