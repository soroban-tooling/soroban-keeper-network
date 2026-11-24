# Writing a Verifier

A step-by-step guide to building, testing and attaching an on-chain **verifier**:
a small contract the registry calls from `execute_task` to decide whether a
keeper's proof is acceptable before the keeper is paid.

By the end you will have:

1. an empty crate turned into a verifier contract,
2. tests that run it through the real registry with the
   [`keeper-registry-test-support`](../contracts/verifiers/test-support) harness,
3. a WASM build, and
4. the commands to attach it to a task.

The finished crate from this guide lives in
[`contracts/verifiers/task-bound`](../contracts/verifiers/task-bound) and its tests
run in the workspace, so every Rust snippet below is code that compiles and passes.

Background reading, when you want the *why*:
[VERIFIER_DESIGN.md](VERIFIER_DESIGN.md) (interface, failure semantics, trust model)
and [VERIFIERS.md](VERIFIERS.md) (resource-cost methodology).

## Contents

- [How a verifier is used](#how-a-verifier-is-used)
- [Prerequisites](#prerequisites)
- [Step 1: create the crate](#step-1-create-the-crate)
- [Step 2: implement `verify`](#step-2-implement-verify)
- [Step 3: test it against the registry](#step-3-test-it-against-the-registry)
- [Step 4: build the WASM](#step-4-build-the-wasm)
- [Step 5: attach it to a task](#step-5-attach-it-to-a-task)
- [Step 6: what keepers must do](#step-6-what-keepers-must-do)
- [Design checklist](#design-checklist)
- [What the harness does not cover](#what-the-harness-does-not-cover)
- [Troubleshooting](#troubleshooting)

## How a verifier is used

A task owner may attach one verifier address when registering a task. When the
claiming keeper calls `execute_task(keeper, task_id, proof)`, the registry calls

```rust
fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool
```

on your contract before it credits anything. The outcome:

| Your `verify` | Result of `execute_task` |
|---------------|--------------------------|
| returns `true` | the task becomes `Executed` and the keeper is credited |
| returns `false` | fails with `VerificationFailed`; the task is unchanged, still `Claimed` |
| panics or traps | treated exactly like `false`; the transaction is **not** aborted |

Things worth knowing before you write a line:

- **The keeper pays for your verifier.** Soroban shares one resource budget across
  sub-calls, so your `verify` runs inside the keeper's transaction. An expensive
  verifier makes a task unprofitable and keepers will skip it.
- **You return a plain `bool`.** There is no reason code. If you want to explain a
  rejection, publish your own event before returning `false`.
- **Verifiers are permissionless.** The registry accepts any address. It neither
  vets nor trusts your contract; it only reacts to `true` or not-`true`.
- **The proof is at most 256 bytes** (`MAX_PROOF_LEN`), and it is published in the
  `exec` event, so never put a secret in it.
- **A verifier can be attached or changed only while the task is `Pending`.** After
  a keeper claims, it is fixed.

## Prerequisites

- Rust (with the `wasm32-unknown-unknown` target) and `cargo`.
- A checkout of this repository, for the path dependency on the test harness.
- To deploy: the [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli).

```bash
rustup target add wasm32-unknown-unknown
git clone https://github.com/soroban-tooling/soroban-keeper-network
```

> The `soroban-sdk` version must match the registry's (22.x at the time of
> writing). Check `[workspace.dependencies]` in the repository's root `Cargo.toml`.

## Step 1: create the crate

Start from nothing:

```bash
cargo new --lib my-verifier
cd my-verifier
```

Replace `Cargo.toml`:

```toml
[package]
name = "my-verifier"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
soroban-sdk = "22.0.1"

[dev-dependencies]
soroban-sdk = { version = "22.0.1", features = ["testutils"] }
# Adjust the path to wherever you cloned the repository.
keeper-registry-test-support = { path = "../soroban-keeper-network/contracts/verifiers/test-support" }
```

`cdylib` is what produces the deployable `.wasm`; `rlib` lets your tests link it.

(The example crate in this repository is the same, except its `keeper-registry-test-support`
path is `../test-support`.)

## Step 2: implement `verify`

Replace `src/lib.rs`. This example accepts only a proof that is exactly `done:`
followed by the task id as 8 big-endian bytes:

```rust
#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

const PREFIX: &[u8] = b"done:";

#[contract]
pub struct TaskBoundVerifier;

#[contractimpl]
impl TaskBoundVerifier {
    /// Called by `KeeperRegistry::execute_task`. Return `false` for a bad proof;
    /// never panic on merely invalid input.
    pub fn verify(env: Env, task_id: u64, _keeper: Address, proof: Bytes) -> bool {
        let mut expected = Bytes::from_slice(&env, PREFIX);
        expected.extend_from_array(&task_id.to_be_bytes());
        proof == expected
    }
}

#[cfg(test)]
mod test;
```

Points to copy:

- `#![no_std]` is required for Soroban contracts.
- The function must be named `verify` and have exactly this signature; the
  registry calls it by name and decodes the result as `bool`.
- No state, no storage writes, no loops over unbounded data: it stays cheap.
- Comparing against a value built from `task_id` binds the proof to one task, so
  a proof captured from one task's `exec` event cannot be replayed on another.

> This example proves nothing about real work: anyone who reads the rule can
> forge the proof. It exists to show the mechanics. A useful verifier checks
> something an attacker cannot fabricate, such as a signature from a known key,
> an oracle value, or an inclusion proof. See the [design checklist](#design-checklist).

## Step 3: test it against the registry

Create `src/test.rs`. The harness deploys a real, initialized registry in the test
environment, so `execute_task` calls your `verify` exactly as it will on-chain.

```rust
use keeper_registry_test_support::{KeeperError, TaskStatus, VerifierTestHarness};
use soroban_sdk::{testutils::Ledger as _, Bytes};

use crate::TaskBoundVerifier;

/// Registers a task with this verifier attached and claims it.
fn claimed_task(harness: &VerifierTestHarness) -> u64 {
    let env = harness.env();
    let verifier = env.register(TaskBoundVerifier, ());
    let task_id = harness
        .register_task_with_verifier(
            harness.owner_address(),
            Some(verifier),
            1_000_000,
            env.ledger().timestamp() + 3_600,
            &Bytes::new(env),
        )
        .unwrap();
    harness
        .claim_task(harness.keeper_address(), task_id)
        .unwrap();
    task_id
}

fn proof_for(harness: &VerifierTestHarness, task_id: u64) -> Bytes {
    let mut proof = Bytes::from_slice(harness.env(), b"done:");
    proof.extend_from_array(&task_id.to_be_bytes());
    proof
}

#[test]
fn approves_a_proof_bound_to_the_task() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);

    harness
        .execute_task(harness.keeper_address(), task_id, &proof_for(&harness, task_id))
        .unwrap();

    assert_eq!(harness.get_task(task_id).status, TaskStatus::Executed);
    assert_eq!(harness.keeper_balance(harness.keeper_address()), 1_000_000);
}

#[test]
fn rejects_a_wrong_proof_and_leaves_the_task_claimed() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);

    let result = harness.execute_task(
        harness.keeper_address(),
        task_id,
        &Bytes::from_slice(harness.env(), b"nope"),
    );

    assert_eq!(result, Err(KeeperError::VerificationFailed));
    assert_eq!(harness.get_task(task_id).status, TaskStatus::Claimed);
    assert_eq!(harness.keeper_balance(harness.keeper_address()), 0);
    assert_eq!(harness.fees_accrued(), 0);
}
```

The example crate has three more tests (a proof replayed from another task, retrying
after a rejection, and the deadline still applying); see
[`task-bound/src/test.rs`](../contracts/verifiers/task-bound/src/test.rs).

Run them:

```bash
cargo test
```

Expected result for the example crate:

```text
running 5 tests
test test::approves_a_proof_bound_to_the_task ... ok
test test::a_rejected_proof_can_be_retried ... ok
test test::deadline_still_applies_with_a_verifier_attached ... ok
test test::rejects_a_proof_replayed_from_another_task ... ok
test test::rejects_a_wrong_proof_and_leaves_the_task_claimed ... ok

test result: ok. 5 passed; 0 failed
```

(Test order may differ between runs.)

Things the harness gives you:

- `harness.owner_address()` is the funded task owner; `harness.keeper_address()`
  is the keeper. Use these, not addresses you generate yourself: an address made
  with a different `Env` will not work.
- `env.register(MyContract, ())` returns the contract's `Address` directly.
- The three entry points return `Result<_, KeeperError>`, so a rejection is a value
  you can assert on instead of a panic you have to catch.
- After a rejected proof, assert that nothing moved: the task is still `Claimed`,
  the keeper balance and `fees_accrued()` are unchanged.

## Step 4: build the WASM

```bash
cargo build --release --target wasm32-unknown-unknown
```

The artifact is `target/wasm32-unknown-unknown/release/my_verifier.wasm`
(underscores, from the crate name). Optionally shrink it:

```bash
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/my_verifier.wasm
```

## Step 5: attach it to a task

Deploy your verifier, then pass its contract ID as the `verifier` argument of
`register_task`:

```bash
# 1. Deploy the verifier (use your own identity; this prints its contract ID, C...)
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/my_verifier.wasm \
  --source <IDENTITY> --network testnet

# 2. Register a task with the verifier attached.
stellar contract invoke --id <REGISTRY_ID> --source <IDENTITY> --network testnet -- \
  register_task \
  --owner <OWNER_ADDRESS> \
  --task_type Custom \
  --calldata <HEX_BYTES> \
  --reward 10000000 \
  --deadline <UNIX_TIMESTAMP> \
  --ttl_ledgers 17280 \
  --lock_ledgers 120 \
  --verifier <VERIFIER_CONTRACT_ID>
```

Notes:

- `verifier` and `condition` are optional (`Option<Address>`); leave a flag out for
  `None`. This guide attaches only a verifier.
- `ttl_ledgers` must cover the time to the deadline plus a safety margin, and
  `lock_ledgers` must be between 12 and 17,280.
- The registry that **you** deploy from this repository's `main` supports verifiers.
  The shared testnet deployment recorded in [DEPLOYMENTS.md](DEPLOYMENTS.md) was built
  from an older version (`version()` returns `1`) and does not, so deploy your own
  registry to try a verifier on testnet ([DEPLOYING.md](DEPLOYING.md)).
- To change or clear the verifier on a task that is still `Pending`:

  ```bash
  stellar contract invoke --id <REGISTRY_ID> --source <IDENTITY> --network testnet -- \
    update_verifier --owner <OWNER_ADDRESS> --task_id <TASK_ID> --new_verifier <ADDRESS>
  ```

  Once a keeper has claimed the task this fails with `InvalidTaskStatus`.

The CLI commands in this step are not exercised by the repository's tests; steps 1
to 4 are.

## Step 6: what keepers must do

A keeper that claims a verified task has to produce a proof your `verify` accepts.
Publish your proof format wherever keepers will read it, because they decide whether a
task is worth claiming based on whether they can produce it and what `verify` costs.

If the proof is wrong, `execute_task` fails with `VerificationFailed` and the keeper
may simply retry with a corrected proof while it still holds the claim. If the
keeper cannot produce a valid proof, the task is recoverable: the owner may
`cancel_task` once the lock window elapses, and anyone may `expire_task` after the
deadline.

The example keeper bot skips tasks whose verifier it has no proof strategy for,
before claiming, so it does not waste a claim on them.

## Design checklist

- **Return `false`, do not panic, on a bad proof.** A panic is handled the same way
  but signals "this contract is broken".
- **Bind the proof to the task.** Include or derive from `task_id`, so a proof for
  one task is useless on another.
- **Consider binding it to the keeper.** `execute_task` passes the claiming `keeper`
  address. A verifier that ignores it (like the example) lets any keeper that learns
  a valid proof reuse it on the same task. Proofs are public in the `exec` event.
- **Check something unforgeable.** A signature from a known key, an oracle reading,
  an inclusion proof. If an attacker can write the proof from the rules alone, the
  verifier gives no assurance.
- **Stay cheap and bounded.** No unbounded loops or large storage reads: the keeper
  pays, and an expensive verifier is skipped.
- **Keep it stateless where you can.** State you do write is shared by every task
  that uses the verifier.
- **Do not put secrets in the proof.** It is at most 256 bytes and is emitted in
  the `exec` event.
- **Publish the proof format.** Keepers cannot use a verifier they cannot satisfy.

## What the harness does not cover

`VerifierTestHarness` is intentionally small:

- the registry fee is 0%, so the keeper balance equals the reward;
- tasks are registered with `TaskType::Custom`, `lock_ledgers = 100` and no
  condition (`ttl_ledgers` is derived from your deadline);
- one owner and one keeper; for multi-keeper behavior use the registry's own tests;
- it measures no resource cost. To estimate what your `verify` costs a keeper, see the
  methodology in [VERIFIERS.md](VERIFIERS.md) and simulate the call before claiming.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `VerificationFailed` in a test | `verify` returned `false` or panicked. Test `verify` in isolation by calling it directly with a known-good proof. |
| `InvalidTaskStatus` on `execute_task` | The task was not claimed first, or it is already `Executed`/`Expired`/`Cancelled`. |
| `NotTaskClaimer` | Executing as a keeper other than the one that claimed. |
| `DeadlinePassed` | The ledger time reached the task's deadline; move the test clock back or extend the deadline. |
| `ProofTooLarge` | The proof is longer than 256 bytes. |
| A panic about an unknown or mismatched address in a test | An address was generated with a different `Env`; use the harness's addresses. |
| Linker error `export ordinal too large` on Windows (MinGW) | A toolchain limit on `cdylib` crates, not a code bug. Run the tests on Linux, WSL, or with the MSVC toolchain. |
