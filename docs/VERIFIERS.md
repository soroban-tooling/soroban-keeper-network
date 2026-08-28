# Verifier resource cost catalog (E05, issue 0113)

This document is intended to hold the table backlog issue 0113 asks for:
measured CPU/memory cost for `execute_task` with each of epic E04's three
reference verifiers attached, presented as a delta over the no-verifier
baseline, so a dApp author or keeper bot author has real numbers instead of
"it depends."

**This is a partial answer.** As of this writing, none of 0113's
prerequisites exist in this repository yet:

- The three reference verifiers (issues 0077–0079) are not implemented —
  there is no `IKeeperVerifier` implementation anywhere in `contracts/`.
  `docs/VERIFIER_DESIGN.md` (issue 0071) is the interface's design record,
  not an implementation.
- `docs/VERIFIERS.md` itself (this file, issue 0088 — the integration guide
  it was meant to also cover) has no prior content to extend.

What *does* exist as of issue 0100 landing (`.github/workflows/ci.yml`'s
`resource-cost` advisory job, `contracts/keeper-registry/src/test.rs`'s
`resource_report` test) is the measurement methodology and the no-verifier
baseline itself, which this document records below. The per-verifier deltas
this issue's acceptance criteria actually ask for cannot be produced until
0077–0079 exist to measure — filling them in now with anything but real
`Env::cost_estimate().budget()` output would not be "measured," it would be
guessed, which defeats the entire point of this catalog.

## Methodology

Numbers come from `Env::cost_estimate().budget()` (soroban-sdk's testutils
budget tracker), which resets before every top-level contract invocation
and reports the CPU instructions and memory consumed by exactly one call.
This is the same methodology issue 0100's `resource-cost` CI job uses for
every entry point, not a separate one-off measurement — see
[`docs/CI.md`](CI.md) and `scripts/report-resource-cost.sh`.

As the SDK's own documentation notes, these numbers are likely to
under-report the equivalent WASM-on-network cost (native Rust test
execution skips VM instantiation and some WASM-specific charges), so treat
them as *relative* figures — comparable to each other, run over run, on the
same methodology — rather than an exact prediction of mainnet fees.

## No-verifier baseline

