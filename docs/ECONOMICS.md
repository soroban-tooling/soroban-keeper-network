# Fee and Reward Economics

This guide explains how task owners should size task rewards and how keeper bots evaluate whether a task is profitable to claim and execute.

## Overview of Economic Parameters

Four parameters determine whether a task is accepted by `KeeperRegistry`, how much the keeper earns, and how much the protocol collects:

| Parameter | Source | Scope | Default / Typical Value |
|---|---|---|---|
| `reward` | Task owner (`register_task` / `batch_register_tasks`) | Per task | Must be `> 0` and `>= min_reward` |
| `min_reward` | Admin (`set_min_reward`) | Registry-wide | `0` (disabled) |
| `fee_bps` | Admin (`set_fee_bps`) | Registry-wide | `0` if unset (`DEFAULT_FEE_BPS`); typically `300` (3%) |
| `MIN_PROFIT_MARGIN_STROOPS` | Keeper operator (bot env var) | Per bot | `0` stroops |

All token amounts are denominated in **stroops** when using XLM (`1 XLM = 10_000_000 stroops`).

## On-Chain Protocol Fee Split

When a keeper executes a task via `execute_task`, `KeeperRegistry` splits the escrowed `reward` using `split_reward(reward, fee_bps)` in `contracts/keeper-registry/src/internal.rs`:

```text
protocol_fee = floor(reward * fee_bps / 10_000)
keeper_net   = reward - protocol_fee
```

Key guarantees:

- **Floor rounding in the keeper's favor:** Integer division truncates toward zero, so the protocol never collects more than the nominal `fee_bps` rate. The rounding shortfall is at most 1 stroop per execution.
- **Exact conservation:** `keeper_net + protocol_fee == reward` holds for all valid inputs.
- **Future-effective rate:** `set_fee_bps` applies to tasks executed after the change; already-accrued fees are unaffected.

### Minimum Reward and the Dust Threshold

Because `protocol_fee` rounds down, very small rewards yield a zero protocol fee:

```text
protocol_fee > 0  iff  reward >= ceil(10_000 / fee_bps)
```

For example, at `fee_bps = 300` (3%):

- `ceil(10_000 / 300) = 34` stroops.
- A reward of `33` stroops produces `protocol_fee = 0` and `keeper_net = 33`.
- A reward of `34` stroops produces `protocol_fee = 1` and `keeper_net = 33`.

Admins should set `min_reward` well above both the dust threshold and typical keeper transaction costs so tasks do not consume ledger storage while paying zero protocol fees or sitting unclaimed.

## Keeper Network Fees

Executing a task requires the keeper to pay Stellar/Soroban network fees across multiple steps:

1. **`claim_task` transaction fee** — baseline estimate: `10_000` stroops (`0.001 XLM`).
2. **`execute_task` transaction fee** — baseline estimate: `50_000` stroops (`0.005 XLM`).
3. **Optional verifier resource fee** — if the task attaches an `IKeeperVerifier` contract (`verifier: Some(addr)`), `execute_task` invokes `verify(...)`, adding CPU/footprint resource fees. Baseline estimate: `50_000` stroops (`0.005 XLM`).
4. **Amortized `withdraw_rewards` fee** — keepers accumulate credits in `KeeperReward(addr)` and withdraw periodically, amortizing the withdrawal transaction fee across many tasks.

## Keeper Bot Profitability Check

Both keeper bot implementations share the same profitability formula:

- **Keeper Bot v1** (`examples/keeper-bot/index.js`, `estimateTaskProfitability`)
- **Keeper Bot v2** (`examples/keeper-bot-v2/src/profitability.ts`, `estimateTaskProfitability`)

### Formula

```text
estimated_verifier_fee =
  if task.verifier is set:
    bot v1: simulated IKeeperVerifier::verify resource fee via RPC (fallback: 50_000 stroops)
    bot v2: configured estimatedVerifierFeeStroops (default: 50_000 stroops)
  else:
    0

total_estimated_fees =
  estimated_claim_fee          // default: 10_000 stroops
  + estimated_execute_base_fee // default: 50_000 stroops
  + estimated_verifier_fee     // 0 or 50_000 stroops (or simulated)

bot_net_profit = task.reward - total_estimated_fees
profitable     = bot_net_profit >= min_profit_margin_stroops
```

### Important Note on `fee_bps` vs. Bot Pre-Claim Estimate

