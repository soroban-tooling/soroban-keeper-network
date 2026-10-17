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

The transition from the current single-admin model to the decentralized governance contract is an explicit, one-time migration that permanently decentralizes control of the protocol.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           MIGRATION ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [Phase 1: Deployment & Parameter Initialization]                                │
│   Deploy $KPRS Token -> Mint Initial Supply -> Deploy Governance Contract       │
│                                      │                                          │
│ [Phase 2: Two-Sided Authorization Handshake]                                    │
│   Current Admin signs call to governance.accept_admin(current_admin, registry)  │
│   Governance Contract invokes registry.transfer_admin(current_admin, gov_addr) │
│   Both current_admin auth and governance_addr contract auth satisfied          │
│                                      │                                          │
│ [Phase 3: Immediate Admin Lockout]                                              │
│   original_admin key permanently revoked across all 13 admin entry points       │
│                                      │                                          │
│ [Phase 4: Full Protocol Decentralization & Irreversibility]                     │
│   Registry parameters governable exclusively via timelocked $KPRS proposals     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Step-by-Step Migration Procedure

1. **Pre-flight Configuration & Environment Verification**:
   - Verify the `KeeperRegistry` contract is live and its instance storage records the deployer's address as `DataKey::Admin`:
     ```bash
     stellar contract invoke --id $REGISTRY_ID --source-account $ADMIN_KEY -- admin
     # Returns: "$ADMIN_ADDRESS"
     ```
   - Ensure the $KPRS token contract (`contracts/governance-token`) is deployed and funded per §2.
   - Deploy the `GovernanceContract` (`contracts/governance`) and initialize it with initial governance parameters, the $KPRS token address, and the `KeeperRegistry` address.

2. **Executing the Handshake via `accept_admin`**:
   - The current registry admin invokes `accept_admin` on the `GovernanceContract`:
     ```bash
     stellar contract invoke \
       --id $GOVERNANCE_CONTRACT_ID \
       --source-account $ADMIN_KEY \
       -- \
       accept_admin \
       --current_admin $ADMIN_ADDRESS \
       --registry $REGISTRY_ID
     ```
   - **Internal Execution Flow**:
     1. `GovernanceContract` enforces `current_admin.require_auth()`, ensuring the transaction was signed by the current registry admin.
     2. `GovernanceContract` resolves its own contract address `governance_addr = env.current_contract_address()`.
     3. `GovernanceContract` calls `KeeperRegistryClient::transfer_admin(&current_admin, &governance_addr)`.
     4. Inside `KeeperRegistry::transfer_admin`:
        - `require_admin(&e, &current_admin)` passes because `current_admin` authorized the outer call and matches `DataKey::Admin`.
        - `new_admin.require_auth()` passes because `new_admin` is the executing contract itself (`governance_addr`), satisfying contract-level authorization in the call tree.
        - `KeeperRegistry` writes `DataKey::Admin = governance_addr` and emits the `AdminTransferred(old_admin, new_admin)` event.
     5. `GovernanceContract` emits the `admin_migrated(current_admin, governance_addr)` event.

3. **Post-Migration Verification**:
   - Verify registry admin view returns the governance contract address:
     ```bash
     stellar contract invoke --id $REGISTRY_ID -- admin
     # Returns: "$GOVERNANCE_CONTRACT_ID"
     ```
   - Verify that attempts by the former admin to invoke any admin-gated function are immediately rejected with `KeeperError::Unauthorized`:
     ```bash
     stellar contract invoke --id $REGISTRY_ID --source-account $ADMIN_KEY -- pause --admin $ADMIN_KEY
     # Fails with error: KeeperError::Unauthorized (Code 2)
     ```

### 6.2 The Two-Sided Authorization Handshake & Contract Auth

`KeeperRegistry::transfer_admin` enforces a two-sided authorization check:
```rust
require_admin(&e, &admin)?;
new_admin.require_auth();
```
This guard ensures administrative control can never be transferred to an unconsenting recipient or black hole address.

