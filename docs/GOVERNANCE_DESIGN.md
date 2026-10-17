# Governance Design (Epic E09, Issue #488)

## Status

Decided and foundational specification for Epic E09. This document defines the architecture, parameters, and migration path for the Soroban Keeper Network governance system ($KPRS token, proposal life cycle, voting engine, timelock, and admin transition). Subsequent issues in Epic E09 implement the token contract (#489 / 0361), governance scaffold (#490 / 0362), proposal state engine (#491 / 0363), voting logic (#492 / 0364), execution cross-contract calls (#493 / 0367), and the checks-effects-interactions review (#499 / 0373).

---

## 1. Context & Motivation

Today, administrative control over the Soroban Keeper Network resides in a single privileged admin address across two core contracts:

1. **`KeeperRegistry` (`contracts/keeper-registry`)**:
   - `set_fee_bps`: sets platform execution fee.
   - `set_min_reward`: sets minimum reward required to register a task.
   - `set_reputation_floor`: sets keeper eligibility floor.
   - `pause` / `unpause`: emergency circuit breaker.
   - `sweep_fees`: transfers accrued protocol revenue to treasury.
   - `transfer_admin`: transfers control to a new address.
   - `upgrade`: installs new contract WASM byte code.

2. **`Treasury` (`contracts/treasury`)**:
   - `add_recipient`: adds recipient and assigns revenue shares.
   - `remove_recipient`: removes recipient from revenue sharing.
   - `update_recipient_shares`: modifies allocation weights.
   - `pause` / `unpause`: emergency pause on fee distributions.
   - `transfer_admin`: transfers treasury control to a new address.
   - `upgrade`: installs new treasury WASM byte code.

While this single-admin model was necessary during initial development, it constitutes a single point of failure and centralization risk. Epic E09 decentralizes protocol ownership by introducing a governance token (**$KPRS**) and a decentralized on-chain governance contract that token holders control.

---

## 2. Token Supply & Distribution ($KPRS)

### 2.1 Token Economics & Identity

| Property | Value | Rationale |
|---|---|---|
| **Token Name** | Keeper Network Governance Token | Canonical protocol name |
| **Symbol** | `$KPRS` | Standard protocol ticker |
| **Standard** | Soroban Token Interface (SEP-41 compatible) | Seamless integration with existing Stellar wallets, SDKs, and DeFi tooling |
| **Decimals** | 7 | Matches Soroban native XLM / stroop precision (1 KPRS = 10,000,000 base units) |
| **Total Supply** | 100,000,000 KPRS (`1_000_000_000_000_000` base units) | Fixed supply, no inflation in v1 |

### 2.2 Initial Allocation

The 100,000,000 $KPRS supply is minted in full at contract initialization and partitioned across four distinct allocations:

```
┌─────────────────────────────────────────────────────────────────┐
│                    $KPRS TOTAL SUPPLY: 100M                     │
├──────────────────┬─────────────────┬──────────────┬─────────────┤
│ Early Keepers &  │ DAO Treasury &  │ Core Team &  │ Public /    │
│ Community (40%)  │ Ecosystem (25%) │ Contributors │ Liquidity   │
│ 40,000,000 KPRS  │ 25,000,000 KPRS │ (20%) - 20M  │ (15%) - 15M │
└──────────────────┴─────────────────┴──────────────┴─────────────┘
```

1. **40% (40,000,000 KPRS) — Early Keepers & Community Retroactive Airdrop**:
   - Allocated to keepers based on historical on-chain execution and reputation history from Epic E07.
   - Keepers with proven reliability receive immediate voting power to govern the network they operate.
   - Unclaimed tokens after 180 days revert to the DAO Treasury pool.

2. **25% (25,000,000 KPRS) — DAO Treasury & Protocol Reserve**:
   - Held directly by the `Treasury` contract for long-term keeper incentives, public goods funding, security audits, and bug bounties.
   - Spent only through passed governance proposals.

3. **20% (20,000,000 KPRS) — Core Team & Founding Contributors**:
   - Subject to strict on-chain vesting: 2-year linear vesting with a 6-month cliff from initialization.
   - Unvested tokens are locked by the token contract logic and cannot be transferred or sold, but may participate in voting via snapshot delegations.

4. **15% (15,000,000 KPRS) — Public Distribution & Ecosystem Liquidity**:
   - Liquid allocation to seed secondary automated market makers (AMMs) on Soroban / Stellar DEX and facilitate broad decentralized distribution.

### 2.3 On-Chain Vesting Enforcement

Vesting is enforced directly in `contracts/governance-token/src/lib.rs` (Issue #489):
- Unvested balances are tracked on-chain with `start_timestamp`, `cliff_duration`, and `total_vesting_duration`.
- The token transfer entry point (`transfer` / `transfer_from`) calculates:
  $$\text{claimable}(t) = \begin{cases} 0 & \text{if } t < \text{start} + \text{cliff} \\ \text{total} \times \frac{t - \text{start}}{\text{duration}} & \text{if } \text{cliff} \le t < \text{start} + \text{duration} \\ \text{total} & \text{if } t \ge \text{start} + \text{duration} \end{cases}$$
- Any transfer exceeding the vested balance is rejected with `TokenError::TokensLocked`.
- Vesting is an enforced smart contract rule, never an off-chain promise.

### 2.4 Retroactive Keeper Allocation: Snapshot & Claim Specification (Issue #506)

Issue 0360 dedicated **40% of the initial supply (40,000,000 $KPRS)** to early keepers and community contributors based on verified execution and reliability history. This section specifies the exact snapshot criteria, the deterministic activity conversion formula, and the gas-efficient Merkle-proof claim mechanism.

#### 2.4.1 Eligibility Snapshot & Cutoff Point

1. **Source of Truth**:
   - The canonical Stellar ledger history ingested by the Keeper Network Indexer (`indexer/postgres`).
   - The primary data source is the indexed `task_executed` events emitted by `KeeperRegistry`:
     - Contract: `REGISTRY_CONTRACT_ID`
     - Topic: `(Symbol::new(&env, "task_executed"), task_id: u64, keeper_address: Address)`
     - Data: `{ reward_stroops: i128, execution_duration: u64, proof_hash: BytesN<32> }`
   - Cross-referenced with the reputation scores derived in Epic E07 (Issues #318–#321), verifying sustained availability and task completion integrity.

2. **Snapshot Boundary**:
   - **Genesis Sequence (`ledger_genesis`)**: The ledger sequence of the initial `KeeperRegistry` contract deployment on Stellar Mainnet.
   - **Cutoff Sequence (`ledger_cutoff`)**: The exact ledger sequence where the $KPRS Token contract (`contracts/governance-token`) is deployed and initialized (`DataKey::Initialized`).
   - Any task execution occurring after `ledger_cutoff` earns standard runtime execution rewards only and is ineligible for the retroactive genesis token distribution.

3. **Deterministic Activity Conversion Formula**:
   To prevent sybil manipulation (such as self-dealing zero-value dust tasks) while rewarding genuine operational service:
   - **Minimum Eligibility Threshold**: A keeper must have executed at least **10 successful tasks** across distinct task creators or maintained a continuous uptime/reputation score $\ge 50$ (per Epic E07).
   - **Keeper Activity Score ($S_k$)**:
     $$S_k = \left( N_k \times w_{\text{count}} \right) + \left( \log_{10}(V_k + 1) \times w_{\text{vol}} \right) + \left( R_k \times w_{\text{rep}} \right)$$
     where:
     - $N_k$ = verified execution count in the snapshot window.
     - $V_k$ = total task reward volume processed by keeper $k$ (in stroops).
     - $R_k$ = historical reputation score $\in [0, 100]$ at cutoff.
     - Weights: $w_{\text{count}} = 1.0$, $w_{\text{vol}} = 0.5$, $w_{\text{rep}} = 2.0$.
   - **Individual Keeper Allocation ($A_k$)**:
     $$A_k = 40{,}000{,}000\text{ KPRS} \times \frac{S_k}{\sum_{j} S_j}$$
   - Computed allocations are normalized, floored to 7 decimals (`base units`), with any rounding remainder allocated to the DAO Treasury.

4. **Auditability & Determinism**:
   - The snapshot computation is implemented as a deterministic query over the indexed database history:
     ```sql
     SELECT keeper_address, count(*) AS executions, sum(reward_stroops) AS volume
     FROM task_executions
     WHERE ledger_sequence <= :ledger_cutoff
     GROUP BY keeper_address
     HAVING count(*) >= 10;
     ```
   - Given the database dump or RPC replay up to `ledger_cutoff`, any validator, operator, or token holder can reproduce the exact list of `(address, allocation)` pairs bit-for-bit.

#### 2.4.2 Claim Architecture: Merkle-Proof Distribution

Rather than storing thousands of individual allocation balances in on-chain instance storage (which would cause exorbitant ledger rent and transaction gas costs), the retroactive allocation uses a **Merkle Distributor Contract** (`contracts/merkle-distributor`):

```
┌─────────────────────────────────────────────────────────────────┐
│                 Merkle Tree Root (32-byte hash)                 │
│              Stored on-chain in contract storage                │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       Intermediate Hash               Intermediate Hash
         ┌───────┴───────┐               ┌───────┴───────┐
         ▼               ▼               ▼               ▼
     Leaf(A, amt)    Leaf(B, amt)    Leaf(C, amt)    Leaf(D, amt)
```

1. **Leaf Format**:
   - Standard double-hash format to prevent second-preimage vulnerabilities:
     $$\text{Leaf}_k = \text{SHA-256}\left( \text{claimant\_address} \parallel \text{amount\_stroops} \right)$$
   - Both `claimant_address` (Stellar `Address` / 32-byte StrKey pubkey) and `amount_stroops` (`i128`) are serialized using standard canonical big-endian XDR bytes.

2. **On-Chain Verification & Claim Entry Point**:
   ```rust
   pub fn claim(
       env: Env,
       claimant: Address,
       amount: i128,
       proof: Vec<BytesN<32>>,
   ) -> Result<(), DistError>;
   ```
   - **Authentication**: `claimant.require_auth()` guarantees only the eligible keeper key can initiate the claim.
   - **Double-Claim Protection**: The contract tracks claimed status via persistent storage:
     `env.storage().persistent().has(&DataKey::Claimed(claimant))`
     If already claimed, reverts with `DistError::AlreadyClaimed`.
   - **Proof Validation**: The contract recomputes the Merkle root from the leaf and `proof` hashes. If `computed_root != stored_root`, reverts with `DistError::InvalidProof`.
   - **Direct Transfer**: Invokes `token.transfer(&distributor_address, &claimant, &amount)`. Tokens are delivered directly into the keeper's address, instantly granting voting power.

3. **Claim Window & DAO Treasury Reversion**:
   - **180-Day Claim Period**: Keepers have **180 calendar days** (~2,592,000 ledgers) from distributor deployment to submit their claim.
   - **Permissionless Sweep**: Once the claim period expires (`now >= deploy_timestamp + 180 days`), any caller may invoke `sweep_unclaimed()`.
   - **Reversion Destination**: All remaining unclaimed KPRS tokens are transferred directly to the `Treasury` contract balance, dedicated to future ecosystem incentives and DAO-directed bounties. No retroactive tokens are burned or permanently locked.

---

## 3. Proposal Mechanism & Governable Parameters

### 3.1 Proposal Creation Threshold

- **Who can propose**: Any account holding at least **100,000 KPRS** (0.1% of total supply) at the ledger of proposal creation.
- **Rationale**: A 0.1% threshold prevents griefing and proposal spam while ensuring active keepers and token holders can freely raise proposals without prohibitive capital requirements.

### 3.2 Closed Enumeration of Governable Parameters (v1)

Open-ended "arbitrary contract execution" (e.g. passing arbitrary target addresses and byte calldata) is explicitly **rejected** for v1. Arbitrary calls introduce opaque attack vectors, reentrancy risks, and validation bypasses.

Instead, v1 governs an **explicit, closed enum of parameter changes**:

```rust
pub enum GovernanceAction {
    // ── Registry Parameters ──
    SetFeeBps(u32),
    SetMinReward(i128),
    SetReputationFloor(u32),
    PauseRegistry,
    UnpauseRegistry,

    // ── Treasury Parameters ──
    AddTreasuryRecipient { recipient: Address, shares_bps: u32 },
    RemoveTreasuryRecipient { recipient: Address },
    UpdateTreasuryShares { recipient: Address, new_shares_bps: u32 },
    PauseTreasury,
    UnpauseTreasury,

    // ── Meta-Governance (Governance Contract itself) ──
    SetVotingPeriod(u32),
    SetTimelockDelay(u32),
    SetQuorumBps(u32),
    SetProposalThreshold(i128),

    // ── Contract Upgrades ──
    UpgradeRegistry(BytesN<32>),
    UpgradeTreasury(BytesN<32>),
}
```

### 3.3 Safety Boundaries & Parameter Validation

Every parameter is strictly validated upon proposal creation AND before execution:

| Parameter | Allowed Range | Validation Rule | Impact |
|---|---|---|---|
| `SetFeeBps` | `0..=10_000` (0% to 100%) | Must satisfy registry invariant `new_bps <= 10_000` | Adjusts platform fee on future task executions |
| `SetMinReward` | `0..=i128::MAX` | Must be `>= 0` | Protects keeper economic viability |
| `SetReputationFloor` | `0..=MAX_REPUTATION_FLOOR_BPS` | Must not exceed `10_000` bps | Tunes task claiming barrier |
| `AddTreasuryRecipient` | `shares_bps in 1..=MAX_SHARES_BPS` | Recipient count `< MAX_RECIPIENTS` | Directs fee distribution to verified recipients |
| `UpdateTreasuryShares` | `shares_bps in 1..=MAX_SHARES_BPS` | Total shares within `MAX_TOTAL_SHARES` | Tunes distribution weights |
| `SetVotingPeriod` | `14_400..=201_600` ledgers (1 to 14 days) | Prevents voting freezes or instantaneous votes | Sets proposal voting duration |
| `SetTimelockDelay` | `14_400..=86_400` ledgers (1 to 6 days) | Cannot be reduced below 24 hours | Protects user exit window |
| `SetQuorumBps` | `100..=2_000` (1% to 20%) | Ensures meaningful quorum | Guards against minority takeovers |

---

## 4. Voting Power & Quorum

### 4.1 Voting Power Mechanism

- **Weighting**: **1 KPRS = 1 Vote**.
- **Snapshot Ledger**: Voting power is snapshot at the exact `ledger_sequence` when the proposal is registered.
- **Flash-Loan Resistance**: Borrowing or purchasing tokens after a proposal is submitted confers zero voting power for that proposal.
- **Single Vote Casting**: An account can vote `For`, `Against`, or `Abstain`. Once cast, a vote is final and cannot be duplicated or retracted.

### 4.2 Voting Period

- **Default Duration**: **7 days** (~100,800 ledgers assuming standard 6-second ledger close times on Stellar).
- **Rationale**: 7 days allows keepers and global token holders across time zones sufficient time to inspect, debate, and cast votes without rushing.

### 4.3 Quorum & Passing Thresholds

- **Quorum Requirement**: **4% of Total Supply (4,000,000 KPRS / 400 bps)**.
  - Calculated as: $\text{Total Participating Votes} = \text{Votes}_{\text{For}} + \text{Votes}_{\text{Against}} + \text{Votes}_{\text{Abstain}} \ge 4{,}000{,}000\text{ KPRS}$.
  - If quorum is not met by the end of the voting period, the proposal fails automatically (`Defeated`).
- **Passing Threshold**: **Simple Majority of Non-Abstaining Votes (> 50%)**.
  - Calculated as: $\text{Votes}_{\text{For}} > \text{Votes}_{\text{Against}}$.
  - Abstain votes count towards quorum but do not affect the For/Against majority ratio.

---

## 5. Timelock & Execution Architecture

### 5.1 Timelock Duration

- **Delay**: **48 Hours** (~28,800 ledgers) from the moment a proposal successfully passes until it is eligible for execution.
- **Why Timelock Is Mandatory**:
  - In a decentralized system, sudden parameter changes (such as fee increases or contract upgrades) must not catch users off guard.
  - A 48-hour delay provides task creators and keepers an unassailable window to:
    - Cancel tasks and recover escrow (`cancel_task` / `expire_task`).
    - Withdraw earned rewards (`withdraw_rewards`).
    - Initiate keeper stake unbonding (`initiate_unbond`).
  - If a governance attack or compromised proposal passes, affected stakeholders can safely exit before the change executes.

### 5.2 Permissionless Execution

- **Trigger**: Once the 48-hour timelock elapses, **anyone** may call `execute_proposal(proposal_id)`.
- **No Autonomous Scheduler**: Soroban has no automatic background cron. Making execution permissionless ensures liveness — any keeper, proposer, or bot can trigger execution without relying on a trusted coordinator.

### 5.3 Checks-Effects-Interactions (CEI) & Reentrancy Defense

Cross-contract execution into `KeeperRegistry` or `Treasury` follows strict Checks-Effects-Interactions ordering (dedicated security review in Issue #499):

```
┌───────────────────────────────────────────────────────────┐
│ 1. CHECKS: Validate status == Queued && now >= ETA        │
├───────────────────────────────────────────────────────────┤
│ 2. EFFECTS: Write status = Executed to instance storage   │
├───────────────────────────────────────────────────────────┤
│ 3. INTERACTIONS: Dispatch cross-contract invocation       │
│    (e.g., registry.set_fee_bps(new_bps))                  │
└───────────────────────────────────────────────────────────┘
```

1. **State updated before dispatch**: Proposal state is recorded as `Executed` in storage **before** invoking the external contract. This eliminates double-execution and cross-contract reentrancy risks.
2. **Deterministic Error Handling**: If the downstream cross-contract call fails (e.g. underlying contract panics), Soroban rolls back the entire transaction atomic ledger state, returning an error to the caller without corrupting proposal state.

---

## 6. Migration Path: From Admin Key to Governance

The transition from the current single-admin model to the decentralized governance contract occurs in 4 explicit, verifiable stages:

```
[Phase 1: Deployment]
  Deploy $KPRS Token Contract -> Mint Initial Supply -> Deploy Governance Contract
             │
[Phase 2: Authorization Handshake]
  Current Admin calls registry.transfer_admin(admin, governance_contract)
  Governance Contract authorizes receipt via accept_admin
             │
[Phase 3: Treasury Handshake]
  Current Admin calls treasury.transfer_admin(admin, governance_contract)
  Governance Contract authorizes receipt via accept_admin
             │
[Phase 4: Complete Decentralization]
  Single admin key permanently relinquished; all parameters governed by $KPRS proposals
```

### 6.1 The Two-Sided Authorization Handshake

Both `KeeperRegistry::transfer_admin` and `Treasury::transfer_admin` require:
```rust
require_admin(&e, &admin)?;
new_admin.require_auth();
```
Because `new_admin` must authorize the transfer, the governance contract exposes an explicit `accept_admin(contract: Address)` entry point:
1. Current admin invokes `governance.accept_admin(registry_address)`.
2. Inside `accept_admin`, the governance contract invokes `registry.transfer_admin(admin, governance_address)`.
3. Because the governance contract is executing the call, its own authorization (`governance.require_auth()`) is granted.
4. Control passes cleanly to the governance contract address.

### 6.2 Verifiability

A dedicated test suite in `contracts/governance/src/test.rs` verifies that:
- Prior to transfer, the original admin can modify parameters and governance cannot.
- Following `transfer_admin`, the original admin's calls fail with `KeeperError::Unauthorized`.
- Parameter changes succeed only when dispatched from the governance contract through a passed, timelocked proposal.

---

## 7. Security Invariants & Invariant Preservation

1. **Escrow Invariant I-1 Untouched**:
   Governance has zero access to task escrow or keeper balances. All governable functions affect parameter boundaries only; governance has no capability to withdraw or redirect user escrowed funds.
2. **Reentrancy Immunity**:
   Proposal state transitions (`Active` $\to$ `Succeeded` $\to$ `Queued` $\to$ `Executed`) are strictly monotonic and checked prior to external calls.
3. **Upgrade Transparency**:
   Any proposed contract upgrade (`UpgradeRegistry` or `UpgradeTreasury`) must publish the target WASM hash 48 hours in advance through the timelock, allowing full public bytecode auditing before activation.

---

## 8. Summary of Specification Decisions

| Dimension | Decision | Rationale |
|---|---|---|
| **Token Standard** | Standard Soroban Fungible Token (SEP-41) | Interoperable across Stellar ecosystem, wallets, and DEXs |
| **Total Supply** | 100,000,000 $KPRS (fixed) | Predictable, inflation-free governance base |
| **Vesting** | 2-year linear, 6-month cliff for team (20%) | Enforced directly in contract code |
| **Retroactive Keeper Allocation** | 40% (40M KPRS) via Merkle distributor | Deterministic snapshot from indexer; 180-day claim window; unclaimed reverts to DAO Treasury |
| **Proposal Threshold**| 100,000 KPRS (0.1% supply) | High enough to prevent spam; low enough to be accessible |
| **Governable Scope** | Closed, enumerated parameter enum (v1) | Eliminates arbitrary execution attack surface |
| **Voting Mechanism** | 1 token = 1 vote at snapshot ledger | Prevents flash-loan manipulation; simple & verifiable |
| **Voting Window** | 7 days (100,800 ledgers) | Ample time for distributed stakeholder deliberation |
| **Quorum** | 4% of total supply (4,000,000 KPRS) | Ensures legitimate stakeholder representation |
| **Pass Threshold** | Simple majority (> 50% For of For+Against) | Standard, unambiguous decision boundary |
| **Timelock** | 48 hours (28,800 ledgers) | Gives task owners and keepers time to exit before changes |
| **Execution** | Permissionless after timelock | Guarantees liveness without trusted actors |
| **Migration** | `transfer_admin` handshake to governance address | Completely eliminates single-admin key dependency |
