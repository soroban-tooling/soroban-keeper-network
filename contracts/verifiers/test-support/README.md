# Keeper Registry Test Support

A minimal test harness for verifier authors: it deploys and initializes a real
`KeeperRegistry` inside the Soroban test environment so you can test your
verifier through `execute_task`, the way it will really be called.

For a full walkthrough see [docs/WRITING_A_VERIFIER.md](../../../docs/WRITING_A_VERIFIER.md).
A complete worked example lives in [`../task-bound`](../task-bound).

## Quick start

```toml
[dev-dependencies]
keeper-registry-test-support = { path = "../path/to/contracts/verifiers/test-support" }
soroban-sdk = { version = "22.0.1", features = ["testutils"] }
```

```rust
use keeper_registry_test_support::VerifierTestHarness;
use soroban_sdk::Bytes;

#[test]
fn my_verifier_approves() {
    let harness = VerifierTestHarness::new();
    let env = harness.env();

    // `register` returns the contract's Address directly.
    let verifier = env.register(MyVerifier, ());

    let task_id = harness
        .register_task_with_verifier(
            harness.owner_address(),
            Some(verifier),
            1_000_000,                       // reward in stroops
            env.ledger().timestamp() + 3600, // deadline
            &Bytes::from_slice(env, b"calldata"),
        )
        .unwrap();

    harness.claim_task(harness.keeper_address(), task_id).unwrap();
    harness
        .execute_task(harness.keeper_address(), task_id, &Bytes::from_slice(env, b"proof"))
        .unwrap();

    assert!(harness.keeper_balance(harness.keeper_address()) > 0);
}
```

## API

`VerifierTestHarness::new()` creates a registry with a 0% fee, a native-style
test token, and three accounts: an admin, a funded task owner, and a keeper.
Use the harness's own addresses; addresses made elsewhere belong to a different
`Env` and will not work.

- `env()` - the Soroban test `Env` (deploy your verifier with `env.register(..)`)
- `owner_address()`, `keeper_address()`, `admin_address()` - the harness accounts
- `register_task_with_verifier(owner, verifier, reward, deadline, calldata)` -
  returns the new task id, or the registry's `KeeperError`
- `claim_task(keeper, task_id)`, `execute_task(keeper, task_id, proof)`
- `get_task(task_id)`, `keeper_balance(keeper)`, `fees_accrued()`
- `reward_token_address()`, `registry_address()`
- `assert_escrow_released(harness, task_id)`, `assert_no_escrow_movement(harness, keeper_balance_before, fees_before)`

`register_task_with_verifier`, `claim_task` and `execute_task` return
`Result<_, KeeperError>`, so a rejection is a value you can assert on, for
example `Err(KeeperError::VerificationFailed)`.

Registration uses `lock_ledgers = 100`, no condition and `TaskType::Custom`;
`ttl_ledgers` is derived from your deadline so the registry's TTL check always passes.

## See also

- [Verifier design](../../../docs/VERIFIER_DESIGN.md)
- [Verifier cost catalog and testing notes](../../../docs/VERIFIERS.md)
- [Registry contract](../../keeper-registry)
