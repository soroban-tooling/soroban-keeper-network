# Front-Running and MEV Analysis for Claims (issue #741)

## 1. Scope and threat model

This document answers the question in issue #741: **what can a keeper watching
RPC traffic gain by racing another keeper to a claim, and what can it not
gain?** It also states which of those gains are accepted by design.

The registry is deliberately a first-come system. Once a task is `Pending`,
any address may call `claim_task` (subject to the gates in
[`ACCESS_CONTROL.md`](ACCESS_CONTROL.md)) and become its `claimer` for a lock
window. The reward goes to whoever *executes* while holding that claim, not to
whoever merely claimed it.

### What "front-running" means on Stellar

Stellar is not Ethereum. There is no public fee-bidding mempool in which a
searcher can guarantee ordering by paying more, and no general-purpose MEV
auction. Transactions are submitted to an RPC node, flooded through the peer
network, and **ordered by consensus (SCP)** into ledgers that close roughly
every five seconds. Two consequences shape everything below:

- A competing keeper can *race* by submitting its transaction quickly, hoping
  to land in the same ledger or the next one. It cannot buy priority or
  insert itself ahead of an already-in-flight transaction.
- An observer can learn about a task from **public ledger state and events**
  (`TaskRegistered`, `TaskClaimed`, `TaskExecuted`, …) and from transactions it
  sees at its own RPC node before inclusion. But the registry's own data is
  public to everyone equally, so most "information advantage" is really just
  being faster to act on already-public data.

In short: the realistic adversary is a fast, well-connected keeper bot, not a
block producer extracting value by reordering. The analysis below is written
for that adversary.

### The three arenas

| Arena | What the racer wants | Section |
| --- | --- | --- |
| Claim race | Be the `claimer` first, or take over a stale claim | §2 |
| Proof copying | Execute a task using work/knowledge it did not produce | §3 |
| Deadline sniping | Profit from the moment a deadline passes | §4 |

---

## 2. Claim races

### The mechanism

`claim_task` (`contracts/keeper-registry/src/task.rs`) applies, in order:

1. `require_not_paused`, `keeper.require_auth`.
2. The **minimum stake** floor (§5.2) and **reputation** floor (§5.1) gates.
3. `load_task`, deadline check, and status check. A `Pending` task can be
   claimed; a `Claimed` task can only be taken over if the current claim's
   **lock has expired** (`lock_expired`, `claim_ledger + lock_ledgers`);
   terminal tasks cannot be claimed.
4. The optional **condition** gate (§5.3).
5. Effects: `status = Claimed`, `claimer = keeper`, `claim_ledger = now`,
   and — on a takeover — a `record_missed_claim` on the displaced keeper.

The lock is bounded by the owner at registration:
`MIN_LOCK_LEDGERS = 12` (~1 minute) to `MAX_LOCK_LEDGERS = 17_280` (~1 day).
A takeover is therefore possible only after the lock, and only while the
deadline has not passed (`claim_task` rejects `now >= deadline`).

### What a racing keeper gains

- **Winning the initial claim:** the winner gets an exclusive window to
  execute and earn the reward. This is the intended incentive — the lock is
  the prize for being fast. A faster bot legitimately wins; there is no
  ordering attack here, only a speed race on public data.
- **Taking over a stale claim:** once the lock expires, a second keeper may
  claim. The displaced keeper loses the reward but is charged a
  `missed_claims` reputation event. Because `MAX_LOCK_LEDGERS` is capped, no
  keeper can hold a task hostage for more than about a day, and the
  permissionless `expire_task` always remains available at the deadline.
- **Claim sniping at registration:** a bot that sees a `TaskRegistered` event
  can submit a claim immediately. This is the normal competitive case and is
  **accepted by design** — claiming is intentionally permissionless so tasks
  get executed quickly.

### What a racing keeper cannot gain

- **It cannot displace a claim inside the lock window.** `lock_expired` is a
  hard status guard, so a competing `claim_task` returns
  `KeeperError::LockPeriodActive` and changes nothing.
