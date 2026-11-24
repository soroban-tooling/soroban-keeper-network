# Integrating the keeper network into an existing protocol

This guide is for protocol teams who already have a Soroban contract and want
keepers to run some of its maintenance for them. It walks through the
decisions you have to make, in order, and ties each one to code you can run.

Every decision below ends with an **Example** line. Those links point at
things that exist in this repository today; where an example is still in an
open pull request rather than on `main`, the guide says so.

- [1. What jobs suit a keeper](#1-what-jobs-suit-a-keeper)
- [2. Choosing the reward](#2-choosing-the-reward)
- [3. Choosing the deadline, TTL and lock window](#3-choosing-the-deadline-ttl-and-lock-window)
- [4. Verifiers versus conditions](#4-verifiers-versus-conditions)
- [5. Budgeting for fees](#5-budgeting-for-fees)
- [6. Worked reward-sizing calculation](#6-worked-reward-sizing-calculation)
- [7. Pre-launch checklist](#7-pre-launch-checklist)

## How a task works, in one paragraph

You call `register_task` and escrow a reward in the registry. Any keeper may
`claim_task` (taking an exclusive lock for `lock_ledgers`), do the work, and
call `execute_task` with a proof; the keeper is credited
`reward - fee` and withdraws it later. If nobody executes before the
`deadline`, anyone may call `expire_task` and the escrow returns to you; you
may also `cancel_task` while it is pending (or claimed with an expired lock). The registry does not
perform your work: your task's `calldata` tells keepers *what* to do, and the
keeper submits a transaction to *your* contract to do it. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine.

## 1. What jobs suit a keeper

A job is a good fit when **all** of these hold:

| Property | Why it matters |
|---|---|
| **Permissionless to trigger** | The keeper is an arbitrary account. Your contract entry point must be safe for anyone to call, or must check its own preconditions. |
| **Idempotent or self-guarding** | Two keepers may race. The second call must fail cheaply or do nothing, not double-apply. |
| **Time- or state-triggered, not user-triggered** | Keepers are for "when X becomes true, do Y", not for work that needs a specific user's signature. |
| **Worth more than it costs** | The reward must beat the keeper's transaction costs (see [section 6](#6-worked-reward-sizing-calculation)). |
| **Failure is tolerable** | If no keeper shows up, the task expires and you get the escrow back, but the job did not happen. Do not rely on a keeper for something that must happen within a hard bound. |

Typical fits: liquidating an undercollateralised position, settling an
auction at its end time, releasing vested tokens, extending the TTL of your
own storage entries, executing a recurring payment, and executing a passed
governance proposal.

Poor fits: anything that needs the user's own authorisation, anything where a
missed run is a loss you cannot absorb, and anything cheaper to do inline in
the user transaction that already touches the state.

**Examples**

- The end-to-end loop with a liquidation-type task, with real transactions:
  [DEMO.md](DEMO.md).
- A minimal liquidation keeper in Rust:
  [`rust-sdk/examples/liquidation-keeper`](https://github.com/soroban-tooling/soroban-keeper-network/tree/main/rust-sdk/examples/liquidation-keeper).
- Calling the registry from your own contract:
  [`rust-sdk/examples/calling-contract`](https://github.com/soroban-tooling/soroban-keeper-network/tree/main/rust-sdk/examples/calling-contract).
- A TTL-extension task for a dApp's own storage is tracked in
  [#794](https://github.com/soroban-tooling/soroban-keeper-network/issues/794)
  (open pull request
  [#924](https://github.com/soroban-tooling/soroban-keeper-network/pull/924),
  not yet on `main`).

## 2. Choosing the reward

The reward is escrowed up front and is the keeper's only payment. Three
numbers constrain it:

1. **Floor.** `register_task` rejects `reward <= 0` and any `reward` below the
   registry's configured `min_reward` with `InvalidReward`. The admin sets the
   floor with `set_min_reward`; a fresh registry has a floor of `0`. Query the
   deployment you target rather than assuming.
2. **Protocol fee.** On `execute_task` the registry keeps
   `fee = floor(reward * fee_bps / 10_000)` and credits the keeper
   `reward - fee`. The rounding rules and the dust threshold are in the
   README's
   [Fee rounding and the dust threshold](https://github.com/soroban-tooling/soroban-keeper-network/blob/main/README.md#fee-rounding-and-the-dust-threshold)
   section. The live testnet deployment uses 300 bps
   ([DEPLOYMENTS.md](DEPLOYMENTS.md)); governance can change it
   ([GOVERNANCE_DESIGN.md](GOVERNANCE_DESIGN.md)), so read `fee_bps` at
   runtime.
3. **The keeper's cost.** A keeper only runs a task whose net reward exceeds
   its own cost of the claim and execute transactions plus the work itself.
   Size the reward from that cost, not from what the task is "worth" to you.

You can raise a reward after registration with `increase_reward` if keepers
are not picking the task up, so it is safer to start near break-even plus a
margin and top up than to overpay on every task. The bundled keeper bots make
the profitability decision explicit; see
[`examples/keeper-bot-v2`](../examples/keeper-bot-v2/README.md) and
[KEEPER_BOT_V2_DESIGN.md](KEEPER_BOT_V2_DESIGN.md) for how a bot weighs
reward against cost.

[Section 6](#6-worked-reward-sizing-calculation) works through the arithmetic.

**Examples**

- Reward and fee split on a real execution (1.0 XLM escrowed, 0.97 XLM
  credited): [DEMO.md](DEMO.md).
- Registering many tasks, each with its own reward:
  [Batch register example](../examples/batch-register/README.md) and
  [BATCH_OPERATIONS.md](BATCH_OPERATIONS.md).

## 3. Choosing the deadline, TTL and lock window

Three time parameters are validated by `register_task`
(see `validate_task_params` in
[`contracts/keeper-registry/src/internal.rs`](https://github.com/soroban-tooling/soroban-keeper-network/blob/main/contracts/keeper-registry/src/internal.rs)):

| Parameter | Unit | Rule |
|---|---|---|
| `deadline` | unix seconds | Must be in the future (`DeadlinePassed` otherwise). After it, the task can be expired and the escrow returns to you. |
| `ttl_ledgers` | ledgers | Must be at least `1_000`, **and** at least `(deadline - now) / 5 + 17_280`, or registration fails with `TtlTooShort`. This keeps the stored task from being archived before its deadline. |
| `lock_ledgers` | ledgers | Must be between `12` and `17_280` inclusive. This is how long a claiming keeper has exclusive rights before another keeper may re-claim. |

At roughly 5 seconds per ledger, `12` ledgers is about a minute and `17_280`
about a day.

How to choose:

- **Deadline:** the latest moment the job is still useful, not the moment you
  would like it done. A late deadline gives keepers more chances; an early one
  returns your escrow sooner. Pick the former unless the job loses value with
  delay.
- **TTL:** compute the minimum from the formula above and add headroom if you
  expect to `extend_deadline`. For a deadline seven days out:
  `604_800 / 5 + 17_280 = 138_240` ledgers is the minimum.
- **Lock window:** longer than the keeper needs to land the execute
  transaction under load, shorter than you can tolerate a stalled keeper
  holding the task. Tens to a few hundred ledgers suits most jobs.

**Examples**

- Registering with explicit `lock_ledgers`, `reward` and `deadline` from the
  command line: [DEMO.md](DEMO.md).
- Building the same parameters in code with the TypeScript SDK:
  [TypeScript SDK](../packages/sdk-ts/README.md) and its
  [`examples/`](https://github.com/soroban-tooling/soroban-keeper-network/tree/main/packages/sdk-ts/examples).
- Task validation rules and error codes:
  [ARCHITECTURE.md](ARCHITECTURE.md).

## 4. Verifiers versus conditions

Both are optional, per-task, permissionless contracts you attach at
registration. They answer different questions at different times:

| | Condition | Verifier |
|---|---|---|
| **Question** | Is this task worth attempting right now? | Did the keeper do the work correctly? |
| **Runs** | Inside `claim_task`, before the claim is recorded | Inside `execute_task`, before the keeper is credited |
| **Interface** | `is_met(env, task_id) -> bool` | `verify(env, task_id, keeper, proof) -> bool` |
| **On `false`** | Claim is rejected (`ConditionNotMet`); the task stays `Pending` and can be claimed later | Execution is rejected (`VerificationFailed`); the keeper is not paid |
| **On a panic** | Treated the same as `false` | Treated the same as `false` (`VerificationFailed`) |
| **Protects against** | Keepers wasting fees, or claim-squatting, on a job that is not ready | A keeper submitting a bogus proof to collect the reward |

Choose by asking what can go wrong:

- **Use a condition** when the trigger is observable on-chain and you want
  keepers to be able to check it cheaply before committing, for example a
  price crossing a threshold or a time window opening. It also stops a task
  being claimed too early.
- **Use a verifier** when the keeper's *output* can be checked on-chain from
  the proof, for example a signature, a hash preimage, or a state change your
  contract can read. Without one, the registry trusts the keeper's proof.
- **Use both** when the job has a trigger and a checkable result. The two are
  independent.
- **Use neither** when the job is self-guarding: your own contract entry point
  already reverts unless the work is valid and needed. This is the simplest
  and cheapest option and is often enough.

Keep both contracts cheap and deterministic. They run inside someone else's
transaction, so an expensive or unbounded check raises every keeper's cost and
will push the break-even reward up.

Because both are permissionless, the registry accepts any address you pass.
That is deliberate: a bad choice only affects your own task.

**Examples**

- Reference condition contracts: time window, price threshold and oracle
  deviation under
  [`contracts/conditions/`](https://github.com/soroban-tooling/soroban-keeper-network/tree/main/contracts/conditions).
  The registry calls `is_met`; the oracle-deviation contract implements it
  directly, so check the exact entry point of any contract you reuse.
- Design and failure semantics for conditions:
  [TASK_CONDITIONS_DESIGN.md](TASK_CONDITIONS_DESIGN.md).
- Verifier interface and design: [VERIFIER_DESIGN.md](VERIFIER_DESIGN.md);
  testing a verifier against the registry:
  [`contracts/verifiers/test-support`](https://github.com/soroban-tooling/soroban-keeper-network/tree/main/contracts/verifiers/test-support).
- Oracle-backed conditions: [ORACLE_GUIDE.md](ORACLE_GUIDE.md).
- A hash-preimage verifier and a condition-contract template are in open
  pull request
  [#927](https://github.com/soroban-tooling/soroban-keeper-network/pull/927)
  and are not yet on `main`.

> Reference verifier implementations (signature, oracle, tx-inclusion) are
> not yet in this repository; see the status note at the top of
> [VERIFIERS.md](VERIFIERS.md). Today you write your own verifier against the
> `IKeeperVerifier` interface.

## 5. Budgeting for fees

There are four distinct costs. Only the first two are paid by you.

| Cost | Who pays | When | Notes |
|---|---|---|---|
| **Reward escrow** | You | `register_task` | Returned in full if the task is cancelled or expires unexecuted. |
| **Your own transaction fees** | You | `register_task`, plus `increase_reward`, `extend_deadline` and `cancel_task` if used | Network fees, paid in XLM. Use `batch_register_tasks` (up to 50 tasks) to share them. |
| **Protocol fee** | Deducted from the reward | `execute_task` | `floor(reward * fee_bps / 10_000)`. It reduces what the keeper earns, so it raises the reward you need to offer. |
| **Keeper transaction fees** | The keeper | `claim_task`, `execute_task`, `withdraw_rewards` | Not paid by you, but they set the break-even reward. |

So the cash you commit per task is `reward` (refundable until executed) plus
your registration fee. The cash you *spend* per task is the full `reward` on
success, since the keeper is credited `reward - fee` and the protocol keeps
`fee`.

For recurring work, budget `N × reward` for the period, not one reward: each
task escrows separately. If you register a stream of tasks ahead of time,
remember that expired tasks return their escrow only after the deadline.

Measure rather than guess. The registry's own resource numbers per entry point
are tracked in
[`contracts/keeper-registry/resource-baseline.json`](https://github.com/soroban-tooling/soroban-keeper-network/blob/main/contracts/keeper-registry/resource-baseline.json)
(see [CI.md](CI.md) and [VERIFIERS.md](VERIFIERS.md) for the methodology), and
`stellar contract invoke` can simulate a call to show its fee before you sign.

**Examples**

- Batch registration to amortise your transaction fees:
  [Batch register example](../examples/batch-register/README.md).
- A dry run that shows what a keeper would decide, without submitting:
  [`examples/keeper-bot/EXAMPLES.md`](https://github.com/soroban-tooling/soroban-keeper-network/blob/main/examples/keeper-bot/EXAMPLES.md).

## 6. Worked reward-sizing calculation

The goal: find the smallest reward a rational keeper will accept for a task,
then add a margin.

**Inputs.** The first two come from the registry; the cost figures below are
**illustrative assumptions** for the arithmetic, not measurements. Replace
them with simulated fees from your own task before launching.

| Symbol | Meaning | Value used here |
|---|---|---|
| `fee_bps` | Protocol fee in basis points | `300` (the testnet deployment, [DEPLOYMENTS.md](DEPLOYMENTS.md)) |
| `c_claim` | Keeper's fee for `claim_task` | `400_000` stroops (assumed) |
| `c_exec` | Keeper's fee for `execute_task`, including the call into your contract | `600_000` stroops (assumed) |
| `m` | Margin the keeper needs over cost | `20%` |

One XLM is `10_000_000` stroops.

**Step 1: the keeper's cost.**

```text
C = c_claim + c_exec = 400_000 + 600_000 = 1_000_000 stroops (0.1 XLM)
```

(`withdraw_rewards` is a separate transaction a keeper amortises over many
tasks, so it is left out of the per-task cost.)

**Step 2: the net the keeper needs.**

```text
net_needed = C * (1 + m) = 1_000_000 * 1.20 = 1_200_000 stroops
```

**Step 3: the gross reward that yields that net.** The keeper receives
`reward - floor(reward * fee_bps / 10_000)`, so solve for the smallest reward
that gives at least `net_needed`. Ignoring rounding:

```text
reward ≈ net_needed / (1 - fee_bps / 10_000)
       = 1_200_000 / 0.97
       ≈ 1_237_113 stroops
```

Check against the contract's integer arithmetic:

| `reward` | `fee = floor(reward * 300 / 10_000)` | `keeper_net` | Enough? |
|---------:|------------------:|-------------:|:--|
| 1_237_112 | 37_113 | 1_199_999 | No, one stroop short |
| 1_237_113 | 37_113 | 1_200_000 | Yes |
| 1_250_000 | 37_500 | 1_212_500 | Yes, with a round number |

**Step 4: pick the reward.** `1_250_000` stroops (0.125 XLM) is the break-even
plus margin, rounded to a convenient figure. It is far above the dust
threshold (`34` stroops at 300 bps), so the protocol fee is non-zero.

**Step 5: budget.** For a job you expect to run daily for 30 days, escrowing
each task separately:

```text
cash committed over the period = 30 * 1_250_000 = 37_500_000 stroops (3.75 XLM)
spent if every task executes   = 37_500_000 stroops
  paid to keepers              = 30 * 1_212_500 = 36_375_000
  kept as protocol fee         = 30 *    37_500 =  1_125_000
```

Add your own fees for registering the 30 tasks, which a single
`batch_register_tasks` call can cover for up to 50 tasks at once.

**Sanity checks.**

- If the job is worth less to you than `1_250_000` stroops per run, a keeper is
  not the right tool; do it inline.
- If tasks sit unclaimed, your cost assumptions were too low: raise the reward
  with `increase_reward` and revise `c_claim` and `c_exec` from real
  simulations.
- If `fee_bps` changes by governance, redo Step 3. At 250 bps the same net
  needs `1_200_000 / 0.975 ≈ 1_230_770` stroops.

## 7. Pre-launch checklist

- [ ] The entry point keepers will call on your contract is safe for any
      caller, and a second caller fails cheaply.
- [ ] You read `fee_bps` and `min_reward` from the deployment you target.
- [ ] `reward` covers keeper cost plus margin, from simulated fees.
- [ ] `ttl_ledgers >= (deadline - now) / 5 + 17_280`.
- [ ] `lock_ledgers` is between `12` and `17_280` and fits your tolerance for
      a stalled keeper.
- [ ] You chose condition, verifier, both or neither on purpose, and any
      contract you attach is cheap and deterministic.
- [ ] You tested the full register, claim, execute loop on testnet first
      ([DEMO.md](DEMO.md), [DEPLOYING.md](DEPLOYING.md)).
- [ ] You know who will run a keeper for your tasks, or you are relying on the
      open keeper network and have sized the reward accordingly.
