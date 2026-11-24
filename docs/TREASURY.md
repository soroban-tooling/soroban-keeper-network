# Treasury and Fee Distribution Explained

This page follows protocol fees from the moment a task is executed to the
moment a recipient withdraws them: how fees **accrue** in the registry, how
they are **swept** out, and how the treasury contract **splits** them among
recipients, including exactly how rounding works.

Everything here is taken from `contracts/keeper-registry/src`
(`task.rs`, `internal.rs`, `admin.rs`) and `contracts/treasury/src`
(`distribution.rs`, `admin.rs`, `internal.rs`). Amounts are in stroops of the
reward token (1 XLM = 10,000,000 stroops).

> **Read this before sweeping to the treasury address.** In the current code,
> `Treasury::distribute` pulls tokens from the *caller*. It does not read or
> distribute tokens that were transferred to the treasury contract by
> `sweep_fees`. The tested flow is to sweep to an address you control and then
> call `distribute` from it. See [Where the funds sit](#where-the-funds-sit).
> [TREASURY_DESIGN.md](TREASURY_DESIGN.md) describes a different, earlier design
> (a `set_recipients` call, an `undistributed()` view and a primary-recipient
> remainder rule) that the contract does not implement. This page follows the
> code.

## Contents

1. [The flow](#1-the-flow)
2. [Step 1: fees accrue in the registry](#2-step-1-fees-accrue-in-the-registry)
3. [Step 2: the admin sweeps fees](#3-step-2-the-admin-sweeps-fees)
4. [Step 3: configuring recipients](#4-step-3-configuring-recipients)
5. [Step 4: distribution and rounding](#5-step-4-distribution-and-rounding)
6. [Step 5: recipients withdraw](#6-step-5-recipients-withdraw)
7. [Worked example](#7-worked-example)
8. [Reconciling with events and views](#8-reconciling-with-events-and-views)
9. [Errors](#9-errors)

## 1. The flow

```text
 task owner                keeper
     |                        |
     | register_task          | claim_task, execute_task
     v                        v
+---------------------------------------------------+
|                  KeeperRegistry                   |
|                                                   |
|  reward escrow --execute_task--> keeper credit    |
|                       |          (reward - fee)   |
|                       +--------> FeesAccrued      |
|                                  (fee)            |
+--------------------------------+------------------+
                                 |
                                 | sweep_fees(admin, to, amount)   [admin only]
                                 | plain token transfer, any amount
                                 | up to fees_accrued()
                                 v
                          an address `to`
                                 |
                                 | distribute(caller, amount)      [anyone]
                                 | caller pays; split by shares
                                 v
+---------------------------------------------------+
|                     Treasury                      |
|                                                   |
|   recipient A balance   recipient B balance  ...  |
+--------------------------------+------------------+
                                 |
                                 | withdraw(recipient)             [each recipient]
                                 v
                          recipient's account
```

| Stage | Contract | Entry point | Who may call |
|-------|----------|-------------|--------------|
| Fee taken | registry | `execute_task` | the claiming keeper |
| Fee rate | registry | `set_fee_bps(admin, new_bps)` | admin |
| Fee swept | registry | `sweep_fees(admin, treasury, amount)` | admin |
| Recipients set up | treasury | `add_recipient`, `update_recipient_shares`, `remove_recipient` | admin |
| Split | treasury | `distribute(caller, amount)` | anyone, paying with their own tokens |
| Paid out | treasury | `withdraw(recipient)` | the recipient |

Two separate contracts, two separate steps. Neither contract calls the other,
so a problem in one cannot block the other.

## 2. Step 1: fees accrue in the registry

When a keeper's `execute_task` succeeds, the registry splits the task's reward
with `split_reward`:

```text
fee        = floor(reward * fee_bps / 10,000)
keeper_net = reward - fee
```

`keeper_net` is credited to the keeper (or held as a pending credit if a
dispute window is set). `fee` is added to the `FeesAccrued` counter in the
registry's instance storage. Read it with `fees_accrued()`.

- `fee_bps` defaults to `0`, so a registry that was never configured takes no
  fee. The admin changes it with `set_fee_bps`, which rejects anything above
  `10,000` (`InvalidFeeBps`). The new rate applies only to tasks executed after
  the change; fees already accrued are untouched.
- A reward forfeited by an upheld execution dispute is also added to
  `FeesAccrued`.

**Rounding at this step.** Division rounds down, always in the keeper's favor:
the protocol can never take more than the nominal rate, and
`keeper_net + fee == reward` exactly, so no value is created or lost. For small
rewards the fee can be zero. At 300 bps (3%) a reward of 33 stroops yields a fee
of 0, and 34 stroops yields 1. The threshold is
`ceil(10,000 / fee_bps)`.

Example at 300 bps: a reward of 1,234,567 gives
`fee = floor(1,234,567 × 300 / 10,000) = 37,037` and a keeper credit of
1,197,530.

## 3. Step 2: the admin sweeps fees

`sweep_fees(admin, treasury, amount)` moves `amount` of accrued fees out of the
registry:

- Admin only.
- `amount` must be positive (`InvalidReward` otherwise) and at most
  `fees_accrued()` (`NoRewardsAvailable` otherwise). Partial sweeps are fine.
- It reduces `FeesAccrued` first, then transfers the tokens, and emits
  `("sweep","admin")` with `(treasury, amount, remaining)`.
- It can only ever move accrued fees, never task escrow, keeper balances or
  staked collateral. After a sweep the registry still holds everything it owes:
  open escrow, keeper balances, stake, and any fees not yet swept.
- The `treasury` argument is just a destination address. The registry does not
  store it and never calls into the treasury contract. There is no rounding in
  a sweep.

## 4. Step 3: configuring recipients

The treasury is deployed and set up separately: `initialize(admin,
reward_token)` once, then the admin lists who gets paid.

- `add_recipient(admin, recipient, shares_bps)`
- `update_recipient_shares(admin, recipient, new_shares_bps)`
- `remove_recipient(admin, recipient)`

Rules:

- Each recipient's `shares_bps` must be between `1` and `10,000`
  (`InvalidShares` otherwise).
- At most `50` recipients (`MAX_RECIPIENTS`); more fails with
  `TooManyRecipients`. Duplicates fail with `RecipientAlreadyExists`.
- The sum of all shares must not exceed `500,000` (`MAX_TOTAL_SHARES`).
- **Shares are relative weights, not percentages.** They do not have to add up
  to 10,000. Each recipient receives `shares / total_shares` of every
  distribution, where `total_shares` is the sum at the time of the call. Three
  recipients with shares 1, 1 and 1 split an amount into thirds, the same as
  3,333 each.
- Removing a recipient drops it from future distributions. Its already-credited
  balance stays and it can still withdraw.

Changing shares affects only future calls to `distribute`. Balances already
credited are never recalculated.

## 5. Step 4: distribution and rounding

`distribute(caller, amount)` is **permissionless**: anyone may call it. The
caller authorizes the call and supplies the tokens.

For every recipient with non-zero shares:

```text
share_amount = floor(amount * recipient_shares / total_shares)
```

Each `share_amount` is credited to that recipient's balance. The treasury then
pulls **only the sum actually credited** from the caller.

### Rounding behavior

- **Each recipient's share rounds down.** No recipient can receive more than its
  exact proportion.
- **The leftover is never collected.** If the shares do not divide `amount`
  evenly, the sum credited is slightly less than `amount`. The difference
  (`requested - credited`) is simply not pulled from the caller. It stays in the
  caller's account and is not stranded in the contract. It is not redirected to
  any recipient.
- **The leftover is small.** Each recipient loses less than 1 stroop to
  rounding, so the leftover is smaller than the number of recipients. With the
  maximum of 50 recipients it is at most 49 stroops per call.
- **Tiny amounts can credit nobody.** A recipient whose rounded share is 0
  receives nothing from that call. If every share rounds to 0, nothing is pulled.
- **The event shows both numbers.** `("dist","total")` carries
  `(caller, requested, credited, breakdown)`, where `breakdown` lists every
  registered recipient in registration order with its credited amount
  (including 0). The amounts in `breakdown` sum to `credited`. One
  `("dist","recip")` event is also emitted per recipient with a non-zero credit.
- **Splitting a distribution into many small calls does not help anyone.**
  Each call rounds on its own, and each costs a transaction fee.

Other rules for `distribute`: `amount` must be positive (`InvalidAmount`), at
least one recipient must exist (`NoRecipients`), and it is blocked while the
treasury is paused (`ContractPaused`). Recipient balances are credited before
the token transfer, so a reentrant token cannot observe a half-finished split.

## 6. Step 5: recipients withdraw

Distribution only credits internal balances. Each recipient pulls its own funds
with `withdraw(recipient)`, which pays out the whole balance and returns it. A
zero balance fails with `NoRewardsAvailable`. The balance is zeroed before the
transfer, and `withdraw` is never blocked by a pause. Because the treasury
credits balances and does not push tokens, one recipient that cannot receive
tokens cannot block the others.

## 7. Worked example

A registry at 300 bps. Two tasks are executed, with rewards 1,000,000 and
1,234,567.

**1. Accrual.** Fees are `floor(1,000,000 × 300 / 10,000) = 30,000` and `37,037`.
`fees_accrued()` returns `67,037`. Keeper credits are 970,000 and 1,197,530.

**2. Sweep.** The admin calls `sweep_fees(admin, admin, 67037)`. The registry's
`fees_accrued()` drops to `0` and the admin's account receives 67,037 tokens.
The registry keeps exactly the open escrow plus the two keeper credits.

**3. Recipients.** The treasury has three recipients: a DAO with 5,000 shares, a
staking pool with 3,333 and a public-goods fund with 1,667. Total shares are
10,000.

**4. Distribution.** The admin calls `distribute(admin, 67037)`:

| Recipient | Shares | Exact | Credited (rounded down) |
|-----------|--------|-------|-------------------------|
| DAO | 5,000 | 33,518.50 | 33,518 |
| Staking pool | 3,333 | 22,343.43 | 22,343 |
| Public goods | 1,667 | 11,175.07 | 11,175 |
| **Total credited** | | | **67,036** |

The treasury pulls 67,036 from the admin, not 67,037. The 1 remaining stroop
stays with the admin. `("dist","total")` reports `requested = 67037` and
`credited = 67036`.

**5. Withdrawal.** Each recipient calls `withdraw` and receives its credited
amount.

This sequence is exercised by
`test_sweep_fees_round_trip_through_treasury_distribution` in
`contracts/keeper-registry/src/test/withdraw.rs`.

## Where the funds sit

`sweep_fees` is a plain token transfer to whatever address you pass. If that
address is the treasury **contract**, the tokens arrive in the treasury's token
balance, but the treasury does not track or distribute its own balance.
`distribute` always pulls from its `caller`. Tokens swept straight to the
treasury contract's address therefore cannot be handed out by the current
`distribute`.

Until that is changed, follow the tested path:

1. `sweep_fees` to an address you control (the admin account in the test).
2. Call `distribute` from that address with the amount you want to split.

Check this against the treasury version you are running before moving real
funds, and confirm with a small amount first.

## 8. Reconciling with events and views

| Question | Source |
|----------|--------|
| What has the registry earned and not yet swept? | `fees_accrued()` |
| What did each sweep move? | registry `("sweep","admin")`: `(treasury, amount, remaining)` |
| How was each distribution split? | treasury `("dist","total")` and `("dist","recip")` |
| Lifetime total credited to anyone | `total_distributed()` |
| One recipient's withdrawable balance | `recipient_balance(recipient)` |
| One recipient's lifetime credits | `recipient_total_received(recipient)` |
| Current recipients and shares | `recipients()`, `recipient_shares(recipient)` |
| Paid out | treasury `("wdraw","recip")` |

`total_distributed()` should equal the sum of the `credited` values of all
`("dist","total")` events. The full event reference is
[TREASURY_EVENTS.md](TREASURY_EVENTS.md).

## 9. Errors

| Contract | Error | Code | When |
|----------|-------|------|------|
| registry | `InvalidFeeBps` | 10 | `set_fee_bps` above 10,000. |
| registry | `InvalidReward` | 8 | `sweep_fees` with a non-positive amount. |
| registry | `NoRewardsAvailable` | 13 | `sweep_fees` above `fees_accrued()`. |
| treasury | `ContractPaused` | 3 | `distribute` while paused. |
| treasury | `NotInitialized` | 4 | Called before `initialize`. |
| treasury | `RecipientNotFound` | 5 | Update or remove of an unknown recipient. |
| treasury | `RecipientAlreadyExists` | 6 | Adding a duplicate. |
| treasury | `InvalidShares` | 7 | Shares outside `1..=10,000`, or total above 500,000. |
| treasury | `NoRecipients` | 8 | `distribute` with no recipients. |
| treasury | `InvalidAmount` | 9 | `distribute` with a non-positive amount. |
| treasury | `NoRewardsAvailable` | 10 | `withdraw` with a zero balance. |
| treasury | `ArithmeticOverflow` | 11 | Arithmetic would overflow. |
| treasury | `TooManyRecipients` | 12 | More than 50 recipients. |

Treasury and registry error numbers are separate enums, so the same number can
mean different things in each. Decode them against the contract you called.

## See also

- [TREASURY_DESIGN.md](TREASURY_DESIGN.md): design rationale and the
  alternatives that were rejected.
- [TREASURY_EVENTS.md](TREASURY_EVENTS.md): every treasury event and how to
  rebuild the recipient configuration from events.
- [TREASURY_SECURITY_REVIEW.md](TREASURY_SECURITY_REVIEW.md): review findings.
- [ARCHITECTURE.md](ARCHITECTURE.md): the registry's money invariants.
