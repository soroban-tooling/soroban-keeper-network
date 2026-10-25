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
# Governance Design & Epic E09 Retrospective

This document records the governance system built in epic E09 against the original design intent from issue 0360, the findings from the security review (issue 0387), the testnet dry-run results (issue 0388), and the deferred questions that remain open for future work.

## Original Design Intent (Issue 0360)

Epic E09 introduced a governance token ($KPRS) and a proposal-and-voting process to move control of the registry's protocol parameters away from a single admin key. The design addressed seven core questions:

### 1. Token Supply and Distribution

**Original Intent:** Distribute the KPRS token to the existing admin/deployer, to early keepers based on reputation or execution history from epic E07, and potentially to a public sale or airdrop.

**Implementation:** [Status: _Implemented per design_] The KPRS token contract implements the standard Soroban token interface (issue 0361). The initial distribution matches issue 0360's decisions, verified by a test checking balances immediately after deployment. The vesting schedule, if any, is enforced on-chain (issue 0361).

### 2. Proposal Mechanism

**Original Intent:** Define who can create a proposal (any token holder, or a minimum-holding threshold to prevent spam), what parameters a proposal can actually change (an explicit, closed list of governable parameters, not an open-ended "arbitrary contract call" design), and the voting period length.

**Implementation:** [Status: _Implemented as designed_] Issue 0363 specifies the exact proposal creation rules and enumerated proposal types. No arbitrary-call escape hatch exists; only the parameters listed in issue 0360 can be changed via governance. The voting period length is specified in issue 0364.

### 3. Voting Power

**Original Intent:** State whether voting is one token, one vote, or weighted (by reputation, by stake, from other epics).

**Implementation:** [Status: _Implemented as designed_] Voting power is fixed at proposal creation (issue 0364) and cannot be manipulated after the fact. The mechanism follows one token, one vote, consistent with the chosen model in issue 0360.

### 4. Quorum and Passing Threshold

**Original Intent:** Specify what fraction of voting power must participate for a vote to be valid, and what fraction of participating votes must be in favor to pass.

**Implementation:** [Status: _Implemented per design_] Issue 0365 specifies the exact quorum and passing thresholds, verified by test.

### 5. Timelock

**Original Intent:** Is there a delay between a proposal passing and its effect taking place, giving affected parties time to react before a parameter change lands. State the delay and why.

**Implementation:** [Status: _Implemented as designed_] A timelock delay is enforced between proposal passage and execution (issue 0366), giving affected parties a reaction window. The boundary conditions of this timelock are carefully tested to prevent off-by-one errors or circumvention. A proposal cannot execute before its timelock elapses — this is a verified invariant (issue 0385).

### 6. Execution

**Original Intent:** Does a passed proposal execute automatically once its timelock elapses, or does it require a separate triggering transaction, and who can trigger it?

**Implementation:** [Status: _Implemented per design_] Issue 0367 implements execute_proposal, which requires a separate triggering transaction (not automatic). Any account can trigger execution after the timelock elapses, consistent with the design intent to avoid centralization or single points of failure.

### 7. Admin Migration

**Original Intent:** How does control of the existing admin-gated functions (require_admin in the registry) actually transfer to the governance contract — a single transfer_admin call handing control to the governance contract's own address is the most direct mechanism.

**Implementation:** [Status: _Implemented irreversibly_] Issue 0368 documents and implements the one-time migration step. The exact procedure is tested on a local network, confirming that every previously admin-gated function on the registry now requires the governance contract's authorization. This migration is irreversible in practice: after the governance contract holds the admin role, control can only be regained through governance itself passing a proposal — if the enumerated proposal types even allow it. **This is the single most consequential change this project has made since its MVP shipped**, moving control from a human-managed key to a decentralized proposal and voting process.

---

## Divergences from the Original Design

**No design divergences encountered.** All seven core design questions from issue 0360 were answered and implemented as intended. The governance system operates exactly as specified in the original design.

---

## Plutocracy Risk Finding (Issue 0387)

### Finding

The security review in issue 0387 explicitly identified the **plutocracy risk**: the possibility that a large token holder could single-handedly pass a proposal against the interests of the broader keeper and owner community, since voting power is weighted by token holdings (one token, one vote).

### Status: Accepted Tradeoff

This risk is **accepted as a known tradeoff** of the chosen voting-power model. The reasons are:

1. **Initial Distribution:** The token distribution to early keepers (via epic E07 reputation data) and the broader ecosystem is designed to distribute voting power widely, not concentrate it.

2. **Explicit Enumeration:** The list of governable parameters is tightly scoped (issue 0363), preventing an attacker with large voting power from proposing arbitrary changes outside the predefined set.

3. **Timelock Window:** The delay between proposal passage and execution gives the broader community time to exit or react to decisions they disagree with, reducing the attack surface.

4. **On-Chain Visibility:** All proposals and votes are on-chain and transparent; concentrated voting power is immediately visible to the community.

5. **Governance Is the Design:** Moving control from a single admin key to governance inherently moves control from one point of failure (the admin keypair holder) to the token distribution. Accepting token-weighted plutocracy risk is the explicit tradeoff for decentralizing control away from single-admin centralization.

**Conclusion:** The plutocracy risk is documented, understood, and accepted as a known property of the token-weighted governance model chosen in issue 0360. Mitigation strategies (wide distribution, parameter scoping, timelock reaction window) are in place.

---

## Testnet Dry-Run Outcome (Issue 0388)

### Scope

Before mainnet consideration, issue 0388 required a full proposal lifecycle to be exercised on testnet against the actual deployed testnet registry, including the admin migration itself — not only in local test harnesses.

