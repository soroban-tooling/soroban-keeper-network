# Getting Started: from zero to an executed task

This tutorial takes you from an empty machine to a task that a keeper bot has
claimed, executed and been paid for, on Stellar testnet. You will:

1. install the tools,
2. build the registry contract and deploy your own copy to testnet,
3. register a task,
4. run the example keeper bot and watch it execute the task,
5. withdraw the keeper's reward.

## How to read this tutorial: what is verified and what is not

Parts of this tutorial could not be run end to end when it was written. Rather
than present guesses as facts, **every step is labeled**:

| Label | Meaning |
|-------|---------|
| **[Verified]** | Run or checked directly, as the step says. Outputs shown are real. |
| **[Not verified]** | Written from the contract source, the bot source and the Stellar CLI's documented behavior, but not run. Outputs are shown as a *shape*, with `<placeholders>` for values that differ per run. |

Verified on 2026-11-19: the contract builds to WASM and passes its tests; the SDK
and bot install and start; the read-only calls against the shared testnet
deployment. **Not** verified: any command that needs the Stellar CLI or sends a
testnet transaction (the CLI did not run on the authoring machine, and no
transactions were sent), and the bot executing a task end to end.

If you complete this tutorial, or a step does not behave as written, please open
an issue or PR so the label can be changed or the step fixed.

**Known problems at the time of writing** (each is called out again where it bites):

- The pinned toolchain (`rust-toolchain.toml`, Rust 1.82.0) cannot read some crates
  in `Cargo.lock` that need Cargo 1.85 or later. Use a newer toolchain, as step 2 shows.
- The example bot, as pinned, fails to read events from live testnet. Step 5 shows
  the error and a manual route that does not need the bot.
- The shared testnet deployment in [DEPLOYMENTS.md](DEPLOYMENTS.md) is an older
  contract version (`version()` returns `1`). This tutorial therefore has you deploy
  your own current copy.

## What you need

- A computer with a terminal: Linux, macOS, or Windows with WSL.
- About 30 minutes and an internet connection.
- No real money: everything uses testnet XLM from a free faucet.

## Step 1: install the tools **[Not verified]**

You need Git, Node.js 18 or later, Rust with the WASM target, and the Stellar CLI.

```bash
# Rust (skip if you already have it) and the WASM target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup toolchain install stable
rustup target add wasm32-unknown-unknown --toolchain stable

# Stellar CLI (version 22 or later; see the Stellar docs for other install methods)
cargo install --locked stellar-cli

# Get the code
git clone https://github.com/soroban-tooling/soroban-keeper-network
cd soroban-keeper-network
```

Check the tools:

```bash
rustc +stable --version
node --version
stellar --version
```

Expected: a `rustc` version of 1.85 or later, a Node version of `v18` or later, and a
`stellar` version of 22 or later. Exact numbers will differ.

> **Windows without WSL:** building the contracts with the MinGW toolchain fails with
> `export ordinal too large`. Use WSL, or the MSVC toolchain.

## Step 2: build the registry contract **[Verified]**

The repository pins Rust 1.82.0, which cannot parse some dependencies in
`Cargo.lock`. The `+stable` prefix overrides the pin for this command.

```bash
cargo +stable build -p keeper-registry --target wasm32-unknown-unknown --release
ls -l target/wasm32-unknown-unknown/release/keeper_registry.wasm
```

Expected output (verified on Linux with Rust 1.98.1; the size and timestamp will
differ slightly on other versions):

```text
   Compiling keeper-registry v0.1.0 (.../contracts/keeper-registry)
    Finished `release` profile [optimized] target(s) in 3.78s
-rwxr-xr-x 2 root root 86864 Nov 19 19:06 target/wasm32-unknown-unknown/release/keeper_registry.wasm
```

The first build downloads and compiles dependencies and takes several minutes; the
timing above is for an already-warm build.

Optionally shrink the file (`optimize` writes a `.optimized.wasm` next to it)
**[Not verified]**:

```bash
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/keeper_registry.wasm
```

