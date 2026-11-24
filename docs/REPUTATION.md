# How Keeper Reputation Is Scored and Used

Every keeper address has a reputation record in the registry. This page
explains in plain language what goes into it, how it fades over time, and the
one place the contract actually uses it. It also lists what reputation does
**not** do, because it is easy to assume more than the contract delivers.

It describes the shipped behavior in
`contracts/keeper-registry/src/reputation.rs` and the claim check in
`task.rs`. The reasoning for keeping reputation informational is in
[REPUTATION_DESIGN.md](REPUTATION_DESIGN.md): its opening sections (Scope,
Recommendation, Eligibility floor) match the code. Its later "Reputation
Design (E07)" sections are an earlier proposal (an `i128` score, a configurable
decay rate, an enable flag) that was not built in that form. This page follows
the code.

## Contents

1. [The score in one paragraph](#1-the-score-in-one-paragraph)
2. [What changes the record](#2-what-changes-the-record)
3. [Successful-task rate](#3-successful-task-rate)
4. [Read-time decay, with a worked example](#4-read-time-decay-with-a-worked-example)
5. [The eligibility floor](#5-the-eligibility-floor)
6. [What reputation does not affect](#6-what-reputation-does-not-affect)
7. [Reading reputation](#7-reading-reputation)

## 1. The score in one paragraph

The registry counts two things per keeper: tasks it **executed successfully**,
and tasks it **claimed but let the lock window expire** so that another keeper
took over (a "missed claim"). The score is the share of successes among those
two counts, in basis points (1 bp = 0.01%, so 10,000 is a perfect record). The
stored counts never decay. A separate read-time view shows a **decayed** score
that halves for every 100,000 ledgers (about 5.8 days) since the keeper's last
tracked action. The contract uses the **stored** score in exactly one place,
the optional eligibility floor, which is off by default.

## 2. What changes the record

Only two events touch a keeper's record, and each writes it exactly once:

| Event | Effect | Where |
|-------|--------|-------|
| `execute_task` succeeds for the claimer | `successes` +1 | `task.rs`, `record_success` |
| A different caller's `claim_task` succeeds on a task whose lock window has expired | `missed_claims` +1 for the **previous** claimer | `task.rs`, `record_missed_claim` |

Both also set `last_updated_ledger` to the current ledger and recompute the
score.

Things that do **not** change the record:

- A rejected `execute_task` (bad proof, verifier says no, deadline passed). The
  call reverts, so nothing is written.
- A rejected `claim_task`, including one blocked by the reputation floor, a
  minimum stake, or an unmet task condition. A rejected takeover records no
  missed claim against the old claimer.
- A lock window that expires with **nobody** taking over. A missed claim is
  recorded only when a takeover claim actually succeeds, not when the time
  passes.
- `expire_task`, `cancel_task`, withdrawing rewards, staking, and slashing.
  Being slashed does not lower your reputation, and a good reputation does not
  shield you from a slash.

If the keeper that lets a lock expire is the same one that reclaims the task,
the takeover still counts as a missed claim against it.

## 3. Successful-task rate

```text
score_bps = successes * 10,000 / (successes + missed_claims)     (integer division, rounds down)
```

An address with no tracked actions has a zero record: `successes = 0`,
`missed_claims = 0`, `score_bps = 0`.

| Successes | Missed | Score (bps) | As a percentage |
|-----------|--------|-------------|-----------------|
| 2 | 1 | 6,666 | 66.66% |
| 9 | 1 | 9,000 | 90.00% |
| 10 | 1 | 9,090 | 90.90% |
| 5 | 0 | 10,000 | 100.00% |
| 0 | 3 | 0 | 0% |

(The 2-and-1 row is the case checked in the registry's reputation tests.)

Because the counts are kept, you can judge how much to trust a number: 100% from
one task is very different from 100% from five hundred. Read the counts, not
just the score.

## 4. Read-time decay, with a worked example

The stored record never changes between actions. When you ask for the
**effective** reputation, the score is shifted right (halved) once for every
complete 100,000 ledgers since `last_updated_ledger`:

```text
halvings        = (current_ledger - last_updated_ledger) / 100,000     (whole intervals only)
effective_score = stored_score >> halvings                              (floor of score / 2^halvings)
```

Between half-life boundaries the score is unchanged, and 32 or more halvings
give 0. Decay changes only the `score_bps` field of what the view returns. The
success and missed counts, and the stored record, are untouched.

**Example.** A keeper has 9 successes and 1 missed claim, so a stored score of
9,000. Its last tracked action was at ledger 2,000,000.

| Current ledger | Elapsed | Halvings | `effective_reputation` score |
|----------------|---------|----------|------------------------------|
| 2,000,000 | 0 | 0 | 9,000 |
| 2,099,999 | 99,999 | 0 | 9,000 |
| 2,100,000 | 100,000 | 1 | 4,500 |
| 2,200,000 | 200,000 | 2 | 2,250 |
| 2,300,000 | 300,000 | 3 | 1,125 |
| 2,400,000 | 400,000 | 4 | 562 (1,125 halved, rounded down) |

Now the keeper executes one more task at ledger 2,400,000. The counts become
10 successes and 1 missed, the score is recomputed from the counts as
10 × 10,000 / 11 = **9,090**, and `last_updated_ledger` resets to 2,400,000.
One new action replaces the faded figure with the true success rate, so
decay penalizes idleness without erasing history.

Decay is a **read-time signal for off-chain consumers**, such as dashboards,
task owners and bots. The contract's own checks use the stored score.

## 5. The eligibility floor

The admin may call `set_reputation_floor(admin, floor_bps)`. When the floor is
above zero, `claim_task` rejects a keeper whose **stored** score is below it
with `ReputationBelowFloor`.

- **Off by default.** The floor is `0`, which disables the check.
- **Range.** `0` to `10,000`. A higher value is rejected with
  `InvalidReputationFloor`, because no keeper could reach it. Each change emits
  `("repfloor","admin")` with the old and new floor.
- **Inclusive.** A score equal to the floor may claim.
- **Stored score, not decayed.** The check uses the stored score so that a
  reliable keeper is not locked out merely for being idle. In the example above
  the keeper's effective score at ledger 2,400,000 is 562, but with a floor of
  5,000 it can still claim, because its stored score is 9,000.
- **New addresses are not exempt.** An address with no history scores 0, so any
  non-zero floor blocks it until the floor is lowered. A floor therefore turns
  claiming into a curated, closed set. It is a policy switch for a deployment
  that wants one, not a default for a permissionless network.
- **Check order.** The floor is checked after the task-state checks and before
  any write. `ReputationBelowFloor` means "this task was claimable, but not by
  you."

How an operator uses this: read `reputation_floor()` on the registry you target.
If it is `0`, reputation does not gate you. If it is above `0` and you are new,
you need a registry admin to lower it or run on a deployment with no floor.

## 6. What reputation does not affect

Stated plainly, because most of these are things people expect:

- **Claim order and priority.** Claiming stays first come, first served. The
  contract cannot see which claim a keeper "sent first", so a higher score does
  not win a race. A low score does not delay you either. The only effect is the
  floor's yes/no gate.
- **Reward size or fees.** The reward you earn and the protocol fee are set by
  the task's `reward` and `fee_bps`. Reputation never changes them.
- **Your ability to finish a task you already hold.** `execute_task` does not
  look at reputation.
- **Lock windows and deadlines.** These come from the task, not the keeper.
- **Stake, slashing and appeals.** Staking is a separate system. See
  [STAKING_GUIDE.md](STAKING_GUIDE.md). Your slash history is separate from your
  reputation record.
- **Withdrawals.** Reputation never delays or blocks `withdraw_rewards` or
  `withdraw_stake`.
- **Anything off chain.** A bot or task owner may choose to prefer high-score
  keepers, but that is voluntary and the contract cannot enforce it.
- **Other keepers.** Each address has its own record, and a floor compares a
  keeper only to the floor, never to other keepers.

Also note that reputation belongs to an **address**. A new address starts at
zero, which is exactly why a non-zero floor excludes it.

## 7. Reading reputation

| View | Returns |
|------|---------|
| `keeper_reputation(keeper)` | The stored `ReputationRecord`: `successes`, `missed_claims`, `score_bps`, `last_updated_ledger`. A zero record if the keeper has no history. |
| `effective_reputation(keeper)` | The same record with `score_bps` decayed to the current ledger. |
| `reputation_floor()` | The admin-set floor, `0` if disabled. |

Both reputation views are read-only. They do not renew storage TTL. Each time a
keeper's record is written, its TTL is extended to about a year (6,300,000
ledgers).

```bash
stellar contract invoke --id $REGISTRY_ID --source keeper --network testnet \
  -- effective_reputation --keeper $KEEPER
```

## See also

- [REPUTATION_DESIGN.md](REPUTATION_DESIGN.md): why claim priority was rejected
  and why the floor uses the stored score.
- [REPUTATION_SECURITY_REVIEW.md](REPUTATION_SECURITY_REVIEW.md): review of the
  reputation surface.
- [STAKING_GUIDE.md](STAKING_GUIDE.md): the separate collateral system.