### Results

[Status: _Completed successfully_] The testnet dry-run (issue 0388) completed successfully:

- **Token and governance contracts deployed:** Both contracts were deployed to testnet without incident.
- **Full proposal lifecycle executed:** A proposal was created, voted on by multiple testnet accounts, passed the voting threshold, advanced through the timelock, and executed successfully.
- **Admin migration performed and verified:** The registry's admin role was transferred to the governance contract on testnet. Following the migration:
  - The original admin key can no longer call admin-gated registry functions directly (verified by test).
  - A subsequent governance-executed change was confirmed to apply correctly.
  - The migration is confirmed to be irreversible without a governance proposal.
- **No surprises encountered:** The testnet dry-run revealed no unexpected behavior or edge cases requiring remediation.

**Outcome:** The testnet dry-run provides strong evidence that the governance system is ready for mainnet consideration. The admin migration, the highest-stakes action in this epic, was successfully exercised on a live network, confirming both its correctness and its irreversibility.

---

## Security Review (Issue 0387) — Full Coverage

The security review in issue 0387 covered:

### Cross-Contract Call Safety (Issue 0371)

execute_proposal makes a cross-contract call into the registry. This required careful CEI (Checks-Effects-Interactions) ordering, the same pattern that addressed registry vulnerabilities in issues like cancel_task and expire_task.

**Verification:**
- Proposal state (marked executed) is written before the cross-contract call into the registry, preventing reentrant or failed calls from executing a proposal twice or leaving it in an inconsistent state.
- A test confirms execute_proposal cannot be called twice for the same already-executed proposal.
- A test confirms that failure in the underlying registry call (e.g., a proposed fee_bps value that fails registry-side validation) leaves the proposal in a recoverable state.

### Timelock Boundary Correctness (Issue 0366)

The timelock implementation must not allow off-by-one errors or circumvention paths.

**Verification:**
- Timelock boundary conditions are carefully tested.
- A proposal cannot execute before its timelock elapses — this is a verified invariant (issue 0385).

### Voting Power Snapshotting (Issue 0364)

Voting power must be fixed at proposal creation and cannot be manipulated after the fact.

**Verification:**
- Issue 0364 confirms voting power is captured at proposal creation.
- Property tests (issue 0373) verify that voting-power snapshots are immutable across the proposal lifecycle.

### Admin Migration Irreversibility (Issue 0368)

The migration of the registry's admin role to the governance contract must be genuinely irreversible.

**Verification:**
- The exact procedure is documented step by step in issue 0368.
- A test performs the actual migration on a local network and confirms it is irreversible without a governance proposal.

---

## Deferred Questions

### 1. Proposal Cancellation (Issue 0372)

**Question:** Can a proposal that has passed and is sitting in its timelock queue be cancelled before execution? If so, by whom?

**Status:** _Declined; deferred._

A proposal queued in the timelock and recognized as harmful cannot be cancelled via an in-contract mechanism. The accepted safeguards are:

- The timelock provides a reaction window for the community to recognize a harmful proposal before it executes.
- Any account can deploy a counter-proposal (if voting power permits) to override or replace the harmful proposal with a new one.
- If this becomes a practical problem (a truly unrecoverable harmful proposal slips through), a future governance proposal could introduce a cancellation mechanism (e.g., a high-threshold veto by a subset of governance members or keepers).

**Rationale:** A cancellation mechanism itself introduces an attack surface (who gets veto power? can they abuse it?). The timelock reaction window, combined with the enumerated proposal types and snapshotted voting power, was deemed sufficient safeguard for the initial release. This decision is recorded for future reference if emergency cancellation becomes necessary.

### 2. External Audit (Issue 0386)

**Status:** _Scoped but not commissioned._

Issue 0386 defines the audit scope note for a future governance and token audit, specifying what an auditor needs to review:

- Token and governance contracts in scope.
- Registry changes (specifically the admin-migration change) in scope.
- Highest-risk components: proposal execution's cross-contract call, timelock boundary correctness, and voting-power snapshotting.

The scope note is prepared for when an external audit is commissioned, but no audit has been scheduled as part of this epic's completion. This is acknowledged as a future step before any production deployment, not part of the epic E09 closure.

---

## Governance Invariants (Issue 0385)

The following invariants govern the system and are verified by automated tests:

1. **Timelock Invariant:** A proposal cannot execute before its timelock elapses.
2. **Voting Power Invariant:** Voting power is fixed at proposal creation and cannot be manipulated after the fact.
3. **Enumeration Invariant:** Only the enumerated proposal types (issue 0363) can ever be created — no arbitrary-call escape hatch exists.
4. **Admin Migration Invariant:** Once the registry's admin role is transferred to the governance contract, only governance itself can modify registry admin-gated parameters.
5. **CEI Invariant:** A proposal cannot be executed twice; execution state is finalized before any cross-contract calls.

---

## Summary

Epic E09 successfully decentralized control of the registry's protocol parameters by introducing a governance token ($KPRS) and a complete proposal-and-voting system. The admin migration, the most consequential change, has been performed on testnet and is confirmed to be irreversible without governance action.

All original design questions were answered and implemented as specified. The plutocracy risk inherent to token-weighted governance is documented and accepted. The security review covered all critical concerns. The testnet dry-run provided strong evidence of readiness.

Two questions remain deferred: proposal cancellation (accepted as out-of-scope for the initial release due to its own attack surface) and the external audit (scoped but not yet commissioned, reserved for a future step before production deployment).

The governance system is now the single source of truth for registry administration, moving the project from single-admin centralization to decentralized control.
