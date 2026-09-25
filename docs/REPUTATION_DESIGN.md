# Keeper Reputation Design & Epic Retrospective (E07)

This is the architectural specification and epic retrospective for the keeper reputation system (Epic E07, issues 0318–0337). It establishes the on-chain scoring model, documents the outcome of the priority-queue feasibility study (issue 0322), details the security review of gaming vectors (issue 0336), records divergences from the initial design, and pins the stable contract surface for downstream consumers—most notably Epic E08 (Treasury) and Epic E09 (Governance).

---

## 1. Context & Architectural Motivation

In the initial protocol MVP (wave 1), the keeper registry treated all keepers identically: any address could claim any pending task on a first-come, first-served (FCFS) basis. The only accountability mechanism was the temporary claim lock (`lock_ledgers`), which permitted re-claiming if a keeper abandoned a task without executing it (issue 0016). The contract maintained no durable track record of keeper execution fidelity or reliability.

While off-chain indexers (Epic E14) can reconstruct historical performance from raw ledger events, the on-chain registry lacked an internal metric to:
1. Differentiate reliable keepers from malicious or flaky participants.
2. Restrict claims on high-value or latency-sensitive tasks to proven performers (eligibility gating).
3. Provide an on-chain trust signal for downstream economic and governance systems.

Epic E07 introduces native on-chain reputation scoring into `keeper-registry`, balancing Soroban host execution constraints (CPU instruction limits, storage fees, absence of native cron timers) against economic security and gaming resistance.

---

## 2. Core Scoring Architecture (Issue 0318)

### 2.1 Tracked Actions

Reputation quantifies operational reliability through three primary signals:

1. **Successful Task Executions (`+1` score increment):** Credited inside `execute_task` when a claiming keeper successfully executes a task and passes any attached verifier.
2. **Missed Lock Windows (`-penalty` score decrement):** Assessed when a keeper claims a task, locks it exclusively, and fails to submit a valid execution before `lock_ledgers` expires. This penalty is triggered lazily when another keeper re-claims the expired task via `claim_task` or when the task is expired/cancelled.
3. **Slashing Interaction (Epic E06 Staking):** If staking and slashing are active, a contract-enforced slash represents a severe protocol violation (e.g., fraudulent proof submission) and applies a punitive reputation penalty or full score reset.

### 2.2 Storage Model & State Updates

Soroban meters host storage read/write footprints directly into transaction fees. Two update strategies were evaluated:
- **On-Demand Event History Replay:** Purely reproducible from events, but requires loading historical state or unbounded looping in contract code. This exceeds Soroban's CPU instruction ceiling ($O(N)$ gas) and was rejected.
- **Incremental State Accumulation:** Storing an active `KeeperReputationRecord` in persistent storage (`DataKey::KeeperReputation(Address)`). State updates occur $O(1)$ inline during `execute_task` and re-claim transitions.

**Decision:** Adopt incremental on-chain accumulation.
- The record is created upon a keeper's first tracked action and updated as an inline side effect of core lifecycle operations.
- The storage entry uses `Persistent` storage and inherits the registry's standard TTL renewal policy (`extend_ttl` to `INSTANCE_BUMP_LEDGERS`).
- Read-only views (`keeper_reputation`) access this record side-effect-free without bumping TTL.

### 2.3 Reputation Decay Function (Issue 0321)

To ensure that stale historical performance does not grant eternal privileges and that past mistakes do not permanently incapacitate a rehabilitated keeper, reputation decays over time.

#### Design Analysis: Active vs. Lazy Decay
- **Active Periodic Decay:** A scheduled cron job or maintenance transaction iterating over all registered keepers to decrement scores. Soroban does not support autonomous scheduled calls; requiring maintainers or third parties to pay transaction fees to decay inactive keepers is economically unviable and vulnerable to DoS.
- **Lazy Read-Time Decay:** The contract stores the score alongside `last_update_ledger`. Whenever the score is queried or modified, the elapsed ledgers $(\Delta L = \text{current\_ledger} - \text{last\_update\_ledger})$ determine the decayed effective score:

