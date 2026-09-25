# Reputation Design (E07)

This document pins the contract-level design for on-chain keeper reputation before implementation starts. It answers the core questions for E07, states explicit tradeoffs, and names any dependency on the staking work in E06.

## Status

This is a design doc, not an implementation plan. It defines the stable contract surface the first reputation build should satisfy and the explicit assumptions that future work can rely on.

## 1. Context

The current registry has no on-chain memory of a keeper's track record beyond the task state itself. A keeper can claim any claimable task, and the protocol treats each claim as independent. That makes task selection efficient but leaves the network without any durable signal for quality, reliability, or risk.

This epic introduces a reputation system that the contract itself can read when deciding how to order or gate keeper participation.

## 2. Design decisions

### 2.1 What reputation tracks

The first reputation model tracks the following signals:

- successful executions;
- missed lock windows / abandoned claims that expire into re-claimable status;
- slash events, if E06 staking lands;
- optionally, explicit failures that are objectively attributable to the keeper (for example, a proof rejection if the project later adds verifier-aware task execution).

The score is intentionally not a generic “social trust” score. It is a narrow, auditable ledger of keeper reliability in the task lifecycle.

#### Rationale

This keeps the signal anchored to contract-observable events rather than subjective metadata. A task lifecycle already has concrete, on-chain facts:

- was a task executed successfully?
- did the keeper claim and then let the lock expire without a valid completion?
- was the keeper slashed for violating the staking rules?

Each of these is measurable from state transitions and the event log, which makes the score reproducible and auditable.

### 2.2 Scoring model

The base score is a signed integer accumulator, represented as a per-keeper record in contract storage:

- `Reputation(Address) -> i128`

The score is intentionally sparse and monotonic in the sense that every observed event updates it by a bounded delta rather than by recalculating from the whole historical event stream.

Suggested default:

- successful execution: +1
- missed lock / claim abandonment: -1
- slash: -N, where `N` is a configurable slash severity or a fixed governance-approved penalty in the first version

The design chooses incremental updates over on-demand recomputation for the first implementation because:

- it is cheap to read during claim ordering or eligibility checks;
- it matches the contract's general pattern of storing compact aggregate state rather than recomputing from a full history;
- it is simpler to keep within Soroban storage and TTL constraints;
- it gives off-chain consumers a single, stable view of current reputation without forcing a full replay.

#### Rationale against full-history recomputation

A full-history model would require either:

- storing the entire raw event stream in a queryable form, or
- re-reading every historical action on each score lookup.

That is operationally costly, harder to keep bounded, and couples a simple on-chain primitive to an expensive read pattern. The contract should keep reputation as a compact state record, with events remaining the canonical audit trail.

### 2.3 Decay

The first version uses a bounded, simple decay policy:

- reputation decays over time but does not reset to zero;
- decay is applied as a weighted reduction over a configured window;
- the exact function should be linear or piecewise-linear rather than a complex nonlinear model in the first implementation.

A practical first design is:

- keep an `updated_at` timestamp or ledger for each keeper;
- compute a decay factor using the elapsed time since the last update;
- multiply the cumulative score by a base factor that is less than 1 over a configured period.

For example:

- score decays by a small percentage per month or per N ledgers;
- very old failures matter less than recent ones.

This prevents a single ancient failure from permanently defining a keeper's trustworthiness and makes the score responsive to current behavior.

#### Rationale

Without decay, reputation becomes a permanent historical ledger that penalizes a keeper forever, even after long periods of reliable service. That is too rigid for a network where keepers may go offline, temporarily fail, or re-enter after a long absence.

### 2.4 What reputation gates or influences

This epic does not gate core task execution with a hard reputation ban in the first version.

The first available decisions are:

1. informational read-only view only;
2. claim ordering priority queue; or
3. minimum eligibility score.

The design chooses a conservative option: a read-only view and a configurable claim-priority or eligibility hook, but no hard ban by default.

#### Preferred initial surface

- `reputation(keeper) -> i128` read-only view
- `set_reputation_floor` admin-configurable eligibility threshold, if the project wants a floor
- optional `claim_task` check against a configured floor only if the project explicitly decides to gate by score

This design keeps the reputation primitive usable without forcing an immediate network-wide policy decision about claim access.

### 2.5 Dependency on epic E06 staking

The design is intentionally explicit about the dependency:

- reputation is useful even without staking;
- if E06 lands, slash events become a first-class negative signal in the score;
- if the score affects slash severity, that is a future design decision and should be treated as a downstream dependency, not assumed in the core score model.

The key rule is: do not tie reputation to slash semantics unless E06 is already part of the executed surface. If E06 has not landed, the score can still be stored and read; it simply does not include slash-based adjustments yet.

## 3. Storage model

The following storage keys are the proposed stable surface prior to implementation.

| Key | Type | Storage | TTL | Default when unset |
|-----|------|---------|-----|---------------------|
| `Reputation(Address)` | `i128` | Persistent | ~1 year (tunable) | `0` |
| `ReputationUpdatedAt(Address)` | `u64` | Persistent | ~1 year (tunable) | `0` |
| `ReputationDecayRate` | `u128` or `u64` | Instance | Instance lifetime | configured default |
| `ReputationFloor` | `i128` | Instance | Instance lifetime | `0` |
| `ReputationEnabled` | `bool` | Instance | Instance lifetime | `false` |

This separates the current score from its last update time and makes the decay function deterministic. It also keeps the configuration keys at instance scope to avoid duplicating per-keeper metadata in the hot path.

## 4. Stable entry points and views

The first design should pin the following signatures before implementation begins.

### 4.1 Admin-configurable hooks

- `set_reputation_decay_rate(rate)`
- `set_reputation_floor(floor)`
- `set_reputation_enabled(enabled)`

These are admin-controlled because they change the network's quality gate or scoring policy. The exact values should be small, conservative, and auditable.

### 4.2 Keeper-facing views

- `reputation(keeper: Address) -> i128`
- `reputation_ready_for_claim(keeper: Address) -> bool` (optional; only if a floor is enforced)

### 4.3 Internal update path

The contract should have internal helpers such as:

- `record_success(keeper)`
- `record_missed_claim(keeper)`
- `record_slash(keeper, amount)`

Those helpers are not public ABI surface; they are the internal transition functions that the task lifecycle and staking logic call when relevant events occur.

## 5. Why this design is the right first step

This is a deliberately small and auditable model:

- it uses contract-observable actions as inputs;
- it stores compact aggregate state instead of entire history;
- it allows a future claim-priority or eligibility policy without overcommitting to one immediately;
- it leaves slashing and dispute semantics to E06, which keeps the dependency explicit and safe.

The key design principle is: reputation should be a durable, on-chain signal, not a speculative one-off heuristic.

## 6. Explicit non-goals

This doc does not define:

- full social scoring or identity reputation;
- subjective off-chain trust ratings;
- a reputation-weighted vote or governance power model;
- automatic slash severity scaling based on reputation.

Those are future epics and must be added only once the base reputation primitive is stabilized.

## 7. Implementation boundary

The implementation should not begin until the following are fixed in the design review:

- the exact scoring deltas and their sign conventions;
- whether claim ordering or eligibility gates are enabled in the first release;
- the decay rate and precise time basis (ledger-based or timestamp-based);
- whether slash events are included immediately or gated behind E06's completion.

This keeps the contract surface stable and prevents a reputation system from being built against a moving target.