The current baseline for `execute_task` (no verifier attached — this
repo's only mode today) is tracked in
[`contracts/keeper-registry/resource-baseline.json`](../contracts/keeper-registry/resource-baseline.json)
and reported on every PR by the `resource-cost` CI job. See that file for
the current numbers; they are intentionally not duplicated here in prose,
since they would immediately drift out of sync with the machine-checked
source of truth as the contract changes.

## Reference verifier deltas — blocked

| Verifier | Status |
|---|---|
| Signature verifier (issue 0077) | Not implemented. No cost measurement possible. |
| Oracle verifier (issue 0078) | Not implemented. No cost measurement possible. |
| Tx-inclusion verifier (issue 0079) | Not implemented. No cost measurement possible. |

Once any of 0077–0079 lands, extend the `resource_report` test's setup to
attach that verifier to a task before calling `execute_task`, add its
entry-point name (e.g. `execute_task_with_signature_verifier`) to the
measured set, and fill in this table with the real delta over the baseline
above. Cross-reference issue 0091's bot-side profitability logic once that
exists too, per 0113's acceptance criteria — a keeper bot deciding whether
a task is worth claiming needs exactly this delta to estimate the verifier
surcharge before committing.

## Testing Your Verifier

If you are writing your own verifier contract, you can test it end-to-end against the registry using the `keeper-registry-test-support` crate. This provides a minimal test harness that handles registry deployment and initialization, letting you focus on testing your verifier's `verify` function.

### Setup

Add to your `Cargo.toml`:

```toml
[dev-dependencies]
keeper-registry-test-support = { path = "path/to/keeper-registry/contracts/verifiers/test-support" }
soroban-sdk = { version = "22.0.1", features = ["testutils"] }
```

### Example: End-to-End Test

```rust
#[cfg(test)]
mod tests {
    use keeper_registry_test_support::{
        VerifierTestHarness, keeper, owner, TaskStatus,
    };
    use soroban_sdk::{Bytes, Address};

    // Your verifier contract
    #[contract]
    pub struct MyVerifier;

    #[contractimpl]
    impl MyVerifier {
        pub fn verify(
            _env: Env,
            _task_id: u64,
            _keeper: Address,
            proof: Bytes,
        ) -> bool {
            // Your verification logic here
            // This example approves proofs that start with "valid_"
            let proof_str = std::str::from_utf8(&proof).unwrap_or("");
            proof_str.starts_with("valid_")
        }
    }

    #[test]
    fn test_verify_approves_valid_proof() {
        let harness = VerifierTestHarness::new();
        let env = harness.env();

        // Deploy your verifier
        let verifier_id = env.register(MyVerifier, ());
        let verifier_addr = Address::from_contract_id(&env, &verifier_id);

        // Register a task with your verifier attached
        let task_id = harness
            .register_task_with_verifier(
                &owner(),
                Some(verifier_addr),
                1_000_000,  // reward in stroops
                env.ledger().timestamp() + 3600,  // deadline
                &Bytes::from_slice(&env, b"application_data"),
            )
            .unwrap();

        // Claim the task
        harness.claim_task(&keeper(), task_id).unwrap();

        // Execute with a valid proof
        let proof = Bytes::from_slice(&env, b"valid_proof_here");
        harness.execute_task(&keeper(), task_id, &proof).unwrap();

        // Verify the keeper was credited
        assert!(harness.keeper_balance(&keeper()) > 0);

        // Verify the task is now executed
        let task = harness.get_task(task_id);
        assert_eq!(task.status, TaskStatus::Executed);
    }

    #[test]
    fn test_verify_rejects_invalid_proof() {
        let harness = VerifierTestHarness::new();
        let env = harness.env();

        let verifier_id = env.register(MyVerifier, ());
        let verifier_addr = Address::from_contract_id(&env, &verifier_id);

        let task_id = harness
            .register_task_with_verifier(
                &owner(),
                Some(verifier_addr),
                1_000_000,
                env.ledger().timestamp() + 3600,
                &Bytes::from_slice(&env, b"application_data"),
            )
            .unwrap();

        harness.claim_task(&keeper(), task_id).unwrap();

        // Execute with an invalid proof (doesn't start with "valid_")
        let proof = Bytes::from_slice(&env, b"invalid_proof");
        let result = harness.execute_task(&keeper(), task_id, &proof);

        // Should be rejected
        assert!(result.is_err());

        // Keeper should NOT have been credited
        assert_eq!(harness.keeper_balance(&keeper()), 0);

        // Task should still be claimed (can retry)
        let task = harness.get_task(task_id);
        assert_eq!(task.status, TaskStatus::Claimed);
    }
}
```

### API Summary

- `VerifierTestHarness::new()` — Create a harness with a fully initialized registry
- `env()` — Get the Soroban test environment (deploy your verifier with `env.register(...)`)
- `register_task_with_verifier(owner, verifier, reward, deadline, calldata)` — Register with your verifier attached
- `claim_task(keeper, task_id)` — Claim a task
- `execute_task(keeper, task_id, proof)` — Execute with a proof (triggers your verifier)
- `get_task(task_id)` — Check task status
- `keeper_balance(keeper)` — Check if keeper was credited
- `owner()`, `keeper()` — Deterministic test addresses

See [`contracts/verifiers/test-support/README.md`](../contracts/verifiers/test-support/README.md) for full documentation.

## Cross-references

- [`docs/VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md) — the `IKeeperVerifier`
  interface and rationale (issue 0071).
- [`contracts/verifiers/test-support/`](../contracts/verifiers/test-support/) — the test harness library (issue 0195)
- [`docs/CI.md`](CI.md) — the `resource-cost` advisory job this catalog's
  methodology comes from (issue 0100).
- [`docs/BATCH_OPERATIONS.md`](BATCH_OPERATIONS.md) — flags verifier
  resource cost as a specific risk for a hypothetical batch `execute_task`
  (issue 0099 / backlog 0201), since an unpredictable per-task verifier cost
  is exactly what makes sizing a batch safely difficult.
