# Tutorial: Run Your First Keeper with `examples/keeper-bot`

This tutorial takes you from a fresh checkout to a keeper that has claimed and
executed a task on Stellar testnet and has a reward waiting for you. You will
configure the bot, **run it in dry-run mode first** so nothing is submitted,
then run it for real, learn to read what it prints, and withdraw your reward.

It covers the bot in [`examples/keeper-bot`](../examples/keeper-bot). The log
lines quoted below are the ones `examples/keeper-bot/index.js` prints. Where
the current bot, SDK or testnet behaves in a way that will trip you up, this
page says so in [Known issues](#known-issues-as-of-2026-11-20) and gives a
workaround. Read that section before you start.

## Contents

1. [What the bot does (and does not do)](#1-what-the-bot-does-and-does-not-do)
2. [Prerequisites](#2-prerequisites)
3. [Install](#3-install)
4. [Create a keeper account](#4-create-a-keeper-account)
5. [Configure](#5-configure)
6. [Dry run first](#6-dry-run-first)
7. [Give the keeper a task](#7-give-the-keeper-a-task)
8. [Run against testnet](#8-run-against-testnet)
9. [Reading the output](#9-reading-the-output)
10. [Withdraw your reward](#10-withdraw-your-reward)
11. [Running continuously](#11-running-continuously)
    [Known issues (as of 2026-11-20)](#known-issues-as-of-2026-11-20)
12. [Where to go next](#12-where-to-go-next)

## 1. What the bot does (and does not do)

Each **round** the bot:

1. Reads recent `TaskRegistered` events from the registry.
2. For every task whose deadline has not passed, loads the task, checks it has
   something that can do the work, builds a proof, and estimates whether the
   reward covers the transaction fees.
3. Calls `claim_task`, then `execute_task` with the proof, for up to
   `MAX_TASKS_PER_ROUND` tasks.
4. Calls `expire_task` on past-deadline tasks (a public good that refunds the
   task owner) unless you turn that off.
5. Reads your reward balance and your stake, and logs both.

It is a **teaching example**, not a production keeper:

- The only task type with a real executor is **`TtlExtension`**. It does no
  real off-chain work. It just confirms the task is still before its deadline
  and returns a small proof. Every other task type (`Liquidation`,
  `OraclePricePush`, and so on) is **skipped silently**, because a keeper must
  never fabricate a proof for work it did not do.
- A development switch, `SIMULATE_EXECUTION=true`, makes the bot fabricate
  proofs for unsupported tasks so you can exercise the loop. It claims rewards
  for work that was never done. Never use it against a real deployment.
- It keeps no database. It looks back only 1,000 ledgers (about 83 minutes) for
  new tasks and reads at most 100 events per round.

## 2. Prerequisites

- **Node.js 20 or newer** (`examples/keeper-bot/package.json` sets
  `engines.node` to `>=20.0.0`) and npm.
- **A registry contract ID on testnet** (starts with `C`). The registry listed in
  [DEPLOYMENTS.md](DEPLOYMENTS.md) is the quickest to try, but as of
  2026-11-20 it predates staking: the bot logs a harmless
  `Stake check failed` warning against it (see [Known issues](#known-issues-as-of-2026-11-20)).
  To get a current one, deploy your own with [DEPLOYING.md](DEPLOYING.md).
- **The Stellar CLI** (`stellar`) to create the keeper account and to withdraw
  rewards. The `skn` tool in `packages/cli` is an alternative for some steps
  and is noted where it applies.
- **Testnet XLM** in the keeper account for fees. Testnet XLM has no value.

## 3. Install

The bot imports the TypeScript SDK from `packages/sdk-ts`, and that package
has to be built before the bot can start. Without this step the bot fails
immediately with `Cannot find module ... @soroban-keeper-network/sdk/dist/index.js`.

From the repository root:

```bash
# 1. Build the SDK the bot depends on
cd packages/sdk-ts
npm install
npm run build

# 2. Install the bot
cd ../../examples/keeper-bot
npm install
```

Then apply the Stellar SDK update described in
[Known issue 1](#known-issue-1-xdr-read-error-on-current-testnet). Do it now;
on current testnet the bot cannot complete a round without it:

```bash
cd ../../packages/sdk-ts
npm update @stellar/stellar-sdk
npm run build
cd ../../examples/keeper-bot
```

## 4. Create a keeper account

```bash
stellar keys generate keeper --network testnet --fund
stellar keys address keeper     # your public key, starts with G
stellar keys secret keeper      # your secret key, starts with S. Never share it.
```

`--fund` asks testnet's friendbot to give the account test XLM. For this
tutorial you may also want a second funded identity, `owner`, to register the
test task so the money flow is easy to follow:

```bash
stellar keys generate owner --network testnet --fund
```

## 5. Configure

```bash
cp .env.example .env
```

`.env` is git-ignored. **Never commit it**, and never paste your secret key
into an issue, a log or a chat. Edit `.env`:

```dotenv
NETWORK=testnet
KEEPER_SECRET_KEY=S...your keeper secret...
REGISTRY_CONTRACT_ID=C...your registry contract ID...
```

Every setting, with the default the bot uses when you leave it out:

| Setting | Default | Meaning |
|---------|---------|---------|
| `NETWORK` | `testnet` | `testnet`, `futurenet` or `mainnet`. |
| `REGISTRY_CONTRACT_ID` | none, required | The registry to serve. Must be a valid `C...` contract ID. |
| `KEEPER_SECRET_KEY` | none, required for live runs | Your signing key (`S...`). Optional in dry-run mode. |
| `DRY_RUN` | `false` | `true` evaluates everything and submits nothing. |
| `RUN_ONCE` | `false` | `true` (or the `--once` flag) runs a single round and exits. |
| `POLL_INTERVAL_MS` | `10000` | Time between rounds in daemon mode. At least `1000`. |
| `MAX_TASKS_PER_ROUND` | `5` | Most tasks claimed in one round. At least `1`. |
| `WITHDRAW_THRESHOLD` | `10000000` | Stroops of reward balance at which the bot tries to withdraw. 10,000,000 stroops = 1 XLM. |
| `MIN_PROFIT_MARGIN_STROOPS` | `0` | Minimum estimated profit, in stroops, a task should clear. See [Known issue 3](#known-issue-3-unprofitable-tasks-are-still-claimed). |
| `MAX_RETRIES` | `3` | Retries for transient RPC errors. |
| `RETRY_BASE_MS` | `500` | First retry delay; backs off exponentially. |
| `EXPIRE_STALE_TASKS` | `true` | Call `expire_task` on past-deadline tasks. |
| `SIMULATE_EXECUTION` | `false` | Development only. See above. |
| `AUTO_STAKE_ENABLED` | `false` | Deposit stake once for a never-staked keeper. See [section 12](#12-where-to-go-next). |
| `AUTO_STAKE_AMOUNT` | `0` | Stroops to auto-stake. Must be above `0` if auto-staking is on. |
| `AUTO_STAKE_CEILING` | `0` | Refuse to auto-stake more than this. `0` means no ceiling. |

The bot checks its settings at startup and exits with code 1 and one line on
stderr if one is wrong, for example:

```text
Invalid REGISTRY_CONTRACT_ID — must be set
Invalid REGISTRY_CONTRACT_ID: GABC... — must be a valid contract ID (starts with C...)
Invalid POLL_INTERVAL_MS: 50 — must be >= 1000
```

(A bad secret key is reported without echoing the key.)

## 6. Dry run first

Dry-run mode runs the full decision pipeline against live chain data and
**submits no transactions**. No signing key is needed: if `KEEPER_SECRET_KEY` is
empty the bot makes a temporary one. Always start here when you change a
setting.

```bash
DRY_RUN=true node index.js --once
```

You can put `DRY_RUN=true` in `.env` instead. Against a registry with no recent
tasks the output looks like this on a registry that has the staking views (stdout
and stderr interleaved; the first line comes from the `dotenv` package, so its
exact wording depends on its version):

```text
◇ injected env (3) from .env
[DRY-RUN] Using temporary keypair for read operations

Soroban Keeper Network — Keeper Bot v0.1.0

  Network  : testnet
  RPC URL  : https://soroban-testnet.stellar.org
  Keeper   : G...your keeper's public key...
  Registry : C...your registry contract ID...
  Mode     : DRY-RUN (decisions logged, no transactions submitted)
  Withdraw : when balance ≥ 10000000 stroops
  Staking  : visibility only (no minimum enforced on-chain — AUTO_STAKE_ENABLED=false)

RPC healthy — ledger 5831899

Keeper round (DRY-RUN mode) at 2026-11-20T13:58:55.607Z
  Found 0 TaskRegistered events to evaluate
  Evaluated 0 tasks; 0 are profitable candidates
  Accumulated reward balance: 0 stroops
  Current bonded stake: 0 stroops
Round complete.
```

`Round complete.` and exit code 0 mean the bot reached the network, read the
registry and found nothing wrong. If you instead see
`Round completed with errors.`, read the lines above it; most causes are in
[Known issues](#known-issues-as-of-2026-11-20).

When there is a task the keeper could take, the round continues like this (the
task and its numbers are illustrative):

```text
Keeper round (DRY-RUN mode) at 2026-11-20T13:59:44.478Z
  Found 2 TaskRegistered events to evaluate
  Evaluated 2 tasks; 1 are profitable candidates
  Attempting to claim task 7 (reward: 25000000, est net profit: 24940000 stroops)...
```

In a dry run the bot is meant to print `  [DRY-RUN] Task 7 would be claimed` and a
JSON decision record, one object per line, for use with `jq`:

```json
{"timestamp":"2026-11-20T13:59:44.500Z","taskId":7,"decision":"claim","reason":"Task passed all profitability and eligibility checks (est net profit: 24940000 stroops)","profitability":{"reward":"25000000","estimatedFee":"60000","netProfit":"24940000","profitable":true,"profitMargin":"0"}}
```

The fields are documented in [../examples/keeper-bot/DRY_RUN.md](../examples/keeper-bot/DRY_RUN.md).
**Today neither is produced**; see
[Known issue 2](#known-issue-2-dry-run-cannot-print-its-decision-record).
You will see this line instead, and the round ends with `Round completed with
errors.`:

```text
  Failed to claim/execute task 7: Do not know how to serialize a BigInt
```

The evaluation above that line still ran, so you can use the `Attempting to
claim` line to see which tasks the bot picked and what profit it estimated.

What dry run does **not** show: tasks the bot rejects while evaluating (past
deadline, no executor for the task type, no way to build a proof) are dropped
without a log line, so a task that never appears in `Attempting to claim` was
filtered out silently. The `Evaluated N tasks; M are profitable candidates`
line counts everything that survived evaluation, including tasks that lose
money (see [Known issue 3](#known-issue-3-unprofitable-tasks-are-still-claimed)).

## 7. Give the keeper a task

The bot can only act on tasks that exist. With a registry of your own, register
a `TtlExtension` task, the one type this bot can really execute. Do this
**shortly before** running the bot, because the bot looks back only about 83
minutes.

Using the `skn` tool (build it once with `cd packages/cli && npm install &&
npm run build`; see [CLI.md](CLI.md)):

```bash
node packages/cli/dist/index.js task register \
  --contract-id $REGISTRY_CONTRACT_ID --identity owner \
  --type ttl-extension --reward 10000000 --deadline +2h \
  --ttl-ledgers 20000 --lock-ledgers 120 --yes
```

`--reward 10000000` escrows 1 XLM. `--deadline +2h` gives you two hours.
`--lock-ledgers 120` is about 10 minutes of exclusive time once a keeper
claims it. If the registry has a minimum reward set, use at least that.

The reward is the bounty. After the registry's fee (0 to 10,000 bps, set by the
admin; the reference deployment uses 300, or 3%) the keeper receives the rest.
At 300 bps a 10,000,000-stroop task pays the keeper **9,700,000** stroops. The
bot's own cost estimate is 60,000 stroops per task (10,000 to claim, 50,000 to
execute), so this task shows an estimated net profit of 9,940,000 before the
protocol fee. Choose rewards well above that; see
[Known issue 3](#known-issue-3-unprofitable-tasks-are-still-claimed).

Now dry-run again. You should see `Found 1 TaskRegistered events to evaluate`
and an `Attempting to claim task N` line for your task.

## 8. Run against testnet

When the dry run picks the task you expect, turn dry-run off and run one round
with your real key:

```bash
node index.js --once
```

(`DRY_RUN` must be unset or `false` in `.env`.) The banner now shows
`Mode     : --once (single run)` instead of the dry-run line, and the round runs
for real:

```text
Keeper round at 2026-11-20T13:59:45.789Z
  Found 1 TaskRegistered events to evaluate
  Evaluated 1 tasks; 1 are profitable candidates
  Attempting to claim task 7 (reward: 10000000, est net profit: 9940000 stroops)...
  Task 7 claimed!
  Task 7 executed! Proof: 74746c2d657874656e73...
  Accumulated reward balance: 9700000 stroops
  Current bonded stake: 0 stroops
Round complete.
```

The bot claimed the task (`claim_task`), executed it (`execute_task`) and the
registry credited your balance. The proof printed is only its first 20 hex
characters; `74746c2d657874656e73` is the ASCII text `ttl-extens`, the start of
the `ttl-extension:task:7:confirmed-live` proof this bot's `TtlExtension`
executor builds. Your balance is `10,000,000` minus the fee, here
`9,700,000`. This is below the default `WITHDRAW_THRESHOLD` of `10,000,000`, so
the bot leaves it for now.

If the task was already taken by another keeper you will see
`Failed to claim/execute task 7: ...` instead. Losing a race is normal and the
bot carries on. Note that a failure is counted as an error, so the round ends
with `Round completed with errors.` and exit code 1.

## 9. Reading the output

Lines starting `  ` (two spaces) are per-round detail. Warnings and errors go to
stderr; everything else goes to stdout.

**Startup**

| Line | Meaning |
|------|---------|
| `Soroban Keeper Network — Keeper Bot v0.1.0` | The banner. |
| `Network`, `RPC URL`, `Keeper`, `Registry` | Where the bot is pointed, and the account it signs as. Check `Registry` is the one you intend. |
| `Mode     : DRY-RUN (...)`, `Mode     : --once (single run)` or `Poll     : every Ns` | Which mode you are in. |
| `Withdraw : when balance ≥ N stroops` | Your `WITHDRAW_THRESHOLD`. |
| `Staking  : visibility only (...)` or `auto-stake N stroops once (...)` | Your staking settings. |
| `RPC healthy — ledger N` | The RPC node answered. If it cannot, the bot prints `RPC unreachable at <url>: <reason>` and exits with 1. |

**Each round**

| Line | Meaning |
|------|---------|
| `Keeper round at <time>` / `Keeper round (DRY-RUN mode) at <time>` | A round started. |
| `Found N TaskRegistered events to evaluate` | Events read from the last 1,000 ledgers. |
| `Evaluated N tasks; M are profitable candidates` | N events in, M candidates out. See Known issue 3 for what "profitable" really counts. |
| `Attempting to claim task ID (reward: R, est net profit: P stroops)...` | The bot is about to claim. `P` is `R` minus the bot's fee estimate. It is negative for a losing task. |
| `Task ID claimed!` | `claim_task` succeeded. |
| `Task ID executed! Proof: <hex>...` | `execute_task` succeeded; the reward was credited. |
| `[DRY-RUN] Task ID would be claimed` | Dry run only. |
| `Round budget exhausted (N tasks processed); M candidates remain for future rounds` | `MAX_TASKS_PER_ROUND` reached. |
| `N task(s) past deadline` then `Task ID expired — escrow refunded to owner` | The bot cleaned up expired tasks (not in dry run). |
| `Accumulated reward balance: N stroops` | Your withdrawable balance (`keeper_balance`), read every round. |
| `Current bonded stake: N stroops` | Your stake (`keeper_stake`), read every round. |
| `Round complete.` / `Round completed with errors.` | End of a `--once` run, exit code 0 or 1. In daemon mode errors print `Keeper round finished with N error(s)` instead. |

**Warnings and errors**

| Line | Meaning |
|------|---------|
| `Failed to fetch events: <reason>` | The RPC event query failed. The round continues with zero tasks. |
| `Could not decode a TaskRegistered event: <reason>` and `Skipped N undecodable event(s) — the contract's event shape may have changed.` | The bot and the contract disagree about the event layout. Update the bot. |
| `Failed to evaluate task ID: <reason>` | One task could not be loaded or priced; it is retried next round. |
| `Failed to claim/execute task ID: <reason>` | The claim or execution was rejected, often because another keeper won the race. |
| `<operation> failed (attempt N), retrying in Mms: <reason>` | A transient error. The bot retries up to `MAX_RETRIES` times. Permanent contract errors are not retried. |
| `Task ID expire failed (skip: <reason>)` | An `expire_task` attempt failed. See Known issue 4. |
| `Balance check failed: <reason>` | Reading or withdrawing your balance failed. See Known issue 4. |
| `Stake check failed: <reason>` | The `keeper_stake` read failed. On a registry that predates staking this is expected and harmless. |
| `Keeper loop error: <reason>` | Something unexpected in the round. See Known issue 1. |
| `No TaskRegistered events found for N consecutive rounds.` | Printed every 30th empty round in daemon mode. Normal on a quiet registry. |

## 10. Withdraw your reward

Rewards sit in the registry until you withdraw them. Check the balance:

```bash
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source keeper --network testnet \
  -- keeper_balance --keeper $(stellar keys address keeper)
```

It returns the amount in stroops (`9700000` in this tutorial). Withdraw it:

```bash
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source keeper --network testnet \
  -- withdraw_rewards --keeper $(stellar keys address keeper)
```

The registry transfers the whole balance to your account, returns the amount,
and emits a `wdraw` event. With the `skn` tool built as in section 7, the same
two steps are `node packages/cli/dist/index.js keeper balance` and `... keeper
withdraw`, with `--contract-id` and `--identity keeper`. `keeper balance` also
shows your stake and reputation.

The bot has a withdraw step of its own: when the balance reaches
`WITHDRAW_THRESHOLD` it logs `Withdrawing N stroops...` and then
`Withdrawal complete!` (or `[DRY-RUN] Withdrawal would be submitted (N
stroops)` in a dry run). **That live step currently fails**; see
[Known issue 4](#known-issue-4-the-bots-own-withdraw-and-expire-calls-fail).
Withdraw by hand as above, and set `WITHDRAW_THRESHOLD` higher than any balance
you expect to hold so the bot does not attempt it.

If the registry has an execution dispute window set (`dispute_window()` above
`0`), your reward is held for that many ledgers before it shows up in
`keeper_balance`. See [STAKING_GUIDE.md](STAKING_GUIDE.md), section 7.

## 11. Running continuously

Without `--once` the bot runs as a daemon: one round immediately, then one every
`POLL_INTERVAL_MS`.

```bash
npm start
```

The banner shows `Poll     : every 10s`. Stop it with Ctrl-C. The bot finishes
the round in progress and prints:

```text
SIGINT received — finishing current round then exiting...
Clean shutdown.
```

For a scheduler such as cron, use `--once` (or `RUN_ONCE=true`); the exit code is
0 only if the round had no errors. See [DEPLOYING.md](DEPLOYING.md) for cron
examples.

## Known issues (as of 2026-11-20)

These are defects or mismatches in the current repository, found while writing
this tutorial. They are not caused by your setup. Delete an item here once it
is fixed.

### Known issue 1: `XDR Read Error` on current testnet

**Symptom.** Every round ends with `Keeper loop error: XDR Read Error: unknown
StellarValueType member for value 3` and `Round completed with errors.`

**Cause.** Testnet is on protocol 30, and the `@stellar/stellar-sdk` 16.3.0
that the lockfiles pin cannot parse its ledger responses.

**Workaround.** The bot's RPC client comes from `packages/sdk-ts`, so update the
Stellar SDK **there** (updating it only inside `examples/keeper-bot` is not
enough), then rebuild:

```bash
cd packages/sdk-ts && npm update @stellar/stellar-sdk && npm run build
```

With `@stellar/stellar-sdk` 16.4.1 a full round completes against testnet.
`npm update` changes `package-lock.json`; do not commit that as part of
unrelated work.

### Known issue 2: dry run cannot print its decision record

**Symptom.** In dry-run mode, for each task the bot picks, you see
`Failed to claim/execute task N: Do not know how to serialize a BigInt`, no
JSON record, and `Round completed with errors.`

**Cause.** Task IDs are decoded from events as BigInt, and the dry-run writer
calls `JSON.stringify` on them.

**Workaround.** None in configuration. The evaluation still ran, so read the
`Attempting to claim` line. Do not rely on the JSON records that
[DRY_RUN.md](../examples/keeper-bot/DRY_RUN.md) describes, and note that the bot
never prints "skip" records for tasks it drops during evaluation.

### Known issue 3: unprofitable tasks are still claimed

**Symptom.** A task whose reward is below the bot's 60,000-stroop fee estimate
still gets `Attempting to claim`, with a negative `est net profit`, and is
claimed in a live run. `MIN_PROFIT_MARGIN_STROOPS` does not stop it.

**Cause.** The evaluation step computes profitability but the claim loop never
checks it, so the `are profitable candidates` count includes losing tasks.

**Workaround.** Only register or accept tasks with a reward well above 60,000
stroops, and check the `est net profit` in a dry run before a live run.

### Known issue 4: the bot's own withdraw and expire calls fail

**Symptom.** When the balance reaches `WITHDRAW_THRESHOLD` the bot prints
`Withdrawing N stroops...` and then `Balance check failed: undefined must be
authorized by undefined, but the available signer is G...`. Past-deadline tasks
print `Task ID expire failed (skip: ...)` with the same text. Because the
message is not recognised as a permanent error, each failure is preceded by
three `... failed (attempt N), retrying in Mms: ...` warnings.

**Cause.** `index.js` calls `client.invoke("withdraw_rewards", [...])` and
`client.invoke("expire_task", [...])` with positional arguments, but the SDK's
`invoke` takes one object (`{ method, args, source }`).

**Workaround.** Withdraw by hand as in [section 10](#10-withdraw-your-reward).
Set `WITHDRAW_THRESHOLD` above any balance you will hold, and set
`EXPIRE_STALE_TASKS=false` (expire stale tasks with `skn task expire` if you
want to).

### Known issue 5: the testnet registry in DEPLOYMENTS.md predates staking

**Symptom.** Each round logs `Stake check failed: keeper_stake simulation
failed: HostError: Error(WasmVm, MissingValue)`.

**Cause.** The contract deployed at the address in [DEPLOYMENTS.md](DEPLOYMENTS.md)
does not have the `keeper_stake` view. Testnet is also reset periodically, so
that address may stop working altogether.

**Workaround.** Ignore the warning, or deploy your own current registry with
[DEPLOYING.md](DEPLOYING.md).

## 12. Where to go next

- **Stake** if the registry you serve sets a minimum: see
  [STAKING_GUIDE.md](STAKING_GUIDE.md). The bot logs your stake every round, and
  `AUTO_STAKE_ENABLED=true` with `AUTO_STAKE_AMOUNT` makes it deposit once for a
  keeper that has never staked. It never tops up, and there is no on-chain
  minimum it could be topping up toward unless the admin set one.
- **Understand reputation**, which can gate claiming when the admin sets a
  floor: [REPUTATION.md](REPUTATION.md).
- **See where fees go**: [TREASURY.md](TREASURY.md).
- **Write a real executor.** Register a function for your task type in the
  `EXECUTORS` table in `index.js`; its contract is documented above the table.
  Return proof bytes on success or `null` to decline, and never fabricate one.
- **More dry-run recipes**: [../examples/keeper-bot/EXAMPLES.md](../examples/keeper-bot/EXAMPLES.md).
- **The v2 bot**: [KEEPER_BOT_V2_DESIGN.md](KEEPER_BOT_V2_DESIGN.md).