**Why a Dedicated Entry Point is Required**:
- A human admin signs transactions with a public/private keypair.
- A smart contract has no private key and cannot sign off-chain cryptographic signatures.
- Under Soroban's authorization framework, a contract address satisfies `require_auth()` only when the contract itself is currently executing in the call stack.
- Attempting to call `registry.transfer_admin(admin, governance_addr)` directly from a CLI keypair would fail because `governance_addr.require_auth()` cannot be signed by the external key.
- By exposing `accept_admin(current_admin, registry)`, the governance contract initiates the downstream call to `transfer_admin`. Its contract address is the active caller, cleanly satisfying `new_admin.require_auth()` while verifying `current_admin.require_auth()` from the incoming transaction envelope.

### 6.3 Explicit Statement of Irreversibility

> [!CAUTION]
> **PERMANENT AND IRREVERSIBLE ACTION**
> Once `accept_admin` executes, administrative control of `KeeperRegistry` is permanently relinquished by the single human admin key.
> 
> - **No Backdoor or Fallback Key**: The `KeeperRegistry` storage maintains a single `DataKey::Admin` slot. Following migration, this slot holds the `GovernanceContract` address.
> - **Closed Action Enum**: The governance engine's `GovernableAction` enum (Issue #490 / 0360) is strictly closed and does **not** include an action to transfer admin back to an external address or individual keypair.
> - **No Return Path**: There is no mechanism for an individual, team member, or original deployer to reclaim administrative control. The only mechanism that could alter registry administration is a community-wide governance proposal passing `UpgradeRegistry` after full public review and the mandatory 48-hour timelock delay.

### 6.4 Verification and Test Coverage

The migration procedure and its security properties are validated by automated tests in `contracts/governance/src/test.rs`:
- `test_one_time_admin_migration_full_lifecycle_and_irreversibility`:
  1. Validates that the original admin exercises administrative power prior to migration (`set_fee_bps`, `set_min_reward`).
  2. Executes `accept_admin` and verifies registry ownership updates to `GovernanceContract`.
  3. Verifies that the original admin is rejected with `KeeperError::Unauthorized` across all admin-gated functions:
     - `set_fee_bps`
     - `set_min_reward`
     - `set_reputation_floor`
     - `pause`
     - `unpause`
     - `set_min_stake`
     - `set_dispute_window`
     - `transfer_admin`
     - `upgrade`
     - `sweep_fees`
     - `slash`
     - `resolve_slash_appeal`
     - `resolve_execution_dispute`
  4. Verifies parameter updates succeed exclusively through passed and timelocked governance proposals (`SetFeeBps`, `Pause`).
  5. Proves irreversibility by asserting that any attempt to repeat migration or re-assign admin fails with `GovernanceError::RegistryCallFailed`.
- `test_admin_migration_dual_auth_enforcement`:
  1. Verifies that an imposter or unauthorized account cannot invoke `accept_admin`.
  2. Verifies that only the authorized current admin can initiate the handover.

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
| **Proposal Threshold**| 100,000 KPRS (0.1% supply) | High enough to prevent spam; low enough to be accessible |
| **Governable Scope** | Closed, enumerated parameter enum (v1) | Eliminates arbitrary execution attack surface |
| **Voting Mechanism** | 1 token = 1 vote at snapshot ledger | Prevents flash-loan manipulation; simple & verifiable |
| **Voting Window** | 7 days (100,800 ledgers) | Ample time for distributed stakeholder deliberation |
| **Quorum** | 4% of total supply (4,000,000 KPRS) | Ensures legitimate stakeholder representation |
| **Pass Threshold** | Simple majority (> 50% For of For+Against) | Standard, unambiguous decision boundary |
| **Timelock** | 48 hours (28,800 ledgers) | Gives task owners and keepers time to exit before changes |
| **Execution** | Permissionless after timelock | Guarantees liveness without trusted actors |
| **Migration** | `transfer_admin` handshake to governance address | Completely eliminates single-admin key dependency |