- **It cannot steal the reward by claiming alone.** The payout is made only by
  `execute_task`, which additionally requires the caller to be the current
  `claimer`, the task to be `Claimed`, the deadline not passed, and any
  verifier to approve (§3).
- **It cannot claim after the deadline.** Both `claim_task` and
  `execute_task` reject `now >= deadline`; after that point the only path is
  the permissionless `expire_task`, which refunds the **owner**, not the
  keeper. There is no reward to snipe at the deadline.
- **It cannot make the original claim fail by racing.** If two claims land in
  the same ledger, consensus orders them deterministically. The first sets
  `Claimed`; the second sees an active lock and fails cleanly. No partial
  state is observable, and no value moves on the losing transaction (its
  atomic rollback reverts even the reputation write).

### Griefing with takeovers

A malicious keeper could claim a task it never intends to execute, denying a
genuine keeper the exclusive window until the lock expires. Its cost is real
and its benefit is negative:

- it locks its own stake (if a floor is configured, §5.2),
- it must pay transaction fees,
- it accrues a `missed_claims` record on takeover, lowering its reputation
  score (§5.1), and
- the reward still goes to whoever eventually executes; the griefer earns
  nothing.

This is **accepted by design**: the lock bound plus the reputation/stake cost
makes sustained griefing uneconomic, and the owner can cancel a claimed task
once its lock expires (`cancel_task`) if all keepers are unresponsive.

---

## 3. Proof copying

### The proof is public — deliberately

`execute_task` accepts `proof: Bytes` (bounded to `MAX_PROOF_LEN = 256` bytes)
and emits it in the `TaskExecuted` event. This was an explicit MVP decision:
the proof is publicly recoverable so indexers and disputers can audit what was
submitted (see the event documentation in [`EVENTS.md`](EVENTS.md)). Any
observer can therefore read a proof after execution and see the work it
attests to.

### Can a copier use it?

The proof by itself is worthless to a competitor, because execution is bound
to the *claim*, and the claim to the *keeper address*:

1. Only the current `claimer` may execute (`NotTaskClaimer` otherwise).
2. The task is `Executed` after the first successful execution, so a copied
   proof cannot be replayed against the same task (`InvalidTaskStatus`).
3. Copying a proof from **another task** cannot work against a verifier that
   binds its check to `task_id` and `keeper` — the `IKeeperVerifier::verify`
   signature includes both (`contracts/keeper-registry/src/verifier.rs`).

With **no verifier attached**, the MVP trusts the claimer to submit a proof
that reflects off-chain work; the registry cannot judge its content. A keeper
that did no work but claimed and executed still earns the reward. This is a
known limitation of the verifier-less path, not a front-running gain: it is
available to *any* keeper that can win a claim, and the task owner's remedy is
to attach a verifier.

### Collusion with the verifier or condition

A task owner chooses the verifier and condition addresses. A colluding owner
can configure a verifier that approves only a preferred keeper, or a condition
that is true only for that keeper's claims. This reduces competition on that
task, but it is an owner-side choice affecting the owner's own escrow — it is
not value extracted from another keeper by transaction ordering. It is
analysed and accepted in
[`TASK_CONDITIONS_SECURITY_REVIEW.md`](TASK_CONDITIONS_SECURITY_REVIEW.md)
(Finding 1 and Finding 3) and mitigated by advisory curated-verifier
guidance, pre-claim simulation, and event accountability.

### Deadline-adjacent proof submission

A keeper cannot copy a proof and execute in the same ledger as the original
keeper's claim, because `execute_task` requires the task to be `Claimed` by
*the caller*. The fastest legitimate path is: claim → build proof → execute,
all within the lock window and before the deadline. Copying only helps a
keeper that already holds the claim, which is the same position it would be in
without the copy.

---

## 4. Deadline sniping

### What happens at the deadline

`now >= task.deadline` closes both claim and execution paths:

