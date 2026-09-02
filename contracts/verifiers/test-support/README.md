# Keeper Registry Test Support

A minimal test harness for third-party verifier authors to test their Soroban smart contracts against the Keeper Registry without needing to understand the registry's internal test infrastructure.

## Quick Start

Add to your `Cargo.toml`:

```toml
[dev-dependencies]
keeper-registry-test-support = { path = "../path/to/keeper-registry/test-support" }
soroban-sdk = { version = "22.0.1", features = ["testutils"] }
```

## Example

```rust
#[test]
fn test_my_verifier_approves() {
    use keeper_registry_test_support::{VerifierTestHarness, keeper, owner};
    use soroban_sdk::{Bytes, Address};

    let harness = VerifierTestHarness::new();
    let env = harness.env();

    // Deploy your verifier contract
    let verifier_id = env.register(MyVerifier, ());
    let verifier_addr = Address::from_contract_id(&env, &verifier_id);

    // Register a task with your verifier attached
    let task_id = harness.register_task_with_verifier(
        &owner(),
        Some(verifier_addr),
        1_000_000,  // reward in stroops
        env.ledger().timestamp() + 3600,  // deadline
        &Bytes::from_slice(&env, b"calldata"),
    ).unwrap();

    // Claim and execute the task
    harness.claim_task(&keeper(), task_id).unwrap();
    let proof = Bytes::from_slice(&env, b"valid_proof");
    harness.execute_task(&keeper(), task_id, &proof).unwrap();

    // Verify the keeper was credited
    let balance = harness.keeper_balance(&keeper());
    assert!(balance > 0);
}
```

## API

### `VerifierTestHarness`

The main harness type. Create one with `VerifierTestHarness::new()`.

#### Methods

- `env()` — Get the Soroban test environment (use to deploy your verifier contract)
- `register_task_with_verifier(owner, verifier, reward, deadline, calldata)` — Register a task
- `claim_task(keeper, task_id)` — Claim a task
- `execute_task(keeper, task_id, proof)` — Execute a claimed task
- `get_task(task_id)` — Retrieve the current task state
- `keeper_balance(keeper)` — Get the keeper's credited balance
- `fees_accrued()` — Get the registry's accumulated fees
- `reward_token_address()` — Get the reward token address
- `registry_address()` — Get the registry contract address

### Helper Functions

- `owner()` — Get a deterministic owner (funder) address
- `keeper()` — Get a deterministic keeper (claimer/executor) address
- `admin()` — Get a deterministic admin address
- `assert_escrow_released(harness, task_id)` — Assert a task's escrow was released
- `assert_no_escrow_movement(harness, balance_before, fees_before)` — Assert state was unchanged

## See Also

- [Integration Guide](../../docs/VERIFIERS.md) — For verifier design and usage patterns
- [Registry Contract](../keeper-registry) — The contract being tested against
