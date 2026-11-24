# Calling contract example

A minimal Soroban contract that registers a Keeper Network task by calling the
registry directly, instead of an off-chain script signing a `register_task`
transaction.

The whole example is one entry point, `register_on_behalf_of`, in
[`src/lib.rs`](src/lib.rs). It builds the call with
`KeeperRegistryCrossContract` from `soroban-keeper-sdk` and executes it with
`invoke()`.

## When should a contract register tasks itself?

Registering from a contract is the right tool when the decision to automate
something is made **on-chain**:

- A protocol opens a position, loan, vault or subscription and wants the
  follow-up (liquidation check, TTL extension, payment) scheduled in the same
  transaction, so there is no window where the state exists but the task does
  not.
- The task's parameters (calldata, deadline, reward) are derived from contract
  state that an off-chain script would otherwise have to read and re-submit.
- You want users to register tasks through your contract's UI or API without
  running any keys or tooling of their own.

Prefer an off-chain registration (the `skn` CLI, the SDKs, or
[`examples/batch-register`](../../../examples/batch-register)) when a human or
backend decides what to automate, or when you are registering many unrelated
tasks at once. A contract call adds an extra frame to every registration and
cannot batch across callers.

## Authorization model

The registry's `register_task` takes an `owner` address and does two things
with it: it calls `owner.require_auth()`, and it escrows `reward` by
transferring the reward token from `owner` to the registry. The owner is also
recorded on the task, and later owner-only calls (`increase_reward`,
`extend_deadline`, cancellation) are checked against it. So the same address
must authorize the registration, fund it, and be the one who can manage the
task afterwards.

In this example the roles are:

| Role | Who | What they authorize |
|------|-----|---------------------|
| Caller / task owner | The `owner` argument (usually a user account) | `register_on_behalf_of` on the calling contract, the nested `register_task` on the registry, and the reward token transfer into escrow |
| Calling contract | `CallingContract` | Nothing of its own. It forwards `owner` and never holds the reward |
| Registry | The `registry` argument | Escrows the reward and stores the task with `owner` as its owner |

Things to know:

- **`owner.require_auth()` appears twice, and both are satisfied by one
  signature.** The calling contract checks it in `register_on_behalf_of`, and
  the registry checks it again in `register_task`. A Soroban auth entry
  covers a whole invocation tree, so the owner signs once for the root call
  and the sub-calls under it. Use transaction simulation to produce the auth
  entries rather than building the tree by hand.
- **The calling contract is not the owner.** Because `owner` is a parameter,
  the user keeps ownership and can manage the task later. The calling contract
  has no special rights over it.
- **The funds come from `owner`.** The owner must hold at least `reward` of
  the registry's reward token. The calling contract never custodies it.
- **Validation is the registry's.** `reward`, `deadline`, `ttl_ledgers`,
  `lock_ledgers` and `calldata` length are validated by `register_task`, and
  registration is rejected while the registry is paused. The example does not
  duplicate those checks.
- **Pin the registry address in a real integration.** The example takes
  `registry` as an argument so it can be pointed at any deployment. A
  production contract should store the registry address at initialization
  (and restrict who can change it) so callers cannot supply a different
  contract.

### Registering with the contract itself as the owner

If the contract should own the task (for example, a protocol that funds its own
automation from its treasury), pass `env.current_contract_address()` as
`owner`. Two differences from the example apply. This variant is **not**
implemented in the example; treat it as a pattern to verify against the
Soroban authorization docs for your SDK version:

- A contract address authorizes calls it makes directly, but the reward
  transfer is made by the registry one level deeper, against the token
  contract. The contract has to pre-authorize that nested transfer with
  `env.authorize_as_current_contract(...)`.
- The contract must hold the reward balance itself, and it needs its own entry
  points to call `increase_reward` or cancel the task later, because no user
  account owns it.

## Run the example

The example contract has a unit test that checks the cross-contract invocation
is built against the right registry address. From the repository root:

```bash
# Unit test (host target)
cargo test --manifest-path rust-sdk/examples/calling-contract/Cargo.toml

# Build the contract to WASM
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown \
  --manifest-path rust-sdk/examples/calling-contract/Cargo.toml
```

To try it on testnet, deploy the WASM and invoke the entry point with the
Stellar CLI, replacing the placeholders. See [docs/DEPLOYING.md](../../../docs/DEPLOYING.md)
for deploying contracts and [docs/BATCH_OPERATIONS.md](../../../docs/BATCH_OPERATIONS.md)
for the registration parameters:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/calling_contract.wasm \
  --source <your-identity> --network testnet

stellar contract invoke --id <CALLING_CONTRACT_ID> \
  --source <owner-identity> --network testnet \
  -- register_on_behalf_of \
  --registry <REGISTRY_CONTRACT_ID> \
  --owner <OWNER_ADDRESS> \
  --task_type '"Liquidation"' \
  --calldata <HEX_CALLDATA> \
  --reward 1000000 \
  --deadline <UNIX_SECONDS_IN_THE_FUTURE> \
  --ttl_ledgers 17280 \
  --lock_ledgers 120 \
  --verifier null \
  --condition null
```

The JSON encoding of `task_type`, `verifier` and `condition` follows the CLI's
conventions; run `stellar contract invoke --id <CALLING_CONTRACT_ID> -- register_on_behalf_of --help`
to see the exact form for your CLI version.

The owner identity must be the `--source` (or otherwise sign) so its
authorization is recorded during simulation, and it must hold the reward token.
The call prints the new task id.