Both bots currently compute `bot_net_profit` using the task's gross `task.reward` against `total_estimated_fees` and compare the result to `MIN_PROFIT_MARGIN_STROOPS`. They do not subtract `protocol_fee` inside `estimateTaskProfitability`.

Because the keeper's **realized** on-chain net profit after execution is:

```text
realized_net_profit = keeper_net - total_estimated_fees
                    = (reward - floor(reward * fee_bps / 10_000)) - total_estimated_fees
```

- **Keeper operators** should set `MIN_PROFIT_MARGIN_STROOPS` high enough to cover the active `fee_bps` cut plus their desired profit margin.
- **Task owners** should size `reward` so that `realized_net_profit` is positive and attractive even after `fee_bps` is deducted.

## How an Owner Should Size a Reward

To ensure keepers claim and execute a task promptly, size `reward` to satisfy all three constraints:

1. **Registry floor:** `reward >= min_reward` (query via `min_reward()`).
2. **Protocol fee gross-up:** Cover both keeper network fees and desired keeper margin after `fee_bps`:

```text
target_keeper_net = total_estimated_fees + desired_keeper_margin
recommended_reward = ceil(target_keeper_net * 10_000 / (10_000 - fee_bps))
```

3. **Urgency premium:** For time-sensitive tasks (e.g., liquidations or oracle updates with tight deadlines), add a margin above `total_estimated_fees` so keeper-bot v2's profit-descending ranker prioritizes your task ahead of lower-reward candidates.

## Worked Example

Suppose the registry is configured with:

- `fee_bps = 300` (3.00%)
- `min_reward = 100_000` stroops (`0.01 XLM`)

A keeper bot runs with default fee estimates and `MIN_PROFIT_MARGIN_STROOPS = 50_000` (`0.005 XLM`).

### Case A: Task Without a Verifier

An owner registers a task with `reward = 500_000` stroops (`0.05 XLM`) and `verifier = None`.

1. **Registry validation:** `500_000 >= 100_000` (`min_reward`) — accepted.
2. **Bot profitability check (v1 and v2):**
   - `estimated_claim_fee = 10_000` stroops
   - `estimated_execute_base_fee = 50_000` stroops
   - `estimated_verifier_fee = 0` stroops
   - `total_estimated_fees = 10_000 + 50_000 + 0 = 60_000` stroops
   - `bot_net_profit = 500_000 - 60_000 = 440_000` stroops
   - `440_000 >= 50_000` (`MIN_PROFIT_MARGIN_STROOPS`) -> **profitable = true** (bot claims the task).
3. **On-chain settlement (`execute_task`):**
   - `protocol_fee = floor(500_000 * 300 / 10_000) = 15_000` stroops
   - `keeper_net = 500_000 - 15_000 = 485_000` stroops (credited to `KeeperReward(keeper)`)
4. **Keeper's realized net profit:**
   - `realized_net_profit = 485_000 - 60_000 = 425_000` stroops (`0.0425 XLM`).

### Case B: Task With an Attached Verifier

The same owner registers a task with `reward = 150_000` stroops (`0.015 XLM`) and `verifier = Some(verifier_addr)`.

1. **Bot profitability check (v1 fallback / v2 default):**
   - `estimated_claim_fee = 10_000` stroops
   - `estimated_execute_base_fee = 50_000` stroops
   - `estimated_verifier_fee = 50_000` stroops
   - `total_estimated_fees = 10_000 + 50_000 + 50_000 = 110_000` stroops
   - `bot_net_profit = 150_000 - 110_000 = 40_000` stroops
   - `40_000 < 50_000` (`MIN_PROFIT_MARGIN_STROOPS`) -> **profitable = false** (bot skips the task).
2. **Sizing fix:** To pass the bot's check *and* deliver `50_000` stroops of realized net profit after the 3% protocol fee:
   - `target_keeper_net = 110_000 + 50_000 = 160_000` stroops
   - `recommended_reward = ceil(160_000 * 10_000 / 9_700) = 164_949` stroops (e.g., round up to `170_000` stroops = `0.017 XLM`).
   - At `reward = 170_000`:
     - `bot_net_profit = 170_000 - 110_000 = 60_000 >= 50_000` -> **profitable = true**.
     - `protocol_fee = floor(170_000 * 300 / 10_000) = 5_100` stroops.
     - `keeper_net = 170_000 - 5_100 = 164_900` stroops.
     - `realized_net_profit = 164_900 - 110_000 = 54_900` stroops (`0.00549 XLM`).
