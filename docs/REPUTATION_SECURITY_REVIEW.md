# Reputation Security Review (Epic E07, issue #464 / 0336)

## Purpose and scope

Epic E19 (Security & Audit Readiness) asks every implementation epic to
close with a dedicated security pass, as the verifier (issue 0089), indexer
(issue 0248) and staking (issue 0311, `docs/STAKING_SECURITY_REVIEW.md`)
epics already did. This document is that pass for keeper reputation.

It reviews the code that shipped, not the design intent in
`docs/REPUTATION_DESIGN.md`:

- `contracts/keeper-registry/src/reputation.rs`: the `ReputationRecord`
  (`successes`, `missed_claims`, `score_bps`, `last_updated_ledger`), the
  score `successes * 10_000 / (successes + missed_claims)`, and the lazy
  decay in `effective_record`, which halves the score once per
  `REPUTATION_DECAY_HALF_LIFE_LEDGERS` (100,000 ledgers) since the last
  update.
- The two write paths in `contracts/keeper-registry/src/task.rs`:
  `execute_task` calls `record_success` for the executing keeper, and
  `claim_task` calls `record_missed_claim` for the previous claimer when it
  takes over a `Claimed` task whose lock window has expired.
- The eligibility floor from backlog 0323. It is not on `main` yet; the
  proposal under review is open PR #612 (`set_reputation_floor`, and a
  `claim_task` check that rejects a keeper whose **stored** `score_bps` is
  below the floor, including new keepers whose score is 0). Findings about
  the floor apply to any floor over this score, and name the PR's specific
  choices where they matter.

Issue #464 requires three concerns to be addressed explicitly:

1. Whether a keeper can inflate its own reputation by self-dealing.
2. Whether the decay function can be exploited by timing activity around
   decay boundaries.
3. Whether the eligibility floor creates a perverse incentive to avoid
   risky-but-legitimate tasks.

All three apply. Each is a design-level property of the score rather than
a coding bug, and fixing any of them changes what the score means, so this
review proposes mitigations and records known limitations rather than
changing contract code. The main conclusion is at the end: **the score
should stay informational, and no non-zero floor should be enabled on a
deployment carrying real value, until Finding 1 is mitigated.**

### How the findings were confirmed

