# Live Demo — Stellar Testnet

The `KeeperRegistry` contract is **deployed and running on Stellar testnet**.
This page records a full, real end-to-end run — every step below is an actual
on-chain transaction you can open on the block explorer.

## Deployment

| | |
|---|---|
| **Network** | Testnet (`Test SDF Network ; September 2015`) |
| **Contract ID** | [`CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4`](https://stellar.expert/explorer/testnet/contract/CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4) |
| **WASM hash** | `e9defafc84fd207e3bcc3cf18768b30207d20962df664c0167c2cf06515a9796` |
| **Reward token** | native XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| **Protocol fee** | 300 bps (3%) |

Accounts used in the run:

- **Owner / admin (dApp):** `GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM`
- **Keeper:** `GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K`

## End-to-end transaction trace

A single task registered, claimed, executed, and settled — the complete keeper
loop, on-chain:

| Step | What happened | Transaction |
|------|---------------|-------------|
| Upload WASM | Contract code installed | [`97e6c1e4…`](https://stellar.expert/explorer/testnet/tx/97e6c1e42cc85c88ff83b28436bfe2d49d0d705dcd395b2c28d485ef96855a4f) |
| Deploy | Contract instance created | [`29250323…`](https://stellar.expert/explorer/testnet/tx/2925032370a56729bcb40069c3017d44da2a4f269970b0e4e1e26b0eaf21572f) |
| `initialize` | Admin, reward token, 3% fee set | [`435e01dc…`](https://stellar.expert/explorer/testnet/tx/435e01dc75df8f5822fcf67ea3828360078aedb6eda7355bd13e7704b229e96a) |
| `register_task` | Owner posts a Liquidation task, escrows **1.0 XLM** | [`e308f155…`](https://stellar.expert/explorer/testnet/tx/e308f155b39c58fbae8eb60891db2d56ec46a627b277aa1540f256b3ffd65339) |
| `claim_task` | Keeper locks task #1 | [`6b91bfdb…`](https://stellar.expert/explorer/testnet/tx/6b91bfdb136afc15c0590e78db4a77ff1ee58637931f3d9340fff3c463412d7f) |
| `execute_task` | Keeper submits proof, credited **0.97 XLM** | [`538aff0a…`](https://stellar.expert/explorer/testnet/tx/538aff0a729a5f00d9749611dd8d669b038c30fea8aa2263db59a24d0f07eeb6) |
| `withdraw_rewards` | Keeper withdraws **0.97 XLM** to its account | [`d42c1c90…`](https://stellar.expert/explorer/testnet/tx/d42c1c90513510ac4455a37485fd98a9ac231273d967d4426c11309a8a568cac) |

### Result

- Owner escrowed **1.0 XLM**; keeper received **0.97 XLM**; **0.03 XLM** (3%)
  retained as protocol fee. Verified on-chain: `fees_accrued` returns `300000`
  stroops and `task_count` returns `1`.
- Every state transition emitted its event (`reg`, `claim`, `exec`, `wdraw`),
  visible in each transaction's event log on the explorer.

## Reproduce it yourself

See [DEPLOYING.md](DEPLOYING.md) for the full command sequence. In short:

```bash
make wasm
stellar keys generate me --network testnet --fund
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/keeper_registry.optimized.wasm \
  --source me --network testnet
# initialize → register_task → claim_task → execute_task → withdraw_rewards
```

> Testnet state is periodically reset by the network; the transaction links
> above are permanent records, while the live contract entry may expire.

---

## Verifier-gated task walkthrough

The above trace shows the basic flow with no execution verification. The
registry also supports **optional per-task verifiers** — contracts implementing
the `IKeeperVerifier` interface that `execute_task` calls before crediting the
keeper. This section demonstrates the full flow using the **signature-based
reference verifier** (E04, issue 0077).

> **Note:** This walkthrough assumes the verifier feature and signature-verifier
> reference implementation exist on `main`. See [`docs/VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md)
> for the interface design and [`docs/VERIFIERS.md`](VERIFIERS.md) for the full
> integration reference.

### Step 1: Deploy the signature verifier

The signature verifier validates that a submitted proof is a cryptographic
signature over `(task_id, keeper)` made by a pre-registered public key.

```bash
# Build the verifier WASM
cd contracts/signature-verifier
cargo build --release --target wasm32-unknown-unknown
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/signature_verifier.wasm

# Deploy it
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/signature_verifier.optimized.wasm \
  --source owner --network testnet

# Returns a contract ID, e.g.:
# CCSIGNATUREVERIFIEREXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Initialize it with the allowed signing key (typically your off-chain keeper bot's
public key):

```bash
stellar contract invoke \
  --id CCSIGNATUREVERIFIEREXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXX \
  --source owner --network testnet \
  -- initialize \
  --admin GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM \
  --allowed_signer GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
```

### Step 2: Register a task with the verifier attached

Register a task exactly as before, but pass the verifier contract ID as the
optional `verifier` parameter:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source owner --network testnet \
  -- register_task \
  --owner GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM \
  --task_type '{"Liquidation": null}' \
  --execute_at_ledger 1234567 \
  --lock_ledgers 100 \
  --reward 10000000 \
  --verifier CCSIGNATUREVERIFIEREXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXX
```

The task is now registered with **verification required**. The registry will
invoke the verifier's `verify()` function during `execute_task`.

### Step 3: Claim the task (unchanged)

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- claim_task \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --task_id 2
```

### Step 4: Generate a valid signed proof

The keeper must now produce a proof that satisfies the signature verifier:

```bash
# Off-chain: sign (task_id || keeper_address) with the allowed signing key
# This example uses a simple script — a real bot would integrate this into its
# execution pipeline

cat > sign_proof.js << 'EOF'
const StellarSdk = require('@stellar/stellar-sdk');
const task_id = process.argv[2];
const keeper = process.argv[3];
const secret = process.argv[4];

const keypair = StellarSdk.Keypair.fromSecret(secret);
const message = Buffer.concat([
  Buffer.from(task_id.toString().padStart(16, '0')),
  Buffer.from(keeper)
]);
const signature = keypair.sign(message);
console.log(signature.toString('hex'));
EOF

node sign_proof.js 2 GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  KEEPER_SECRET_KEY_HERE

# Returns a hex-encoded signature, e.g.:
# a8f3c2d1e9b7a5c4f8e2d9c1b7a3f5e8c9d2a1b4f7e3c5a9d8b2c1a4f7e8a3...
```

### Step 5a: Execute with a valid proof (success path)

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- execute_task \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --task_id 2 \
  --proof a8f3c2d1e9b7a5c4f8e2d9c1b7a3f5e8c9d2a1b4f7e3c5a9d8b2c1a4f7e8a3...
```

**Result:** `execute_task` calls the verifier's `verify(task_id=2, keeper=GD7D..., proof=a8f3...)`,
which validates the signature and returns `true`. The keeper is credited the
reward minus protocol fee, and the `exec` event is emitted with the proof
included.

### Step 5b: Execute with an invalid proof (rejection path)

```bash
# Try to execute with a different signature or garbage bytes
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- execute_task \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --task_id 2 \
  --proof deadbeef
```

**Result:** `execute_task` calls `verify(task_id=2, keeper=GD7D..., proof=deadbeef)`,
which returns `false` because the signature is invalid. The transaction reverts
with `KeeperError::VerificationFailed`. No state changes are persisted — the
task remains `Claimed` by the keeper, who can retry with a valid proof, or the
lock will eventually lapse and the task can be cancelled/expired normally.

### What happens if the verifier panics?

The registry uses `Env::try_invoke_contract` to call the verifier (see
[`docs/VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md) §2). If the verifier panics
(e.g., malformed proof triggers an uncaught error), `execute_task` catches it
and returns `KeeperError::VerificationFailed`, exactly as if the verifier had
explicitly returned `false`. The transaction does **not** revert entirely —
the keeper retains their claim lock and can debug and retry.

### Resource cost implications

Verifier calls consume resources (CPU/memory) charged to the keeper's
transaction. Before executing a verifier-gated task, simulate the transaction
to estimate the real cost:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- execute_task \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --task_id 2 \
  --proof VALID_PROOF_HERE \
  --simulate-only
```

The signature verifier's cost is documented in [`docs/VERIFIERS.md`](VERIFIERS.md)
§ "Reference verifier deltas." A keeper bot should factor this into its
profitability calculation before claiming.

### Testnet transaction trace (verifier-gated task)

A complete run using the signature verifier:

| Step | Transaction |
|------|-------------|
| Deploy signature verifier | [`abc123…`](#) (example placeholder) |
| Initialize verifier with signing key | [`def456…`](#) (example placeholder) |
| `register_task` with verifier attached | [`789ghi…`](#) (example placeholder) |
| `claim_task` | [`jkl012…`](#) (example placeholder) |
| `execute_task` with valid signed proof ✅ | [`mno345…`](#) (example placeholder) |
| (Alternative) `execute_task` with invalid proof ❌ | [`pqr678…`](#) (example placeholder) — reverts with `VerificationFailed` |

> **Note:** The transaction links above are placeholders; replace with actual
> testnet transactions once the signature verifier is deployed and this
> walkthrough is executed on testnet.

---

## Keeper staking walkthrough

Epic E06 adds keeper collateral: a keeper posts stake, an admin may slash it
for off-chain-adjudicated misbehavior, and a keeper can withdraw it back out
after a fixed unbonding delay. See [`docs/STAKING_DESIGN.md`](STAKING_DESIGN.md)
for the full design and the trade-offs behind each decision (why slashing is
admin-triggered rather than automatic or dispute-based, why unbonding has a
delay, why a slash is rejected outright rather than clamped) — this section
only walks through using it.

> **Note:** This walkthrough uses the same testnet contract ID and accounts
> as the trace above. Amounts are in stroops (1 XLM = 10,000,000 stroops),
> matching the rest of this document.

### Step 1: Deposit stake

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- stake_deposit \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --amount 50000000
```

This escrows 5.0 XLM from the keeper into the contract and emits
`StakeDeposited` (topics `("deposit", "stake")`). Reading it back:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- keeper_stake \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
```

**Result:** `keeper_stake` returns `50000000`. This is entirely separate
storage from the keeper's task-reward balance (`keeper_balance`) — staking,
claiming, and executing tasks never interfere with each other.

### Step 2: Start unbonding

A keeper who wants their stake back first calls `initiate_unbond`, which
starts a fixed delay (`UNBOND_DELAY_LEDGERS`, ~1 day) rather than releasing
funds immediately:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- initiate_unbond \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --amount 20000000
```

**Result:** returns the ledger sequence at which the 2.0 XLM becomes
withdrawable. No tokens move yet, and `keeper_stake` is unchanged at
`50000000` — the requested amount stays escrowed (and still slashable)
until it's actually withdrawn. Checking the pending request:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- unbonding_status \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
```

returns `Some((20000000, <release_ledger>))`.

### Step 3: Withdraw once the delay elapses

Calling `withdraw_stake` before `release_ledger` fails with
`KeeperError::UnbondNotReady`. Once the ledger sequence reaches it:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- withdraw_stake \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
```

**Result:** transfers 2.0 XLM back to the keeper, clears the pending
request, and `keeper_stake` drops to `30000000`. `StakeWithdrawn` is
emitted with the amount actually released.

### Step 4: A slash

Slashing is admin-triggered only (`docs/STAKING_DESIGN.md` §1) — there is
no automatic or dispute-based path in this version. The admin supplies a
stable `incident_id` so the same incident can never be slashed twice:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source owner --network testnet \
  -- slash \
  --admin GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --amount 10000000 \
  --reason fraud \
  --incident_id 0000000000000000000000000000000000000000000000000000000000000a \
  --treasury GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM
```

**Result:** 1.0 XLM moves from the keeper's stake to `treasury`, and
`keeper_stake` drops to `20000000`. A slash for more than the keeper's
current stake is rejected outright (`KeeperError::SlashExceedsStake`)
rather than silently reduced to what remains — the admin always knows
exactly what happened. Repeating the same `--incident_id` fails with
`KeeperError::DuplicateSlashIncident`. The keeper's aggregate track record
is readable without replaying events:

```bash
stellar contract invoke \
  --id CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4 \
  --source keeper --network testnet \
  -- slash_history \
  --keeper GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
```

returns `(1, 10000000)` — one incident, 1.0 XLM total slashed.

---

## Further reading

- **[`docs/VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md)** — the `IKeeperVerifier`
  interface, failure semantics, resource budget model, and trust model.
- **[`docs/VERIFIERS.md`](VERIFIERS.md)** — integration guide and measured
  resource cost deltas for each reference verifier.
- **[`docs/STAKING_DESIGN.md`](STAKING_DESIGN.md)** — the staking and slashing
  design: trigger model, storage layout, unbonding delay, and the decisions
  behind each (epic E06).
- **Backlog issues:**
  - **0071** — verifier design document
  - **0077** — signature-based reference verifier (used in this walkthrough)
  - **0078** — oracle-based reference verifier
  - **0079** — transaction-inclusion reference verifier
  - **0289** — stake storage and `stake_deposit`
  - **0290** — unbonding: `initiate_unbond` / `withdraw_stake`
  - **0291** — `slash` and its authorization model

---

## Treasury Walkthrough

This section walks through the lifecycle of the treasury contract, from configuring recipients to distributing a sweep.
For detailed reasoning behind the treasury's design, see [`docs/TREASURY_DESIGN.md`](TREASURY_DESIGN.md).

### 1. Configuring Recipients
The admin configures the recipients and their respective shares.
```bash
stellar contract invoke --id $TREASURY_ID --source admin \
  --network testnet \
  -- set_recipients --recipients ...
```

### 2. Triggering a Sweep
The admin sweeps accrued fees from the registry into the treasury.
```bash
stellar contract invoke --id $REGISTRY_ID --source admin \
  --network testnet \
  -- sweep_fees --treasury $TREASURY_ID --amount 1000
```

### 3. Distribution
Any user can trigger the distribution of the treasury's balance to the configured recipients based on their shares.
```bash
stellar contract invoke --id $TREASURY_ID --source any_user \
  --network testnet \
  -- distribute
```

### 4. Verifying Balances
After distribution, verify that each recipient's balance has increased by calling the treasury's view methods.
```bash
stellar contract invoke --id $TREASURY_ID --source any_user \
  --network testnet \
  -- get_recipient_balance --recipient $RECIPIENT_ADDRESS
```

---

## Governance proposal lifecycle walkthrough

Epic E09 decentralizes protocol ownership by replacing the single admin key with the **$KPRS governance token** and timelocked **Governance Contract** (`contracts/governance`). This walkthrough demonstrates the complete proposal lifecycle end-to-end on testnet: delegating administrative control, submitting a proposal, casting votes from multiple token holders, recording the outcome, queuing through the mandatory 48-hour timelock, executing permissionlessly, and confirming on-chain that the registry's parameter was updated.

For architectural design, tokenomics, quorum mechanics, and safety invariants, see [`docs/GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md). For event topic schemas and full history reconstruction, see [`docs/GOVERNANCE_EVENTS.md`](GOVERNANCE_EVENTS.md).

### Environment and accounts

The walkthrough assumes three funded testnet accounts holding $KPRS governance tokens:

- **Proposer / Voter 1 (Alice):** `GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM` (5,000,000 $KPRS)
- **Voter 2 (Bob):** `GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K` (3,000,000 $KPRS)
- **Voter 3 (Charlie):** `GC5QZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U99ZZ` (1,000,000 $KPRS)
- **Permissionless Executor (Anyone):** Any funded testnet keypair

Contract identifiers:
- `$REGISTRY_ID`: `CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4`
- `$GOVERNANCE_ID`: `CCGOVERNANCEEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`
- `$KPRS_TOKEN_ID`: `CCKPRSTOKENEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

---

### Step 1: Decentralize administration (One-time migration handshake)

Before governance can manage registry parameters, administrative ownership must transition from the original deployer key to the governance contract.

As specified in [`docs/GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) §6, this requires a two-sided authorization handshake initiated via `accept_admin`:

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source admin --network testnet \
  -- accept_admin \
  --current_admin GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM \
  --registry CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4
```

Verify that the registry's admin view now returns the governance contract ID:

```bash
stellar contract invoke \
  --id $REGISTRY_ID \
  --network testnet \
  -- admin
# Returns: "CCGOVERNANCEEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

The original admin key is now permanently locked out of all registry administrative entry points. All parameter modifications must now flow through the governance process.

---

### Step 2: Create a governance proposal

Alice holds 5,000,000 $KPRS (exceeding the 100,000 $KPRS proposal creation threshold per [`docs/GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) §3.1). She creates Proposal #1 to reduce the platform fee from 300 bps (3.0%) to 250 bps (2.5%):

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source alice --network testnet \
  -- propose \
  --proposer GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM \
  --action '{"SetFeeBps": 250}' \
  --description "Reduce platform execution fee from 300 bps to 250 bps"
```

**Result:**
- Returns proposal ID `1`.
- Snapshots the voting power at the current ledger sequence.
- Emits the `ProposalCreated` event (`topics: ("proposed", "gov")`, data: `(1, alice, eta)`).
- Sets proposal state to `Active`.

---

### Step 3: Cast votes from multiple accounts

During the active voting window (7 days / ~100,800 ledgers), token holders cast votes. Per [`docs/GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) §4.4, ballots are public and emit `VoteCast` events (`topics: ("vcast", "gov")` with `support`: `0 = Against`, `1 = For`, `2 = Abstain`).

#### Vote 1: Alice votes "For"

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source alice --network testnet \
  -- cast_vote \
  --voter GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM \
  --proposal_id 1 \
  --support 1
```
*Emits `VoteCast(1, alice, 1, 50000000000000)` (5,000,000 KPRS weighted "For").*

#### Vote 2: Bob votes "For"

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source bob --network testnet \
  -- cast_vote \
  --voter GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K \
  --proposal_id 1 \
  --support 1
```
*Emits `VoteCast(1, bob, 1, 30000000000000)` (3,000,000 KPRS weighted "For").*

#### Vote 3: Charlie votes "Against"

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source charlie --network testnet \
  -- cast_vote \
  --voter GC5QZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U99ZZ \
  --proposal_id 1 \
  --support 0
```
*Emits `VoteCast(1, charlie, 0, 10000000000000)` (1,000,000 KPRS weighted "Against").*

#### Inspect Proposal Tally:

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --network testnet \
  -- get_proposal \
  --proposal_id 1
```
**Tally Summary:**
- **Votes For:** 8,000,000 KPRS
- **Votes Against:** 1,000,000 KPRS
- **Total Participation:** 9,000,000 KPRS (satisfies 4,000,000 KPRS quorum, > 50% majority For).

---

### Step 4: Finalize the outcome

Once the voting period concludes, anyone can trigger `record_outcome` to evaluate quorum and majority conditions:

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source anyone --network testnet \
  -- record_outcome \
  --proposal_id 1
```

**Result:**
- Quorum is satisfied (`9,000,000 >= 4,000,000 KPRS`) and `For > Against`.
- Emits `ProposalPassed` (`topics: ("passed", "gov")`, data: `(1, 80000000000000, 10000000000000, 0)`).
- Proposal status updates from `Active` to `Succeeded`.

---

### Step 5: Queue the proposal in the timelock

Per [`docs/GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) §5.1, passed proposals cannot execute immediately; they must enter a mandatory 48-hour timelock delay (~28,800 ledgers) to give keepers and protocol users a grace period to review changes:

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source anyone --network testnet \
  -- queue_proposal \
  --proposal_id 1
```

**Result:**
- Sets `eta = current_ledger + 28800`.
- Emits `ProposalQueued` (`topics: ("queued", "gov")`, data: `(1, eta)`).
- Proposal status updates from `Succeeded` to `Queued`.

---

### Step 6: Verify timelock delay enforcement

Attempting to execute the proposal before the timelock expiration is rejected:

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source anyone --network testnet \
  -- execute_proposal \
  --proposal_id 1
```

**Result:**
Transaction reverts with `GovernanceError::TimelockNotElapsed` (Error code 7). Proposal remains safely locked in queue.

---

### Step 7: Permissionless execution

Once 48 hours (~28,800 ledgers) have elapsed and `current_ledger >= eta`, **any account** can call `execute_proposal`:

```bash
stellar contract invoke \
  --id $GOVERNANCE_ID \
  --source anyone --network testnet \
  -- execute_proposal \
  --proposal_id 1
```

**Internal Execution Flow:**
1. **Checks:** Verifies `status == Queued` and `current_ledger >= eta`.
2. **Effects:** Sets proposal status to `Executed` (Checks-Effects-Interactions pattern preventing reentrancy and replay).
3. **Interactions:** The governance contract calls `KeeperRegistryClient::set_fee_bps(250)`.
4. Emits `ProposalExecuted` (`topics: ("executed", "gov")`, data: `(1,)`).

---

### Step 8: Confirm registry parameter updated

Confirm on-chain that the registry's fee parameter changed without a human admin:

```bash
stellar contract invoke \
  --id $REGISTRY_ID \
  --network testnet \
  -- fee_bps
```

**Result:**
Returns `250` (2.50%).

The fee parameter has been updated from `300` to `250` through a transparent, community-voted, timelocked governance proposal.