> This step needs the contract to compile, which depends on the build repair in
> [#929](https://github.com/soroban-tooling/soroban-keeper-network/pull/929). If
> `cargo build` fails with `field 'condition' specified more than once`, that fix has
> not reached your checkout yet.

## Step 3: create two testnet accounts **[Not verified]**

You need an **owner** (who posts and funds tasks and deploys the contract) and a
**keeper** (who executes them). Create both and fund them from the testnet faucet:

```bash
stellar keys generate owner  --network testnet --fund
stellar keys generate keeper --network testnet --fund
stellar keys address owner
stellar keys address keeper
```

Expected: the last two commands each print a public address, a 56-character string
starting with `G`:

```text
G<56-character public key of the owner>
G<56-character public key of the keeper>
```

Note both addresses; the commands below call them `<OWNER_ADDRESS>` and
`<KEEPER_ADDRESS>`. The secret keys stay in the CLI's key store. Never commit or
share them.

## Step 4: deploy and initialize your registry **[Not verified]**

Deploy the WASM from step 2:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/keeper_registry.wasm \
  --source owner --network testnet
```

Expected: one line, the new contract's ID, a 56-character string starting with `C`.
Save it as `<REGISTRY_ID>`:

```text
C<56-character contract ID>
```

Find the address of the testnet native-XLM token contract, which is what the
registry will hold rewards in:

```bash
stellar contract id asset --asset native --network testnet
```

Expected: another `C...` address, saved as `<TOKEN_ID>`. For testnet's native asset
the repository's [DEPLOYMENTS.md](DEPLOYMENTS.md) records
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`; your command should
print the same value.

Initialize the registry with yourself as admin and a 3% protocol fee:

```bash
stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- \
  initialize \
  --admin <OWNER_ADDRESS> \
  --reward_token <TOKEN_ID> \
  --fee_bps 300
```

Expected: the call succeeds and prints `null` (the function returns nothing).

Check it worked:

```bash
stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- version
stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- get_fee_bps
stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- task_count
```

Expected (the version number is the contract's `VERSION` constant at the commit you
built; at the time of writing it is `6`):

```text
6
300
0
```

### What the shared deployment looks like **[Verified, read-only]**

For comparison, the maintainers' shared deployment from
[DEPLOYMENTS.md](DEPLOYMENTS.md) was queried with read-only simulated calls on
2026-11-19 (using the Stellar JavaScript SDK, not the CLI, so the CLI's exact output
formatting may differ):

| Call | Value returned |
|------|----------------|
| `version` | `1` |
| `task_count` | `1` |
| `get_fee_bps` | `300` |
| `fees_accrued` | `300000` |
| `is_paused` | `false` |
| `min_reward` | `0` |
| `admin` | `GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM` |

`version` `1` is the original contract, whose `register_task` takes eight arguments
instead of the ten used below. Do not write to the shared deployment to follow this
tutorial: it is the maintainers' recorded demo.

## Step 5: register a task **[Not verified]**

The example bot knows how to execute one task type out of the box, `TtlExtension`,
whose calldata is empty. Register one with a 1 XLM (10,000,000 stroops) reward and a
deadline one hour from now:

```bash
DEADLINE=$(( $(date +%s) + 3600 ))

stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- \
  register_task \
  --owner <OWNER_ADDRESS> \
  --task_type TtlExtension \
  --calldata "" \
  --reward 10000000 \
  --deadline "$DEADLINE" \
  --ttl_ledgers 20000 \
  --lock_ledgers 120
```

Why those numbers:

- `--ttl_ledgers 20000` must cover the time to the deadline (one hour is about 720
  ledgers at roughly five seconds each) plus a one-day safety margin (17,280). A smaller
  value fails with `TtlTooShort`.
- `--lock_ledgers 120` (about ten minutes) must be between 12 and 17,280.
- `--verifier` and `--condition` are optional and left out, so no extra checks apply.
  See the verifier guide (`docs/WRITING_A_VERIFIER.md`) if you want one.
- `--calldata ""` is an empty byte string. If your CLI version rejects an empty value,
  pass `--calldata 00` and the bot will still execute the task, since it ignores the
  calldata of a `TtlExtension` task.

Expected: the call prints the new task's ID. On a fresh registry that is `1`:

```text
1
```

Confirm it is waiting:

```bash
stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- get_task --task_id 1
```

Expected: a JSON object for the task with `"status"` showing it is pending
(`Pending`), your owner address, `"reward": "10000000"`, the deadline you set, and
`"claimer": null`. The exact field layout and formatting are up to the CLI.

The 1 XLM has now moved from your owner account into the registry as escrow.

## Step 6: run the keeper bot

The bot polls for new tasks, claims one it can execute, submits a proof, and pulls
its rewards.

### Install it **[Verified]**

The bot depends on the TypeScript SDK in this repository, which must be built first;
without it the bot stops with `Cannot find module ... @soroban-keeper-network/sdk/dist/index.js`.

```bash
cd packages/sdk-ts
npm install
npm run build
cd ../../examples/keeper-bot
npm install
```

Expected: both `npm install` commands finish (they may print an `npm audit` warning
about vulnerabilities, which you can ignore for a testnet tutorial), and
`npm run build` runs `tsc -p tsconfig.json` and exits without errors.

### Configure it **[Not verified]**

```bash
cp .env.example .env
```

Edit `.env` and set:

```text
NETWORK=testnet
KEEPER_SECRET_KEY=<the keeper's secret key, starts with S>
REGISTRY_CONTRACT_ID=<REGISTRY_ID>
WITHDRAW_THRESHOLD=9000000
```

Get the keeper's secret key with `stellar keys show keeper`. Keep `.env` private; it
is ignored by git.

`WITHDRAW_THRESHOLD` matters: the default is 10,000,000 stroops (1 XLM), but with a 3%
fee the keeper is credited only 9,700,000 stroops for your 1 XLM task, so the bot would
never auto-withdraw. 9,000,000 is below that, so it will.

### Dry run first **[Verified, with a known problem]**

A dry run does everything except sign and submit transactions, and needs no secret key:

```bash
DRY_RUN=true NETWORK=testnet REGISTRY_CONTRACT_ID=<REGISTRY_ID> node index.js --once
```

The start of the output is as follows (verified against the shared deployment; the
keeper address is a throwaway one the bot generates in dry-run mode, so yours will
differ, and the ledger number will be higher):

```text
[DRY-RUN] Using temporary keypair for read operations

Soroban Keeper Network — Keeper Bot v0.1.0

  Network  : testnet
  RPC URL  : https://soroban-testnet.stellar.org
  Keeper   : G<temporary public key>
  Registry : <REGISTRY_ID>
  Mode     : DRY-RUN (decisions logged, no transactions submitted)
  Withdraw : when balance ≥ 10000000 stroops
  Staking  : visibility only (no minimum enforced on-chain — AUTO_STAKE_ENABLED=false)

RPC healthy — ledger <number>
```

**Known problem.** When this was run on 2026-11-19 the next lines were:

```text
Keeper round (DRY-RUN mode) at <timestamp>
Keeper loop error: XDR Read Error: unknown StellarValueType member for value 3
Round completed with errors.
```

The bot pins `@stellar/stellar-sdk` to `^16.2.0`, and that version could not decode
the event data the testnet RPC returned at the time. If you see the same error, the
bot cannot discover tasks, so use the manual route below. The fix is a dependency
update in `examples/keeper-bot`, outside the scope of this tutorial. (Against the
shared version-1 deployment the same run also printed `keeper_stake simulation
failed ... MissingValue`, because that old contract has no `keeper_stake` function;
that does not apply to a registry you deploy from current `main`.)

### Run it for real **[Not verified]**

If the dry run completed without the error above, start the bot:

```bash
node index.js
```

The messages below come from reading the bot's source; their exact wording and
ordering were not observed. You should see the startup banner (with `Mode` and `Poll`
lines), then each polling round print a line like `Keeper round at <timestamp>`,
followed by a line that task `1` was claimed:

```text
  Task 1 claimed!
```

then the bot executes the task (a `TtlExtension` task needs no real off-chain work;
the bot simply confirms the deadline has not passed and builds a proof), submits
`execute_task`, and later checks its balance and withdraws:

```text
  Accumulated reward balance: 9700000 stroops
  Withdrawing 9700000 stroops...
  Withdrawal complete!
```

`9700000` is 10,000,000 minus the 3% fee (300,000). Stop the bot with Ctrl+C; it
finishes the current round and prints `Clean shutdown.`

### Or do the keeper's steps by hand **[Not verified]**

You can perform exactly what the bot does with the CLI. This route does not depend on
the bot or its SDK version, and it is the clearest way to see each lifecycle step
(the task lifecycle guide, `docs/TASK_LIFECYCLE.md`, explains the rules behind each call).

Claim the task as the keeper:

```bash
stellar contract invoke --id <REGISTRY_ID> --source keeper --network testnet -- \
  claim_task --keeper <KEEPER_ADDRESS> --task_id 1
```

Expected: `null`. The task is now claimed by your keeper for 120 ledgers.

Execute it, submitting a proof (at most 256 bytes, given as hex; this one is the
text `ttl-extension:task:1:confirmed-live`):

```bash
stellar contract invoke --id <REGISTRY_ID> --source keeper --network testnet -- \
  execute_task --keeper <KEEPER_ADDRESS> --task_id 1 \
  --proof 74746c2d657874656e73696f6e3a7461736b3a313a636f6e6669726d65642d6c697665
```

Expected: `null`. The task is now executed and the keeper's balance is credited.

## Step 7: check the result and withdraw **[Not verified]**

```bash
stellar contract invoke --id <REGISTRY_ID> --source keeper --network testnet -- \
  keeper_balance --keeper <KEEPER_ADDRESS>

stellar contract invoke --id <REGISTRY_ID> --source owner --network testnet -- fees_accrued
```

Expected values, because the contract's arithmetic is exact (reward 10,000,000, fee
3%): the keeper balance is `9700000` and the fees accrued are `300000`. The CLI may
print 128-bit numbers in quotes.

