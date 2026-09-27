# Staking and Slashing Design (E06) — Retrospective and Stable Surface

This document closes epic E06 by recording the contract surface that was actually settled, what was intentionally left out, and what future work can safely build on without re-litigating design questions already answered.

## Status

The staking work is intentionally narrow and conservative:

- keeper collateral is tracked in the registry itself;
- stake is a per-keeper balance with an explicit unbonding delay;
- the minimum stake floor is an admin-configurable threshold checked at claim time;
- slash authority is explicit and contract-enforced;
- batch slash is not part of the shipped surface.

This is the stable layer the reputation and governance epics can rely on.

## 1. Original design questions from issue 0288

Issue 0288 framed five open design questions:

1. What counts as slashable?
2. Where stake lives: same contract vs. dedicated staking contract?
3. Whether withdrawal is immediate or delayed.
4. Whether a dispute window exists and who can challenge.
5. Whether staking changes claim priority or execution semantics.

The E06 implementation accepted a deliberately limited answer to each of these.

## 2. Divergences from the original design

The following differences are intentional and should be treated as the canonical design, not as accidental omissions.

### 2.1 Same-contract staking, not a dedicated staking contract

The design keeps stake in the keeper registry rather than introducing a separate staking contract that the registry calls into.

This was chosen because the registry already owns the keeper lifecycle, task escrow, and reward accounting. Keeping stake in the same contract avoids a cross-contract call on every claim or slash check and makes the collateral state easier to reason about in one ledger.

The tradeoff is explicit: future work may introduce a separate staking wrapper, but the registry's internal storage and event model remain the stable source of truth for account balances and enforcement.

### 2.2 No automatic, verifier-driven slashing in the first shipped surface

Issue 0288 left open whether slashing should be automatic, dispute-based, or admin-triggered. The shipped surface does not add an on-chain dispute engine or an automatic verifier-derived slash trigger.

Instead, the contract exposes a single, explicit slash authority and enforces that only that authority may reduce a keeper's active stake. This keeps the security model contained and avoids coupling slashability to a verifier or governance subsystem that is not part of the registry core.

### 2.3 No claim-priority or reputation-based staking effect in the core registry

The original design considered whether a keeper with more stake gets different treatment in `claim_task` or `execute_task` than one with no stake.

The shipped design keeps staking as a collateral floor and accountability mechanism, not as a claim-priority or execution-boost mechanism. A keeper's stake can affect eligibility only through a configurable minimum floor; it does not alter the ordering of claim competition or the reward flow.

This keeps the core task registry simple and prevents a subtle incentive bug where a keeper could game the queue by over-staking rather than by performing work correctly.

### 2.4 No dispute window state machine in core staking

The design document considered a challenge period and a pending-dispute state. That functionality was not added to the registry.

The stable surface therefore treats slashing as a direct action by the slash authority, with event history as the audit record. If a future dispute or appeal system is added, it must be layered on top of this ledger state rather than being embedded in the core staking primitive.

### 2.5 No batch slash API

The design intentionally keeps the slash surface single-target. The threat model for a systemic incident is handled operationally by repeated single-target slashes, not by a batch entry point that can slash many keepers in one transaction.

## 3. Deferred and explicitly declined work

This section records the decisions that were not silently dropped.

### 3.1 Batch slashing was explicitly declined

Issue 0308 evaluated whether `batch_slash` was worth building for a systemic incident. The recommendation is to decline it.

Reasoning:

- a single admin call that can slash many keepers has a much larger blast radius than a single targeted slash;
- the operational complexity is higher than the benefit in the rare events this would matter;
- repeated single slashes remain a reasonable operational cost for an incident response that must remain auditable and narrow in scope.

This is therefore not a latent feature gap. It is an explicit product decision: batching slash is not part of the stable interface.

### 3.2 Dispute and appeal logic remains future work

The first staking design does not include a challenge or appeal system. This is intentionally deferred. Any future E07/E09 work that needs a richer accountability model can add it on top of the keeper stake record without needing to rewrite the registry's balance accounting.

### 3.3 Reputation and governance are downstream consumers, not embedded in staking core

The staking ledger is defined as an audit-friendly base layer. Reputation and governance work should consume the staking history as input rather than re-implementing stake logic in their own contracts.

## 4. Stable surface for E07 and E09

The following contract surface is the durability boundary future epics can build against.

### 4.1 Ledger state

The stable ledger model is:

- `Stake(Address) -> i128`: active staked balance for a keeper.
- `PendingUnbond(Address) -> PendingUnbond`: the amount currently in an unbonding state and the associated release condition.
- `MinStake -> i128`: configurable minimum active stake for a keeper to claim tasks.
- `UnbondingDelay -> u64`: configured number of ledgers a pending unbond must age before it becomes withdrawable.
- `SlashAuthority -> Address`: the explicit authority allowed to slash.

The important invariant is that active stake and pending unbonding are distinct states. A keeper cannot satisfy the minimum-stake check using collateral that is already committed to an unbonding withdrawal.

### 4.2 Core entries

The stable staking entry points are:

- `deposit_stake(keeper, amount)`
- `initiate_unbond(keeper, amount)`
- `withdraw_stake(keeper)`
- `slash(keeper, amount, reason)`

These are the primitive actions on which future work can build. They are concrete and narrow enough to be stable for indexers, dashboards, and reputation logic.

### 4.3 Views and config surfaces

The stable read-only surface is:

- `stake(keeper) -> i128`
- `pending_unbond(keeper) -> PendingUnbond`
- `min_stake() -> i128`
- `unbonding_delay() -> u64`
- `slash_authority() -> Address`

These values are part of the long-lived data model and are safe for E07 and E09 to read directly. Any future reputation or governance logic should consume these values rather than inferring state from unrelated task activity or external off-chain metadata.

### 4.4 Events as the audit trail

The event stream is the canonical record for indexers and future consumer epics. Specifically, the staking ledger must carry enough information to reconstruct:

- deposit history;
- pending unbonding and release timing;
- successful withdrawals;
- slash events and reasons.

This is the layer E07 and E09 should attach to: stake history, collateral health, and slash evidence, not bespoke ad-hoc queries against scattered storage keys.

## 5. Final design boundary

The E06 design is intentionally not a full governance, dispute, or reputation system. It is a stable staking primitive on which future epics can build.

The contract will:

- hold and enforce the keeper's stake,
- delay withdrawal for a configurable unbonding period,
- enforce a configured minimum active stake where needed,
- allow only the designated slash authority to reduce stake,
- expose a clean event stream for downstream reputation and governance work.

It will not:

- implement a batch slash API,
- add a dispute or appeal state machine,
- change claim priority on the basis of stake,
- embed future governance or reputation policy into the registry's core accounting.

That is the stable surface on which E07 and E09 can build with confidence.