- `claim_task` → `DeadlinePassed`.
- `execute_task` → `DeadlinePassed`, **even for the current claimer**. A
  keeper that waited too long loses the reward.

From that moment, `expire_task` is permissionless: anyone may call it and the
full reward is refunded to the **task owner**. This is the anti-sniping
design: the deadline converts an unexecuted task into a guaranteed owner
refund, not a prize for whoever calls first.

### What a sniper can and cannot gain

- **Cannot take the escrow.** `expire_task` always refunds `task.owner`; the
  caller receives nothing. Racing to be the caller of `expire_task` has no
  monetary payoff beyond the (off-chain) goodwill of the owner.
- **Cannot execute past the deadline**, so it cannot steal a reward from a
  keeper who was still working — the keeper already lost it by missing the
  deadline, and the owner gets it back.
- **Can race to claim a task whose deadline is about to pass** in the hope
  that a slow competitor never executes. This is just the ordinary claim
  race (§2), constrained by the lock window and the deadline itself.

### Clock units and margin

Deadlines are unix timestamps (seconds); locks and storage TTLs are ledger
sequences. Registration enforces `ttl_ledgers >= deadline coverage +
TTL_SAFETY_MARGIN_LEDGERS` (17,280 ledgers ≈ 1 day) so a task's storage does
not lapse between the deadline and the refund. A bot cannot exploit a small
clock-skew window to make the escrow unreachable: by the time a deadline is
reachable, the task entry still has at least a day of runway. (The residual
TTL/archival risk for long-lived entries is documented in
[`STORAGE_LAYOUT.md`](STORAGE_LAYOUT.md).)

---

## 5. How reputation, staking and conditions change the calculus

All three optional gates are **checked before any write** in `claim_task`, and
they interact with racing as follows.

### 5.1 Reputation

`ReputationRecord.score_bps = successes * 10_000 / (successes + missed_claims)`
(`contracts/keeper-registry/src/reputation.rs`). An admin may set a
`ReputationFloor` that `claim_task` enforces; it defaults to `0` (disabled).

- **High-reputation keepers are harder to displace sustainably.** A rival
  that repeatedly claims-and-abandons accrues `missed_claims`, lowering its
  score. Once it falls below a configured floor, it cannot claim at all — a
  direct economic brake on griefing.
- **The floor is checked on the *stored* score, not the decayed one.** Decay
  only ever lowers a score, so a reliable keeper that went idle for a few
  half-lives (100,000 ledgers each) is not permanently locked out. But a new
  address has score 0, so with any non-zero floor a keeper cannot evade a bad
  record by simply switching addresses.
- **Reputation is not a front-running defence on its own.** A high-score
  keeper can still lose a claim race to an even faster high-score keeper; it
  only raises the cost of *dishonest* racing.

### 5.2 Staking

`set_min_stake` makes `claim_task` require `keeper_stake_of(keeper) >= floor`;
it also defaults to `0` (disabled). Stake is locked behind an
`initiate_unbond` → `UNBOND_DELAY_LEDGERS` (86,400 ≈ 5 days) withdrawal and can
be slashed by admin for misbehaviour (`docs/STAKING_DESIGN.md`).

- **Stake raises the cost of griefing.** With a configured floor, a bot must
  bond capital before it can claim, and that capital is exposed to slashing.
  Claim-and-abandon is no longer free.
- **It does not change who wins a fair race.** Two bonded keepers still race
  on speed; staking only filters out unfunded or hit-and-run addresses.
- **Slashing is admin-gated and dispute-bound**, with an appeal window of
  `DISPUTE_WINDOW_LEDGERS` (51,840 ≈ 3 days) and an execution-dispute hold for
  pending rewards, so the stake cannot be used as a tool to punish a keeper
  merely for losing a race.

### 5.3 Conditions

A task may carry an `ITaskCondition::is_met` address, checked in both
`claim_task` and the read-only `is_claimable` view.