$$\text{Effective Score} = \text{Stored Score} \times \max\left(0, 1 - \frac{\Delta L}{\text{DECAY\_HORIZON}}\right)$$

**Decision:** Implement lazy, read-time deterministic decay. Any state mutation persists the newly decayed baseline, while read-only views compute the decayed score dynamically without writing to storage.

---

## 3. Priority-Queue Feasibility Study (Issue 0322)

Issue 0322 investigated whether reputation could be used to implement an on-chain priority queue for task claims, giving higher-reputation keepers preferential access to pending tasks.

### 3.1 The Soroban Execution Constraint

In Soroban, transactions within a ledger are executed in an order determined by the consensus protocol and network-level transaction scheduling. The smart contract has no visibility into:
- The sub-ledger arrival order of transactions.
- Off-chain mempool competition.
- "Nearly simultaneous" claim submissions.

`claim_task` operates under a first-come, first-served (FCFS) model: whichever valid transaction is committed first within the ledger claims the task.

### 3.2 Evaluated On-Chain Priority Mechanisms

Three on-chain priority models were studied:

1. **Reputation-Tiered Claim Windows (Time Delays):**
   - *Mechanism:* Keepers below a reputation threshold must wait $K$ ledgers after task registration before their `claim_task` call is accepted; top-tier keepers can claim immediately.
   - *Finding:* Creates unnecessary latency for task creators, complicates task deadline calculations, and stalls urgent tasks if high-reputation keepers are temporarily offline.
2. **Two-Phase Commit / Claim Auction:**
   - *Mechanism:* Keepers submit claim intents during a commitment window; at window close, the contract assigns the claim lock to the highest-reputation bidder.
   - *Finding:* Drastically increases latency, multiplies transaction fees (two transactions per claim), creates state bloat, and introduces griefing vectors where keepers submit intents without executing.
3. **Dynamic Lock Lengths:**
   - *Mechanism:* High-reputation keepers receive longer lock windows; low-reputation keepers receive shorter windows.
   - *Finding:* Does not influence claim contention—it only alters lock duration after a claim has already succeeded.

### 3.3 Feasibility Outcome & Recommendation

**Outcome: EXPLICITLY DECLINED FOR ON-CHAIN ENFORCEMENT.**

Enforcing an on-chain priority queue on Soroban is technically ill-suited to the host execution model and introduces adverse economic friction. 

**Recommendation:**
- Keep on-chain claiming permissionless and FCFS.
- Protect task execution through an **Eligibility Floor** (§4).
- Offload priority behavior to **off-chain keeper bot coordination** (issue 0330): keeper bots can query `keeper_reputation` and voluntarily implement backoff delays or yield claims based on internal operator policies, but the contract does not enforce this on-chain.

---

## 4. Claim Eligibility Floor (Issue 0323)

In place of an on-chain priority queue, issue 0323 introduces an **Optional Claim Eligibility Floor**:

- **Mechanism:** An administrative configuration parameter, `min_reputation: u32`. When enabled $(\text{min\_reputation} > 0)$, `claim_task` checks the decayed reputation of the caller:
  $$\text{Effective Reputation}(\text{caller}) \ge \text{min\_reputation}$$
  If the check fails, the transaction aborts with `KeeperError::ReputationTooLow`.
- **Default State:** Defaults to `0` (disabled). This ensures full backward compatibility: existing keepers are never retroactively locked out upon contract upgrades.
- **Administrative Control:** Settable solely by `Admin` (or subsequent governance timelock in E09) via `set_min_reputation(min_reputation: u32)`.

---

## 5. Security Review & Gaming Vectors (Issue 0336)

Issue 0336 conducted a comprehensive adversarial review of the reputation mechanism. Three primary vectors were evaluated:

