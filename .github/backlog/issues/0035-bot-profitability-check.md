---
title: "feat(keeper-bot): skip tasks whose reward does not cover the cost of executing them"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 1
depends_on: []
---

## Summary

The bot claims and executes every task it can, regardless of reward. Nothing compares the reward against the fees the bot will pay. A task with a reward of one stroop is pursued as eagerly as one worth 100 XLM, at a guaranteed loss.

## Current behaviour

`task.reward` is read from the registration event and used only for a log line:

```js
console.log(`  📌  Attempting to claim task ${task.taskId} (reward: ${task.reward})...`);
```

There is no threshold, and `CONFIG` has no setting for one.

## The economics

Executing a task costs the keeper at minimum two submitted transactions — `claim_task` and `execute_task` — plus an amortised share of a later `withdraw_rewards`. The bot receives `reward * (10_000 - fee_bps) / 10_000`.

So the break-even condition is roughly:

```
reward * (1 - fee_bps/10_000)  >  claim_fee + execute_fee + amortised_withdraw_fee
```

None of which the bot evaluates. And because `register_task` enforces only `reward > 0` unless an admin has set `min_reward`, anyone can register tasks with dust rewards. A bot running unattended will work through them at a loss indefinitely.

There is a griefing angle: registering many dust tasks is cheap and consumes competitors' per-round budgets and fees. But the ordinary case is enough to justify the fix — a keeper that does not know its own break-even point is not a viable keeper.

The README frames this as a user story the bot is meant to satisfy:

> | Keeper | See the reward amount before claiming | I can calculate profitability vs gas |

The reward is visible. The calculation is missing.

## Expected behaviour

The bot estimates the cost of executing a task, compares it to the net reward, and skips tasks that do not clear a configurable margin.

## Suggested approach

Start simple and make it honest rather than precise.

**Configuration:**

```js
// Minimum net reward, in stroops, before the bot will pursue a task. Set from
// the operator's own fee experience; the default is deliberately conservative.
minNetRewardStroops: BigInt(process.env.MIN_NET_REWARD || "1000000"), // 0.1 XLM
// Multiple of estimated cost a task must clear to be worth executing.
minProfitMultiple: parseFloat(process.env.MIN_PROFIT_MULTIPLE || "2.0"),
```

**Net reward** needs the fee rate, which the bot can read once per round via `get_fee_bps` — noting that view currently has a default-value bug tracked separately, so read it from an initialized contract and do not rely on the fallback.

**Cost estimation** is the interesting part. `BASE_FEE` is a floor, not a prediction; the real cost depends on the resource fee, which simulation reports. Two options:

- *Static:* assume a configured per-transaction cost. Crude, but transparent and it works.
- *Simulated:* use the `minResourceFee` from the `claim_task` simulation. More accurate, and available for free once the read-by-simulation work lands.

Recommendation: implement the static version, and log the simulated fee alongside it so an operator can calibrate the configured value from real data. A precise model nobody can tune is worse than a rough one they can.

Use `BigInt` throughout. `task.reward` is an `i128` on-chain and stroop amounts overflow JavaScript's safe integer range at ~90 million XLM. The existing `withdrawThreshold` already uses `BigInt`; match it.

## Acceptance criteria

- [ ] A configurable minimum net reward and profit margin exist, documented in `.env.example`.
- [ ] Net reward is computed from the current on-chain fee rate, not assumed.
- [ ] Tasks below the threshold are skipped before any transaction is submitted.
- [ ] Skipped tasks are logged with the reward, the estimated cost, and the reason.
- [ ] All reward arithmetic uses `BigInt`.
- [ ] The README keeper-bot section explains how to calibrate the thresholds.

## Files

- `examples/keeper-bot/index.js`
- `examples/keeper-bot/.env.example`
- `README.md` or `docs/DEPLOYING.md` — the operator guide