Withdraw the keeper's balance to its account:

```bash
stellar contract invoke --id <REGISTRY_ID> --source keeper --network testnet -- \
  withdraw_rewards --keeper <KEEPER_ADDRESS>
```

Expected: it prints the amount withdrawn, `9700000` (possibly quoted). Your keeper
account's XLM balance rises by about that much, minus the network fee you paid for the
transactions.

For reference, the maintainers recorded a real run of the same four steps (register,
claim, execute, withdraw) against the older version-1 deployment: see
[DEMO.md](DEMO.md). It shows the same 1.0 XLM in, 0.97 XLM out, 0.03 XLM fee split,
with every transaction linked on the block explorer.

## What you just did

You walked a task through its whole life: **Pending** (registered and funded),
**Claimed** (a keeper locked it), **Executed** (a proof was accepted and the keeper
credited). The unused exits are `cancel_task` (the owner takes the reward back before
anyone claims) and `expire_task` (anyone refunds the owner after the deadline). Those
rules, with every guard and event, are in the task lifecycle guide (`docs/TASK_LIFECYCLE.md`).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `cargo build` fails with `edition2024 is required` | The pinned Rust 1.82.0 is in use. Add `+stable` as in step 2. |
| `cargo build` fails with `field ... specified more than once` or `failed to load manifest` | Your checkout predates the build repair in #929. |
| `TtlTooShort` from `register_task` | `--ttl_ledgers` is too small for the deadline. Use at least `(seconds until deadline / 5) + 17280`. |
| `InvalidTaskParams` from `register_task` | `--lock_ledgers` is outside 12 to 17,280, or `--ttl_ledgers` is below 1,000. |
| `DeadlinePassed` | The deadline is in the past, or the task's deadline has already arrived. |
| Bot: `Cannot find module ... sdk/dist/index.js` | Build `packages/sdk-ts` first (step 6, install). |
| Bot: `XDR Read Error: unknown StellarValueType member` | The bot's pinned SDK cannot read current testnet events. Use the manual route. |
| Bot never withdraws | `WITHDRAW_THRESHOLD` is above the keeper's balance. Set it to `9000000`. |
| Bot ignores the task | It only executes `TtlExtension` tasks by default; other types are skipped, not faked. |
| An authorization error, or `NotTaskClaimer` | The wrong account signed. `claim_task` and `execute_task` must come from the same keeper. |
| Testnet account or contract not found | Testnet is reset periodically. Recreate and re-fund your accounts and redeploy. |