### 5.1 Gaming Vector 1: Self-Dealing via Trivial Wash Tasks
- **Threat:** A keeper creates trivial, low-reward tasks that it funds itself, immediately claims, and executes with a dummy verifier/proof to artificially inflate its reputation score.
- **Analysis:** In a permissionless smart contract without identity or KYC, the contract cannot distinguish between a legitimate third-party dApp task and a self-funded wash task.
- **Mitigation & Accepted Risk:**
  - Protocol fees (configured via `fee_bps`) and minimum task rewards (`min_reward`) impose an explicit economic cost per reputation point farmed.
  - **Resolution: ACCEPTED PROTOCOL LIMITATION.** The cost-of-attack is proportional to capital expended in protocol fees. Because reputation can be economically farmed, **reputation must NEVER be used as a standalone, unweighted basis for monetary distribution or plutocratic governance voting power.**

### 5.2 Gaming Vector 2: Decay Boundary Manipulation
- **Threat:** Keepers exploit discrete decay calculation intervals by batching claims immediately before an epoch rollover to prevent score degradation.
- **Analysis:** Discrete intervals (e.g., weekly epochs) incentivize artificial transaction clustering near boundary ledgers.
- **Mitigation:** The decay function is calculated continuously per-ledger $(\Delta L)$, eliminating discrete cliff boundaries and preventing boundary timing exploits.

### 5.3 Gaming Vector 3: Eligibility Floor Risk Aversion ("Chilling Effect")
- **Threat:** If missed locks incur severe penalties, keepers may refuse to claim difficult, variable-latency, or verifier-attached tasks, fearing that a single network delay or verifier edge-case will drop them below `min_reputation` and exclude them from all future tasks.
- **Mitigation:**
  - Asymmetric penalty ratio: Missed locks penalize score moderately rather than wiping out accumulated history.
  - Recovery path: If a keeper falls below the floor, the admin/governance can allow special "open" tasks (or lower tiers) so the keeper can rebuild standing, or the floor can be maintained at a modest baseline.

---

## 6. Summary of Architectural Decisions

| Aspect | Original Proposal (0318) | Shipped Design / Final Outcome | Rationale / Justification |
|---|---|---|---|
| **Claim Priority** | On-chain reputation-weighted priority queue | **Explicitly Declined.** Replaced by Eligibility Floor (`min_reputation`) and off-chain bot self-selection | Soroban transaction ordering and block inclusion do not permit fair, low-latency, on-chain claim arbitration without prohibitive gas and state contention. |
| **Decay Calculation** | Scheduled or periodic decay | **Lazy Read-Time Calculation** based on elapsed ledgers $(\Delta L)$ | Avoids unbounded state iteration and external subsidization of maintenance transactions. |
| **Storage Model** | Historical event replay vs. storage record | **Incremental Persistent Storage** (`KeeperReputation(Address)`) | $O(1)$ execution cost within transaction CPU budget limits; offloads full history to indexer (E14). |
| **Gating Mechanism** | Strict gating on all tasks | **Optional Admin-Configured Floor** (`min_reputation`), defaulting to `0` | Preserves permissionless access by default; prevents retroactive lockout of existing keepers. |
| **E06 Staking Coupling** | Hard dependency on staking slashes | **Decoupled Architecture with Optional Hook** | Allows reputation to ship and operate independently even if staking (E06) is deferred, unbonded, or absent. |

---

## 7. Epic E07 Retrospective: Shipped vs Studied and Deferred

### 7.1 Shipped Deliverables

1. **Storage & Tracking Logic (`contracts/keeper-registry/src/reputation.rs`):**
   - Core data structure `KeeperReputationRecord` tracking successes, missed locks, last update ledger, and base score.
   - Integrated hooks into `execute_task` (success increment) and `claim_task` (missed lock penalty on re-claim).
2. **Read-Only Inspection View (`contracts/keeper-registry/src/views.rs`):**
   - `keeper_reputation(env: Env, keeper: Address) -> KeeperReputationRecord`: Read-only, side-effect-free, dynamic lazy decay calculation, never bumps TTL.
3. **Configurable Eligibility Floor (`contracts/keeper-registry/src/task.rs`):**
   - `min_reputation` enforcement during `claim_task`.
   - Admin configuration entry point `set_min_reputation(env: Env, min_reputation: u32)`.
   - New typed error `KeeperError::ReputationTooLow`.