- **Conditions can make a claim non-raceable for a period.** A condition that
  evaluates external state (e.g. "is the liquidation actually underwater?")
  means a bot cannot claim early purely on speed — it must wait until the
  predicate is true. This reduces pure latency racing and aligns claims with
  real work becoming available.
- **Conditions can also be used to exclude keepers**, as noted in §3 and in
  the conditions security review. That is an owner-side policy choice, not a
  protocol-level MEV leak.
- **A condition cannot be bypassed by racing.** It is evaluated on every claim
  attempt (including takeovers) and again in `is_claimable`, with fail-closed
  handling for panics and missing contracts (see
  [`CROSS_CONTRACT_CALLS.md`](CROSS_CONTRACT_CALLS.md)).

### Interaction summary

| Gate | Helps against | Does not help against |
| --- | --- | --- |
| Reputation floor | repeat claim-and-abandon griefers | a faster honest keeper winning a fair race |
| Min stake + slashing | unfunded/hit-and-run racers | ordering or speed advantage itself |
| Condition | claiming before work is actually available | colluding owner excluding preferred keepers |
| Claim lock (12…17,280 ledgers) | takeover theft and hostage-taking | winning the initial claim race |

---

## 6. Accepted risks

The following are **intentional properties of a permissionless, first-come
design**, not bugs. They are recorded here so an audit can distinguish
"unfixed" from "accepted".

| # | Risk | Why it is accepted |
| --- | --- | --- |
| A1 | **First-come claim advantage for faster bots** | Claiming is permissionless so tasks are executed promptly. The lock bounds the advantage and the reward still requires execution. |
| A2 | **Takeover of a stale claim** | Lock expiry exists precisely to recover unresponsive keepers. The displaced keeper is penalised in reputation; the takeover cannot happen inside the lock or after the deadline. |
| A3 | **Public proofs / verifier-less trust** | Proofs are emitted for auditability. With no verifier, the MVP trusts the claimer; owners who need proof validation attach a verifier. |
| A4 | **Owner-chosen condition or verifier can favour specific keepers** | The owner is spending its own escrow and can set its own terms. Mitigated by advisory curation, simulation and public event accountability; see the conditions security review. |
| A5 | **Permissionless `expire_task` racing at the deadline** | The caller gains nothing; the refund always goes to the owner. Racing here is harmless public-spirited behaviour. |
| A6 | **Observation of public state/events by competing bots** | Everything the registry exposes is public by design; there is no private order-flow to protect. |
| A7 | **No protection against a keeper that is simply faster** | Stellar consensus provides no priority auction to level this, and adding one is out of scope. Speed is the intended competitive dimension. |

### Residual (non-accepted) items

- **TTL archival of long-lived entries** can strand a reward before a keeper
  withdraws it. This is an operational risk of Soroban's TTL model, tracked in
  [`STORAGE_LAYOUT.md`](STORAGE_LAYOUT.md), not a front-running vector.
- **Keeper-bot telemetry hygiene** (loopback-only binding, redaction of secrets)
  is mandated in [`KEEPER_BOT_V2_SECURITY_REVIEW.md`](KEEPER_BOT_V2_SECURITY_REVIEW.md)
  to prevent a separate class of strategy leakage.

## 7. Practical guidance for keeper operators

These are off-chain mitigations; none requires a contract change.

1. **Claim promptly but only when ready.** Once claimed, build and submit the
   proof well inside the lock window — `execute_task` is rejected at the
   deadline even for the claimer.
2. **Simulate before claiming.** Use `is_claimable` and a dry-run of the
   verifier/condition to avoid claiming a task whose gate will reject you (and
   costing you a `missed_claims` record).
3. **Watch the lock, not just the deadline.** A takeover becomes possible at
   `claim_ledger + lock_ledgers`; monitor it if you hold a long-lock task.
4. **Treat unknown verifiers/conditions with caution.** A rigged gate can
   reject valid proofs; prefer curated or audited addresses.
5. **Withdraw rewards promptly.** Archived balance entries require a restore
   operation before they can be touched (§6 residual items).
