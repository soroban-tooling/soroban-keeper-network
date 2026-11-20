# Staking Guide for Keeper Operators

This guide explains staking from the point of view of someone who runs a
keeper: why you might stake, how much, how to get your stake back, what can
take it from you, and what to do if you think a penalty was unfair.

It describes what the registry contract does today. Every entry point, error
and constant named here is taken from `contracts/keeper-registry/src`
(`staking.rs`, `constants.rs`, `errors.rs`, `views.rs`). For the reasoning
behind the design, see [STAKING_DESIGN.md](STAKING_DESIGN.md). Where that
document and this one disagree, this one follows the code.

All amounts are in stroops of the registry's reward token (native XLM on
testnet): 1 XLM = 10,000,000 stroops. A ledger closes roughly every 5 seconds,
so 17,280 ledgers is about one day.

## Contents

1. [Why stake](#1-why-stake)
2. [How much to stake](#2-how-much-to-stake)
3. [Entry points at a glance](#3-entry-points-at-a-glance)
4. [Unbonding and withdrawing](#4-unbonding-and-withdrawing)
5. [What gets slashed](#5-what-gets-slashed)
6. [Appeals](#6-appeals)
7. [Disputes over a task execution](#7-disputes-over-a-task-execution)
8. [Worked example: stake, unbond, withdraw](#8-worked-example-stake-unbond-withdraw)
9. [Errors you will meet](#9-errors-you-will-meet)

## 1. Why stake

Staking is collateral, not an investment. The registry pays **no interest or
yield** on stake, and a staked keeper gets **no priority** when claiming: claims
stay first-come-first-served.

The one thing stake buys you is eligibility. The admin can set a minimum stake
with `set_min_stake`. While it is above zero, `claim_task` rejects any keeper
whose bonded stake is below it, with `MinStakeNotMet`. The minimum defaults to
`0`, meaning no stake is needed to claim.

So the reasons to stake are:

- **The registry you target requires it.** Read `min_stake()` on that
  registry. If it returns `0` you do not need to stake to claim.
- **You want to signal commitment** to task owners and to whoever runs the
  admin key. Stake is visible on chain through `keeper_stake(keeper)`.

The cost is that your capital is locked, it can be slashed, and getting it
back takes the unbonding delay in [section 4](#4-unbonding-and-withdrawing).
If the registry has no minimum, you can run a keeper without staking at all.

## 2. How much to stake

There is no protocol-wide figure. Decide in this order:

1. **Read the floor.** Call `min_stake()`. Your bonded stake must be at least
   this to claim.
2. **Add headroom for your own unbonding.** The moment you call
   `initiate_unbond`, the amount leaves your bonded stake. If that drops you
   below the floor, every `claim_task` you send fails with `MinStakeNotMet`
   until you stake again. To keep running while you take some out, stake the
   floor plus the amount you expect to unbond.
3. **Add headroom for a slash.** A slash reduces your stake immediately. If
   it leaves you under the floor you cannot claim until you top up.
4. **Size it against what you can afford to lose.** The only party who can
   slash is the admin, and a successful appeal returns the stake
   ([section 6](#6-appeals)), but an appeal is not guaranteed.

Topping up is always allowed: calling `stake_deposit` again adds to your
bonded stake.

`stake_deposit` takes the tokens from your own account, so your account must
hold at least `amount` of the reward token and must authorize the call.

## 3. Entry points at a glance

| Entry point | Who calls it | What it does |
|-------------|--------------|--------------|
| `stake_deposit(keeper, amount)` | the keeper | Moves `amount` from the keeper to the contract and adds it to the keeper's bonded stake. |
| `initiate_unbond(keeper, amount)` | the keeper | Moves `amount` out of bonded stake into a pending request that unlocks after `UNBOND_DELAY_LEDGERS`. |
| `withdraw_stake(keeper)` | the keeper | Once the delay has passed, sends the pending amount back and returns it. |
| `slash(admin, keeper, amount, reason, treasury)` | the admin | Takes `amount` of the keeper's collateral and sends it to `treasury`. Returns a `slash_id`. |
| `raise_slash_appeal(keeper, slash_id)` | the slashed keeper | Flags a slash for the admin to review. |
| `resolve_slash_appeal(admin, slash_id, uphold_appeal)` | the admin | Refunds the keeper (`true`) or lets the slash stand (`false`). |
| `set_min_stake(admin, min_stake)` | the admin | Sets the minimum bonded stake `claim_task` requires. |
| `dispute_execution(owner, task_id)` | the task owner | Disputes a still-held reward credit. See [section 7](#7-disputes-over-a-task-execution). |
| `resolve_execution_dispute(admin, task_id, uphold_dispute)` | the admin | Resolves that dispute. |

Read-only views you will use:

| View | Returns |
|------|---------|
| `keeper_stake(keeper)` | Your **bonded** stake. It excludes anything already moved into an unbond request. |
| `pending_unbond(keeper)` | `None`, or the pending request: `amount` and `unlock_ledger`. |
| `min_stake()` | The current claim floor (`0` = none). |
| `get_slash(slash_id)` | A slash record (`keeper`, `amount`, `reason`, `ledger`, `appealed`), or `None` once it has been resolved. |
| `slash_history(keeper)` | `(count, total_slashed)` across every slash you have received. |
| `dispute_window()` | Ledgers a reward credit is held (`0` = disabled). |
| `pending_reward(keeper)` | Reward credits still being held. |

Events you can follow (topic pairs): `("stkdep","stake")` on deposit,
`("unbond","stake")` on unbond, `("stkwd","stake")` on withdrawal,
`("slash","stake")` on a slash, `("appeal","stake")` when an appeal is raised,
and `("resolve","stake")` when it is resolved. The full table is in the
README's Events section.

Pause behavior: while the registry is paused, `stake_deposit` and
`initiate_unbond` fail with `ContractPaused`. `withdraw_stake` and `slash` are
not blocked by a pause, so a pause does not trap stake that is already
unbonded.

## 4. Unbonding and withdrawing

Getting stake out is a two-step process with a fixed delay in between.

1. **`initiate_unbond(keeper, amount)`.** The `amount` is subtracted from your
   bonded stake right away, so `keeper_stake` falls and the `claim_task` floor
   sees the lower number. The tokens do **not** move yet. They sit in a
   pending request whose `unlock_ledger` is the current ledger plus
   `UNBOND_DELAY_LEDGERS`.
2. **`withdraw_stake(keeper)`.** Once the ledger sequence is at or past
   `unlock_ledger`, this sends the whole pending amount back to you, clears the
   request, and returns the amount. The boundary is inclusive: at exactly
   `unlock_ledger` the withdrawal already works.

`UNBOND_DELAY_LEDGERS` is **86,400 ledgers, about 5 days**. It is deliberately
longer than the 3-day appeal window so a slash raised against recent behavior
can still reach your stake before you can walk away with it.

Rules to remember:

- **One request at a time.** While a request is pending, a second
  `initiate_unbond` fails with `UnbondAlreadyPending`. It does not merge or
  replace the first. Withdraw first, then start another.
- **You cannot unbond more than you have bonded.** `amount` above your bonded
  stake fails with `InsufficientStake`. Stake already in a pending request does
  not count.
- **Amounts must be positive.** Zero or negative amounts fail with
  `InvalidReward` (the contract reuses that error for all non-positive
  amounts).
- **Withdrawing early fails.** `withdraw_stake` before `unlock_ledger` returns
  `UnbondNotReady`. With nothing pending it returns `NoPendingUnbond`.
- **Unbonding stake is still slashable.** See the next section.

## 5. What gets slashed

Slashing is **admin-triggered only**. Nothing in the contract slashes you
automatically: not a rejected proof, not a missed lock window, not a low
reputation score. A failed `execute_task` simply leaves the task claimed and
unpaid. A slash happens when the admin decides, off chain, that a keeper
misbehaved (for example a fraudulent proof reported by a verifier operator) and
submits `slash`.

What a slash does:

- Moves `amount` from your collateral to the `treasury` address the admin
  chose in that call. The funds leave the contract; they are not held while
  you appeal.
- Records a `SlashRecord` under a new `slash_id` and adds one to your
  `slash_history`.
- Emits `("slash","stake")` with `(slash_id, keeper, amount, reason)`.
  `reason` is a short `Symbol` code (at most 9 characters), not free text.

**Your unbonding stake is exposed too.** A slash draws from your bonded stake
first. If that is not enough, it takes the remainder from your pending unbond
request, reducing that request's amount without changing its `unlock_ledger`.
This is deliberate: otherwise a keeper could dodge a slash by calling
`initiate_unbond` just before it lands. The total a slash can take is bonded
stake plus the pending request. Asking for more fails with `InsufficientStake`.
It is rejected rather than reduced to what is left.

Consequences for you as an operator:

- The trust boundary is the admin key. A slash needs no vote or time lock.
- Slashing does not change your reputation score. The two systems are
  independent. See [REPUTATION.md](REPUTATION.md).
- Your reward balance (`keeper_balance`) and any held reward credits are
  separate from stake and are not touched by `slash`.

## 6. Appeals

A slashed keeper has a fixed window to contest the slash.

1. **Raise it.** Call `raise_slash_appeal(keeper, slash_id)` no later than
   `DISPUTE_WINDOW_LEDGERS` (**51,840 ledgers, about 3 days**) after the slash
   ledger. The deadline ledger itself is still accepted. Only the slashed
   keeper can appeal its own slash (`NotSlashedKeeper` otherwise), and only
   once per slash (`AppealAlreadyRaised`). After the window the call fails
   with `AppealWindowClosed`; an unknown id fails with `SlashNotFound`.
   Raising an appeal changes nothing by itself: it flags the record.
2. **The admin resolves it** with `resolve_slash_appeal(admin, slash_id,
   uphold_appeal)`:
   - `true` (upheld): the admin pays `record.amount` back into the contract
     and the same amount is added to your **bonded stake**. This is a real
     refund. The contract does not keep slashed funds in escrow, so the admin
     must supply them, normally by recovering them from the treasury first.
   - `false` (rejected): the slash stands and nothing moves.
   Either way the slash record is removed, so `get_slash` returns `None`
   afterward. Your `slash_history` is not reduced, even if the appeal is
   upheld.

Things to plan around:

- There is **no deadline on the admin** to resolve an appeal, and you cannot
  force a resolution. Keep your `slash_id`, your appeal transaction and the
  `("resolve","stake")` event so you can show what happened.
- Appeal inside the window. After 51,840 ledgers the slash is final.
- Find your `slash_id` in the `("slash","stake")` event or by scanning
  `get_slash`.

## 7. Disputes over a task execution

A separate, optional mechanism protects **rewards** rather than stake. It is
off by default (`dispute_window()` returns `0`), in which case an executed
task's reward is credited to you immediately and none of this applies.

When the admin sets a dispute window with `set_dispute_window` (up to 86,400
ledgers), each reward from `execute_task` is held as a pending credit for that
many ledgers instead of going straight to your withdrawable balance:

- During the hold, the **task's owner** may call `dispute_execution(owner,
  task_id)`. The disputed credit is frozen. Calling at or after the credit's
  unlock ledger fails with `DisputeWindowClosed`.
- The admin then calls `resolve_execution_dispute`. If the dispute is
  **upheld**, you are never paid that reward; the amount is added to the
  protocol's accrued fees. It does **not** automatically slash your stake.
  If rejected, the credit is released normally once its unlock ledger passes.
- Undisputed credits are moved to your withdrawable balance the next time you
  call `withdraw_rewards`.

If you operate where a dispute window is set, expect rewards to arrive
`dispute_window()` ledgers after execution, and watch `pending_reward`.

## 8. Worked example: stake, unbond, withdraw

Assume a registry with `min_stake` of `0`, a keeper account holding enough
tokens, and these ledger numbers for illustration. Replace `$REGISTRY_ID` and
`$KEEPER` with your own values; `keeper` is the name of your `stellar keys`
identity.

**Step 1. Stake 5 XLM (50,000,000 stroops).**

```bash
stellar contract invoke --id $REGISTRY_ID --source keeper --network testnet \
  -- stake_deposit --keeper $KEEPER --amount 50000000
```

The contract pulls 50,000,000 from the keeper and emits `("stkdep","stake")`
with `(keeper, 50000000, 50000000)`, the last number being the new total.
`keeper_stake` now returns `50000000`.

**Step 2. Unbond 2 XLM (20,000,000 stroops) at ledger 1,000,000.**

```bash
stellar contract invoke --id $REGISTRY_ID --source keeper --network testnet \
  -- initiate_unbond --keeper $KEEPER --amount 20000000
```

The unlock ledger is 1,000,000 + 86,400 = **1,086,400**. The event
`("unbond","stake")` carries `(keeper, 20000000, 1086400)`. Now:

| View | Value |
|------|-------|
| `keeper_stake` | `30000000` (the 20,000,000 left bonded stake immediately) |
| `pending_unbond` | amount `20000000`, unlock_ledger `1086400` |
| tokens held by the contract for you | still `50000000`: nothing has been paid out |

If the admin slashed 40,000,000 at this point, 30,000,000 would come from
bonded stake and the remaining 10,000,000 from the pending request, leaving a
request of 10,000,000 that still unlocks at ledger 1,086,400.

**Step 3. Try to withdraw too early.** At ledger 1,086,399:

```bash
stellar contract invoke --id $REGISTRY_ID --source keeper --network testnet \
  -- withdraw_stake --keeper $KEEPER
```

fails with `UnbondNotReady` (error 26). Nothing changes.

**Step 4. Withdraw.** At ledger 1,086,400 or later the same command succeeds.
It returns `20000000`, transfers 2 XLM back to the keeper, clears the pending
request, and emits `("stkwd","stake")` with `(keeper, 20000000)`. Afterward:

| View | Value |
|------|-------|
| `keeper_stake` | `30000000` |
| `pending_unbond` | none |

You now have 3 XLM bonded and can start another unbond, or top up with
`stake_deposit`. Each behavior in this example has a test in
`contracts/keeper-registry/src/test/staking.rs`, for instance
`test_initiate_unbond_reduces_effective_stake_immediately`,
`test_withdraw_stake_at_exact_boundary_succeeds` and
`test_slash_can_draw_from_pending_unbond_amount`.

## 9. Errors you will meet

Discriminants are part of the contract ABI and never change.

| Error | Code | When |
|-------|------|------|
| `InvalidReward` | 8 | A non-positive amount was passed to `stake_deposit`, `initiate_unbond`, `slash` or `set_min_stake` (negative). |
| `ContractPaused` | 3 | `stake_deposit` or `initiate_unbond` while the registry is paused. |
| `InsufficientStake` | 25 | Unbond amount above bonded stake, or a slash above bonded stake plus the pending request. |
| `UnbondNotReady` | 26 | `withdraw_stake` before the unlock ledger. |
| `UnbondAlreadyPending` | 27 | A second `initiate_unbond` while one is pending. |
| `NoPendingUnbond` | 28 | `withdraw_stake` with no request on file. |
| `MinStakeNotMet` | 29 | `claim_task` while your bonded stake is below `min_stake()`. |
| `SlashNotFound` | 30 | Unknown `slash_id`, or resolving a slash that was never appealed. |
| `AppealWindowClosed` | 31 | Appeal raised more than 51,840 ledgers after the slash. |
| `AppealAlreadyRaised` | 32 | A second appeal for the same slash. |
| `NotSlashedKeeper` | 33 | Someone other than the slashed keeper tried to appeal. |
| `NoPendingCredit` | 34 | `dispute_execution` found no held credit for that task. |
| `ExecutionAlreadyDisputed` | 35 | The credit is already disputed. |
| `DisputeWindowClosed` | 36 | `dispute_execution` at or after the credit's unlock ledger. |
| `NoDisputedCredit` | 37 | `resolve_execution_dispute` found no disputed credit. |

## See also

- [STAKING_DESIGN.md](STAKING_DESIGN.md): design decisions and trade-offs.
- [STAKING_SECURITY_REVIEW.md](STAKING_SECURITY_REVIEW.md): review findings,
  including why unbonding stake stays slashable.
- [REPUTATION.md](REPUTATION.md): the separate, informational score.
- [RUNNING_A_KEEPER.md](RUNNING_A_KEEPER.md): running the example bot.