4. **Reputation Lifecycle Events (`contracts/keeper-registry/src/events.rs`):**
   - Standardized topic `("reputation", "update")` emitting `(keeper: Address, action: Symbol, new_score: u32)`.
5. **Testing & Invariant Coverage:**
   - Unit tests covering scoring arithmetic, boundary ledger decay, and floor rejection.
   - Property tests confirming consistency between stored incremental records and raw event replay.

### 7.2 Studied and Deferred Items

- **On-Chain Priority Queue (Issue 0322):** Formally declined on-chain due to Soroban host execution constraints; delegated to off-chain keeper bot task selection (issue 0330).
- **Automated Slasher Integration (Issue 0326):** Deferred pending final deployment and stabilization of Epic E06 staking contracts. The storage layout and scoring functions provide the interface hook (`slash_penalty`), but the live invocation hook remains dormant until E06 settles on mainnet.

---

## 8. Stable Surface for Downstream Consumers

Downstream contracts, SDKs, indexers, and governance protocols must integrate against the following stable on-chain surface:

### 8.1 Contract Types & Storage Layout

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperReputationRecord {
    /// Total successful task executions completed by the keeper.
    pub successful_executions: u32,
    /// Total claimed tasks that expired without execution before re-claim.
    pub missed_locks: u32,
    /// Ledger sequence number at which the record was last mutated.
    pub last_update_ledger: u32,
    /// Normalized reputation score (prior to read-time decay calculation).
    pub base_score: u32,
    /// Decayed effective score at current ledger height.
    pub effective_score: u32,
}
```

**Storage Key:**
```rust
DataKey::KeeperReputation(Address) // Persistent storage scope
DataKey::MinReputation            // Instance storage scope
```

### 8.2 Public View & Entry Point Signatures

```rust
pub trait IKeeperReputation {
    /// Returns the complete reputation record for `keeper`, including decayed score.
    /// Returns default zero-initialized record if `keeper` has no history.
    /// Side-effect-free, simulation-safe, does not bump TTL.
    fn keeper_reputation(env: Env, keeper: Address) -> KeeperReputationRecord;

    /// Returns the active claim eligibility floor. Returns 0 if disabled.
    fn min_reputation(env: Env) -> u32;

    /// Configures the claim eligibility floor. Restricted to Admin/Governance.
    fn set_min_reputation(env: Env, min_reputation: u32);
}
```

### 8.3 Invariants Guarantees

- **I-REP-1 (Monotonic Decay):** Between state-mutating updates, a keeper's `effective_score` is monotonically non-increasing over advancing ledger sequences.
- **I-REP-2 (Read Purity):** Calling `keeper_reputation` never modifies instance or persistent storage and never modifies TTL.
- **I-REP-3 (Zero-Floor Default):** When `min_reputation == 0`, `claim_task` imposes zero reputation checks, ensuring 100% backward compatibility with wave 1-3 tasks.

### 8.4 Guidance for Epic E08 (Treasury & Fee Distribution)
- The Treasury contract may query `keeper_reputation` as an advisory filter for bonus distributions or fee rebates.
- Keepers with `effective_score == 0` or high `missed_locks` ratios should be excluded from performance dividend pools.

### 8.5 Guidance for Epic E09 (Governance & Voting Power)
- **CRITICAL SECURITY DIRECTIVE:** As established in §5.1, on-chain reputation is susceptible to economic self-dealing (wash tasks). Therefore:
  - **Reputation MUST NOT directly grant 1:1 governance voting power or token minting rights.**
  - If Epic E09 incorporates reputation into voting weights, it should do so only as a **capped sub-linear modifier** (e.g., square-root or quadratic participation multiplier) applied to staked KPRS governance tokens:
    $$\text{Voting Power} = \text{Staked Tokens} \times \left(1 + \min\left(\alpha, \beta \sqrt{\text{effective\_score}}\right)\right)$$
  - Pure reputation voting is explicitly prohibited to prevent sybil/plutocratic capture.