`main` does not compile at the time of writing (commit `cbe1e74`, a
conflicted merge of the two E06 staking PRs), so each finding was
reproduced against commit `5a88e04` (PR #605). That commit's
`reputation.rs` is byte-identical to `main`'s, and its `claim_task` and
`execute_task` reputation call sites are the same; the only `task.rs`
difference is the later staking gate. The reproductions are described
step by step in each finding so they can become regression tests once a
mitigation lands.

## Finding 1: Self-dealing inflates reputation at no cost

**Severity: High if a floor or any on-chain priority reads the score;
Medium while the score is informational only. Status: Open, known
limitation, mitigation proposed below.**

### The vector

Nothing stops one address from being both a task's owner and its keeper.
`register_task` authorizes the owner, `claim_task` and `execute_task`
authorize the keeper, and neither compares the two. Every successful
execution calls `record_success`, however the task came to exist.

The cost of a self-dealt success is only the protocol fee on the reward
plus transaction fees. The owner funds the escrow and the same address,
as keeper, is credited `reward - fee` back. With the defaults, that fee is
zero:

- `min_reward` defaults to 0, so a 1-stroop reward is accepted.
- `split_reward` floors the fee. At the default 300 bps, any reward below
  34 stroops pays no fee (see `split_reward`'s "Dust threshold" section).
- The E06 minimum stake is not consumed by claiming, so it is not a
  per-task cost either.

Reproduced: a keeper with one real missed claim (score 0) registered,
claimed and executed 99 tasks it owned with a reward of 1 stroop each. Its
record became `successes: 99, missed_claims: 1, score_bps: 9_900`, total
fees accrued from those 99 tasks were 0, and after `withdraw_rewards` its
token balance was exactly what it started with. A 33-stroop self-owned
task also accrued no fee.

Because the score is a rate, farmed successes also dilute real misses. A
keeper with `m` real misses reaches any target rate `r` with
`s = r * m / (1 - r)` self-dealt successes: 99 per miss for 99%, 9 per
miss for 90%. `ReputationRecord` exposes the raw counts so readers can
judge sample size, but self-dealt successes look exactly like real ones.

### Why an owner != keeper check alone is not enough

Rejecting `task.owner == keeper` in `execute_task` (or skipping
`record_success` in that case) blocks the trivial form only. The owner and
keeper can be two addresses controlled by one party, and a second Stellar
address costs almost nothing. That check is worth adding as the cheap
first layer, but it changes the attacker's cost by one account, not per
task.

### Proposed mitigation

In order of how much each would reduce the vector:

1. **Only count successes that paid a fee, or that meet a reputation-
   qualifying reward.** Have `execute_task` call `record_success` only when
   `fee > 0`, or when `task.reward >= min_reputation_reward`, a new
   admin-set value. Then each farmed success costs at least the fee on
   that reward, and that fee goes to the protocol, not back to the
   farmer. Sybils cannot avoid it. This is the only mitigation here that
   puts a price on every farmed success.
2. **Skip `record_success` when `task.owner == keeper`.** It is cheap and
   removes the zero-effort form, as described above.
3. **Off-chain consumers (keeper bots, dashboards, the indexer) should
   rebuild the score from events** rather than trust `score_bps`: join
   `("exec", "task")` to `("reg", "task")` by task id, drop
   owner == keeper pairs, drop rewards below a meaningful threshold, and
   weight successes by reward value. This works today, with no contract
   change.

**Known limitation until (1) ships:** `score_bps` and the counts behind it
can be inflated for the cost of transaction fees alone. They must not gate
anything of value.

## Finding 2: Decay resets on any action, and a miss can raise the effective score

**Severity: Medium (the decayed score is misleading; it does not move
funds). Status: Open, known limitation, redesign proposed below.**

### How decay actually behaves

`effective_record` computes
`score_bps >> ((current_ledger - last_updated_ledger) / 100_000)`. Both
`record_success` and `record_missed_claim` set `last_updated_ledger` to the
current ledger and recompute `score_bps` from the full `successes` and
`missed_claims` counts. Decay is applied only when the score is read, and
nothing is written back. So:

- **Decay measures time since the last action, not the age of old
  failures.** The counts never decay. A miss from a year ago weighs the
  same as one from yesterday, which is the opposite of the intent in
  `docs/REPUTATION_DESIGN.md` §2.3 ("very old failures matter less than
  recent ones").
- **Any action fully undoes the decay.** The next recorded event
  recomputes the score from the undecayed counts.
- **A missed claim can raise the effective score.** Reproduced: a keeper
  with 10 successes (10,000 bps) idle for 200,000 ledgers shows an
  effective 2,500 bps. After one missed claim its record is
  `successes: 10, missed_claims: 1` and its effective score is **9,090**.
  A failure improved the score reading by 6,590 bps.

### Timing around decay boundaries

The decay is a step function. Reproduced: an effective score of 10,000 at
99,999 ledgers after the last action becomes 5,000 at exactly 100,000.
There are two ways to use this timing:

- **Never cross a boundary.** Recording one action every 99,999 ledgers
  (~5.8 days at 5 s per ledger) keeps the effective score equal to the
  stored one indefinitely. With Finding 1, that action is a self-dealt
  1-stroop task costing only transaction fees, so decay places no real
  pressure on an active keeper.
- **Reset after crossing one.** Because any action restores the full rate,
  a keeper that did cross a boundary loses nothing lasting.

The arithmetic itself is sound. `saturating_sub` handles a
`last_updated_ledger` above the current ledger, a shift of 32 or more
yields 0 instead of overflowing, and the view writes nothing, so it cannot
be raced or front-run. The problem is what decay measures, not how it is
computed.

### Interaction with the floor

PR #612's floor reads the **stored** `score_bps`, not
`effective_reputation`, so today decay has no effect on eligibility. That
is the safer choice and should be kept. A floor over the effective score
would permanently lock out any keeper idle for long enough: it could not
claim, so it could not record the action that would restore its score.

### Proposed redesign

Decay the counts rather than the rate, applied lazily when the next event
is recorded. At each update, first halve `successes` and `missed_claims`
once for each full half-life elapsed since `last_updated_ledger`, then add
the new event. Old failures then genuinely fade, a miss can never raise
the score, and the stored and effective scores match right after every
update. A keeper that stays idle keeps its rate but loses sample size,
which readers can see in the counts. This changes the stored-record
semantics, so it needs its own design issue and a `VERSION` bump.

## Finding 3: A floor penalizes risk-taking, not unreliability

**Severity: Medium, High once a floor is enabled. Status: Open,
recommendation below.**

Yes, this concern applies. Four properties of the score, taken together,
make a floor select for keepers who avoid risk or game the score rather
than for reliable ones.

1. **One miss costs a low-volume keeper far more than a high-volume
   one.** For a keeper with `n` recorded actions, one miss moves the rate
   by roughly `rate / (n + 1)`. A keeper at 5/5 (10,000 bps) drops to
   8,333 bps. A keeper at 500/500 drops to 9,980. Newer and smaller
   keepers are the ones pushed below the floor by a single miss.
2. **A miss is recorded only when another keeper takes over the task.**
   Reproduced: a keeper that claimed a task and let it expire with no
   takeover still had an empty record after `expire_task`. Abandoning a
   task is free in a thin market and penalized in a contested one, and
   contested tasks are exactly the valuable, time-sensitive ones (such as
   liquidations) that a keeper takes a real chance on.
3. **A third party can force a miss on a chosen keeper.** Reproduced: an
   owner registered a 1,000,000-stroop task with a verifier that rejects.
   The victim claimed it and its `execute_task` returned
   `VerificationFailed`. After the lock expired, a second address
   controlled by the owner took over the task, which recorded a miss for
   the victim. After that address's own lock expired, the owner called
   `cancel_task`, which records no miss for anyone. The victim ended with
   `missed_claims: 1` and the owner recovered all 1,000,000 stroops,
   spending only transaction fees. Simulating `verify` before claiming
   does not protect the victim: the verifier receives the keeper's
   address, and can read state the owner changes after the claim, so it
   can approve the simulation and reject the real call.
   Verifier-attached tasks from unknown owners are therefore exactly the
   "risky-but-legitimate" tasks the issue asks about. Under a floor, a
   rational keeper near the line declines them.
4. **Self-dealing (Finding 1) is the cheapest hedge.** A keeper worried
   about the floor can farm a large cushion of successes at no cost, so
   no single miss can move it. The floor then binds only on honest keepers
   who do not farm, the reverse of its purpose.

There is also a closed-door effect. With PR #612's floor, any non-zero
floor rejects addresses with no history (score 0), and the PR notes this
is deliberate, since exempting new addresses would let a low-score keeper
evade the floor with a fresh address. The consequence is that a new keeper
can never claim its first task, so the keeper set freezes at whoever
qualified before the floor was set.

### Recommendation

- **Do not enable a non-zero floor on a deployment carrying real value
  until Finding 1's mitigation (1) ships.** Until then the floor excludes
  honest keepers without excluding gamed ones. Setting the floor to 0,
  PR #612's default, keeps behavior identical to today.
- **Base any future floor on a confidence-aware score rather than the raw
  rate.** Two options: require a minimum number of recorded actions before
  the floor applies (together with Finding 1's fee rule, so those actions
  cost something), or compare the floor with a lower confidence bound
  such as the Wilson lower bound on `successes / (successes +
  missed_claims)`. Either one stops a single miss from sinking a
  low-volume keeper.
- **Record the targeted-miss vector (3) as a known limitation of
  owner-chosen verifiers.** Excusing a miss after a `VerificationFailed`
  attempt is not a safe fix on its own: a squatter could then submit
  garbage proofs to verifier-attached tasks to avoid misses. Any change
  here needs its own design issue.
- **Keeper bots** should treat verifier-attached tasks from owners with
  no history as higher risk, and should prefer tasks where a takeover by
  a competitor is unlikely. That is voluntary, bot-side policy, in line
  with `docs/REPUTATION_DESIGN.md`'s "Off-chain use" section.

## Summary

| # | Concern | Applies? | Status |
|---|---------|----------|--------|
| 1 | Self-dealing inflates reputation | Yes. Zero cost with default `min_reward` and fee rounding. A sybil address bypasses an owner != keeper check. | Known limitation. Mitigation proposed: fee-paying successes only, plus an owner != keeper skip and event-based consumers. |
| 2 | Decay exploitable by timing | Yes. Decay resets on any action, so one cheap action per 99,999 ledgers holds it off. A miss can raise the effective score. | Known limitation. Count-based decay proposed. Floor must keep reading the stored score. |
| 3 | Floor discourages risky-but-legitimate tasks | Yes. Low-volume keepers are the most exposed, a third party can force a miss via a verifier, farming is the cheapest hedge, and new keepers are shut out. | Recommendation: keep the floor at 0 until Finding 1 is mitigated, and use a confidence-aware floor. |

No code change was made as part of this review. Each finding is a
property of how the score is defined, and each fix changes that
definition, so each needs its own design decision and issue, as the staking
review did for its Finding 4.

## For a future external auditor (epic E19)

- Treat `score_bps` and `effective_reputation` as **unauthenticated,
  self-reportable data** until Finding 1's mitigation (1) is on `main`.
  Any code path that gates value on them is in scope.
- Check whether `set_reputation_floor` (PR #612, if merged) has been set
  above 0 on the deployment under review, and whether Findings 1 and 3
  have been addressed first.
- The reproduction steps above are written to be turned directly into
  regression tests in `contracts/keeper-registry/src/test/reputation.rs`
  when each mitigation lands. Each test should assert the fixed behavior,
  as the staking review's regression tests do.
