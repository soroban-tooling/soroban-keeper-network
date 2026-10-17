//! Fuzz target for `claim_task` against tasks that carry an attached verifier
//! ("condition contract") whose outcome is fully adversarial.
//!
//! ## What this exercises
//!
//! The registry's `execute_task` path calls an optional `IKeeperVerifier` before
//! crediting a keeper.  A verifier can return `true`, `false`, or panic —
//! and a real network verifier might exhaust its Soroban resource budget,
//! which the host surfaces as a panic from the `try_verify` call.
//!
//! This target covers all four outcome classes on every run:
//!
//! | `ConditionOutcome` variant | What the mock verifier does | Expected registry behaviour |
//! |---|---|---|
//! | `AlwaysTrue`   | returns `true`  | `execute_task` succeeds; reward is split correctly |
//! | `AlwaysFalse`  | returns `false` | `execute_task` returns `VerificationFailed`; task stays `Claimed` |
//! | `AlwaysPanic`  | panics          | `execute_task` returns `VerificationFailed`; task stays `Claimed` |
//! | `BudgetExhaustion` | burns the compute budget via metered host calls (or panics as a fallback) | `VerificationFailed` (or a host error if `execute_task` itself ran out of budget); in both, task stays `Claimed` and no balance moves |
//!
//! ## Invariants asserted on every rejection
//!
//! 1. Task status remains `Claimed` (no state mutation).
//! 2. Task `reward` field is unchanged.
//! 3. `keeper_balance` of the claimer is still 0 (no partial credit).
//! 4. `fees_accrued` is unchanged (no partial fee).
//! 5. `token_balance` of the registry is unchanged (full escrow still held).
//!
//! On a successful execution (`AlwaysTrue`), the same I-1 solvency and I-4
//! fee-bounding checks used by `execute_task.rs` are applied via the shared
//! `keeper_registry::invariants` module.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::invariants::{assert_fee_bounded, assert_solvent};
use keeper_registry::{split_reward, KeeperError, KeeperRegistryClient, TaskType};
use keeper_registry_fuzz::support::RegistryHarness;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{token, Address, Bytes};

// ─────────────────────────────────────────────────────────────────────────────
// Condition outcome selector
// ─────────────────────────────────────────────────────────────────────────────

/// Which behaviour the condition mock will exhibit for this fuzzing run.
#[derive(Arbitrary, Debug, Clone, Copy, PartialEq, Eq)]
enum ConditionOutcome {
    /// Verifier always approves — `execute_task` should succeed.
    AlwaysTrue,
    /// Verifier always rejects — `execute_task` should return `VerificationFailed`.
    AlwaysFalse,
    /// Verifier panics — `execute_task` must catch it and return `VerificationFailed`.
    AlwaysPanic,
    /// Verifier exhausts its compute budget via a tight loop (budget exhaustion
    /// is the realistic analogue of a panic from the host's perspective, so the
    /// registry must handle it identically to `AlwaysPanic`).
    BudgetExhaustion,
}

impl ConditionOutcome {
    fn from_selector(selector: u8) -> Self {
        match selector % 4 {
            0 => ConditionOutcome::AlwaysTrue,
            1 => ConditionOutcome::AlwaysFalse,
            2 => ConditionOutcome::AlwaysPanic,
            _ => ConditionOutcome::BudgetExhaustion,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock verifier ("condition") contracts
//
// Each verifier lives in its own submodule, mirroring the pattern in
// `contracts/keeper-registry/src/test/verifier.rs` (three minimal test-only
// verifier contracts). We extend that set with a fourth — a budget-exhausting
// verifier — so this target covers the full outcome space the issue names:
// `true`, `false`, `panic`, and budget exhaustion. Each contract is registered
// separately so we can point `register_task`'s `verifier` field at whichever
// variant the fuzzer picks.
// ─────────────────────────────────────────────────────────────────────────────

/// Returns `true` unconditionally — represents a passing condition.
mod always_true_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct AlwaysTrueVerifier;

    #[contractimpl]
    impl AlwaysTrueVerifier {
        pub fn verify(_env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            true
        }
    }
}

/// Returns `false` unconditionally — represents a failing condition.
mod always_false_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct AlwaysFalseVerifier;

    #[contractimpl]
    impl AlwaysFalseVerifier {
        pub fn verify(_env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            false
        }
    }
}

/// Panics unconditionally — the registry must catch this and treat it as a
/// rejection (`VerificationFailed`), not let it abort the transaction.
mod always_panic_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct AlwaysPanicVerifier;

    #[contractimpl]
    impl AlwaysPanicVerifier {
        pub fn verify(_env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            panic!("verifier panic — registry must handle this as VerificationFailed")
        }
    }
}

/// Exhausts the Soroban compute budget by issuing metered host calls in a
/// tight loop. Each `env.ledger()` import is charged against the host's
/// budget, so this burns budget the same way a genuinely expensive verifier
/// would — and when the budget is exhausted the host aborts the call, which
/// `execute_task`'s `try_verify` surfaces as a non-`Ok(Ok(true))` result and
/// maps to `VerificationFailed`, exactly like a panic.
///
/// The loop is **bounded** so the fuzzer can never hang even if budget
/// enforcement were absent in some environment, and a trailing `panic!` is a
/// deterministic fallback guaranteeing the outcome is always a rejection
/// (never an accidental approval): either the host kills us mid-loop for
/// exceeding the budget, or the loop runs to completion and we panic on
/// purpose. Both paths land on `VerificationFailed` from the registry's
/// perspective, which is the whole point — the registry must be invariant
/// regardless of *why* the verifier failed to return `Ok(Ok(true))`.
mod budget_exhaustion_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct BudgetExhaustionVerifier;

    #[contractimpl]
    impl BudgetExhaustionVerifier {
        pub fn verify(env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            for _ in 0..100_000u32 {
                // A real host import the Soroban runtime meters — cannot be
                // optimized away, and each iteration charges the budget.
                let _ = env.ledger().sequence();
            }
            panic!("budget-exhaustion verifier: budget not exhausted within bounded loop")
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz input
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Arbitrary, Debug)]
struct ConditionedClaimInput {
    /// Picks which verifier behaviour to exercise this run.
    outcome_selector: u8,
    /// Drives the escrowed reward (clamped to a positive value below).
    reward_bytes: [u8; 16],
    /// Drives the protocol fee rate (clamped to [0, 10_000]).
    fee_bps_bytes: [u8; 4],
    /// Arbitrary proof bytes the keeper submits.
    proof: Vec<u8>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz target body
// ─────────────────────────────────────────────────────────────────────────────

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);
    let Ok(input) = ConditionedClaimInput::arbitrary(&mut unstructured) else {
        return;
    };

    let outcome = ConditionOutcome::from_selector(input.outcome_selector);

    // Clamp to a positive reward within the harness's minted supply.
    let reward =
        i128::from_le_bytes(input.reward_bytes).unsigned_abs() as i128 % 1_000_000_000 + 1;
    let fee_bps = u32::from_le_bytes(input.fee_bps_bytes) % 10_001;

    // ── Environment setup ────────────────────────────────────────────────

    let harness = RegistryHarness::new();
    let env = &harness.env;
    let client = harness.client();

    // Override the default 0% fee.
    client.set_fee_bps(&harness.admin, &fee_bps);

    // Register the appropriate mock verifier contract.
    let verifier_addr: Address = match outcome {
        ConditionOutcome::AlwaysTrue => {
            env.register(always_true_verifier::AlwaysTrueVerifier, ())
        }
        ConditionOutcome::AlwaysFalse => {
            env.register(always_false_verifier::AlwaysFalseVerifier, ())
        }
        ConditionOutcome::AlwaysPanic => {
            env.register(always_panic_verifier::AlwaysPanicVerifier, ())
        }
        ConditionOutcome::BudgetExhaustion => {
            env.register(budget_exhaustion_verifier::BudgetExhaustionVerifier, ())
        }
    };

    // ── Register a conditioned task ──────────────────────────────────────

    let deadline = env.ledger().timestamp() + 1_000;
    let task_id = client.register_task(
        &harness.user,
        &TaskType::Liquidation,
        &Bytes::from_slice(env, b""),
        &reward,
        &deadline,
        &1_000u32,
        &100u32,
        &Some(verifier_addr),
    );

    // Claim the task so it is in `Claimed` state before `execute_task`.
    client.claim_task(&harness.keeper, &task_id);

    // ── Snapshot state before the attempted execution ────────────────────

    let task_before = client.get_task(&task_id);
    let keeper_balance_before = client.keeper_balance(&harness.keeper);
    let fees_before = client.fees_accrued();
    let token_client = harness.token_client();
    let registry_token_balance_before =
        token_client.balance(&harness.contract_id);

    // Build the proof bytes from the fuzzer-supplied data.
    let proof = Bytes::from_slice(env, &input.proof);

    // ── Execute ──────────────────────────────────────────────────────────

    let result = client.try_execute_task(&harness.keeper, &task_id, &proof);

    // ── Assertions ───────────────────────────────────────────────────────

    match outcome {
        // ── Successful path ──────────────────────────────────────────────
        ConditionOutcome::AlwaysTrue => {
            match result {
                Ok(Ok(())) => {
                    // The proof must have been within the size bound.
                    assert!(
                        proof.len() <= keeper_registry::MAX_PROOF_LEN,
                        "execute_task succeeded with an over-long proof ({} bytes)",
                        proof.len()
                    );

                    // I-4 — fee bounding.
                    let (expected_net, expected_fee) = split_reward(reward, fee_bps)
                        .expect("split_reward must succeed for a valid reward/fee_bps pair");
                    assert_fee_bounded(reward, fee_bps, expected_net, expected_fee)
                        .expect("I-4 fee bounding must hold after a successful execution");

                    // Keeper balance was credited correctly.
                    let keeper_balance_after = client.keeper_balance(&harness.keeper);
                    assert_eq!(
                        keeper_balance_after,
                        keeper_balance_before + expected_net,
                        "keeper_balance should increase by exactly the net reward"
                    );

                    // Fees accrued correctly.
                    let fees_after = client.fees_accrued();
                    assert_eq!(
                        fees_after,
                        fees_before + expected_fee,
                        "fees_accrued should increase by exactly the protocol fee"
                    );

                    // I-1 — solvency via the shared invariant helper.
                    let registry_token_balance_after =
                        token_client.balance(&harness.contract_id);
                    assert_solvent(
                        env,
                        &client,
                        &[task_id],
                        &[harness.keeper.clone()],
                        registry_token_balance_after,
                    )
                    .expect("I-1 solvency must hold after a successful execution");
                }
                Ok(Err(_)) => {
                    panic!(
                        "execute_task returned Ok but the value failed conversion — \
                         ABI mismatch, not a contract-logic rejection"
                    );
                }
                Err(Ok(KeeperError::ProofTooLarge)) => {
                    // The only legitimate rejection on the AlwaysTrue path is an
                    // oversized proof — assert the proof really is over the limit
                    // so we know this isn't an unexpected error masquerading as a
                    // size rejection.
                    assert!(
                        proof.len() > keeper_registry::MAX_PROOF_LEN,
                        "ProofTooLarge returned for a proof within the length limit"
                    );
                    // Confirm no state changed on this rejection path.
                    assert_state_unchanged(
                        &client,
                        task_id,
                        &task_before,
                        &harness.keeper,
                        keeper_balance_before,
                        fees_before,
                        &token_client,
                        &harness.contract_id,
                        registry_token_balance_before,
                    );
                }
                Err(Ok(other)) => {
                    panic!(
                        "execute_task with AlwaysTrue verifier returned an unexpected \
                         KeeperError: {other:?}"
                    );
                }
                Err(Err(_)) => {
                    panic!(
                        "execute_task host-errored instead of returning a typed KeeperError"
                    );
                }
            }
        }

        // ── Rejection paths ──────────────────────────────────────────────
        //
        // `AlwaysFalse` and `AlwaysPanic` reject cheaply (the verifier
        // returns `false` or panics without burning the budget), so the
        // registry always has enough budget left to emit
        // `TaskVerificationFailed` and return the typed
        // `VerificationFailed`. A host error (`Err(Err(_))`) on these paths
        // would be a genuine bug, so it is treated as a crash.
        //
        // `BudgetExhaustion` is different: the verifier deliberately burns
        // the shared call budget. `try_verify` catches the resulting host
        // error, but the registry may then lack the budget to complete its
        // own post-catch emit/return, so `execute_task` itself can surface
        // as a host error (`Err(Err(_))`). That is still a *rejection* — and
        // crucially no state is mutated, because the verifier gate runs
        // *before* any state change in `execute_task` — so the invariant
        // ("a rejected claim never changes task state or any balance") must
        // hold for both `VerificationFailed` and the host-error outcome.
        // Subsequent reads get a fresh per-call budget, so the
        // state-unchanged assertion is observable in either case.
        ConditionOutcome::AlwaysFalse | ConditionOutcome::AlwaysPanic => {
            match result {
                Ok(Ok(())) => {
                    panic!(
                        "execute_task with {:?} verifier succeeded — the verifier \
                         must cause a VerificationFailed rejection",
                        outcome
                    );
                }
                Ok(Err(_)) => {
                    panic!("execute_task returned Ok but conversion failed — ABI mismatch");
                }
                Err(Ok(KeeperError::VerificationFailed)) => {
                    assert_state_unchanged(
                        &client,
                        task_id,
                        &task_before,
                        &harness.keeper,
                        keeper_balance_before,
                        fees_before,
                        &token_client,
                        &harness.contract_id,
                        registry_token_balance_before,
                    );
                }
                Err(Ok(KeeperError::ProofTooLarge)) => {
                    assert!(
                        proof.len() > keeper_registry::MAX_PROOF_LEN,
                        "ProofTooLarge returned for a proof within the length limit"
                    );
                    assert_state_unchanged(
                        &client,
                        task_id,
                        &task_before,
                        &harness.keeper,
                        keeper_balance_before,
                        fees_before,
                        &token_client,
                        &harness.contract_id,
                        registry_token_balance_before,
                    );
                }
                Err(Ok(other)) => {
                    panic!(
                        "execute_task with {:?} verifier returned an unexpected \
                         KeeperError: {other:?}",
                        outcome
                    );
                }
                Err(Err(_)) => {
                    panic!(
                        "execute_task host-errored on the {:?} path instead of \
                         returning a typed KeeperError",
                        outcome
                    );
                }
            }
        }

        ConditionOutcome::BudgetExhaustion => {
            match result {
                Ok(Ok(())) => {
                    panic!(
                        "execute_task with a budget-exhausting verifier succeeded — \
                         the verifier must cause a rejection"
                    );
                }
                Ok(Err(_)) => {
                    panic!("execute_task returned Ok but conversion failed — ABI mismatch");
                }
                // The loop exhausted the budget and `try_verify` caught it,
                // with enough budget left for the registry to return the
                // typed error.
                Err(Ok(KeeperError::VerificationFailed)) => {
                    assert_state_unchanged(
                        &client,
                        task_id,
                        &task_before,
                        &harness.keeper,
                        keeper_balance_before,
                        fees_before,
                        &token_client,
                        &harness.contract_id,
                        registry_token_balance_before,
                    );
                }
                // The proof was over the limit, which is checked *before*
                // the verifier is even called — so the loop never ran.
                Err(Ok(KeeperError::ProofTooLarge)) => {
                    assert!(
                        proof.len() > keeper_registry::MAX_PROOF_LEN,
                        "ProofTooLarge returned for a proof within the length limit"
                    );
                    assert_state_unchanged(
                        &client,
                        task_id,
                        &task_before,
                        &harness.keeper,
                        keeper_balance_before,
                        fees_before,
                        &token_client,
                        &harness.contract_id,
                        registry_token_balance_before,
                    );
                }
                // The loop exhausted the budget so thoroughly that
                // `execute_task` itself could not complete its post-catch
                // return. Still a rejection — and no state was mutated,
                // because the verifier gate precedes every write in
                // `execute_task`.
                Err(Err(_)) => {
                    assert_state_unchanged(
                        &client,
                        task_id,
                        &task_before,
                        &harness.keeper,
                        keeper_balance_before,
                        fees_before,
                        &token_client,
                        &harness.contract_id,
                        registry_token_balance_before,
                    );
                }
                Err(Ok(other)) => {
                    panic!(
                        "execute_task with a budget-exhausting verifier returned \
                         an unexpected KeeperError: {other:?}"
                    );
                }
            }
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assert no state changed after a rejected execution
// ─────────────────────────────────────────────────────────────────────────────

/// Asserts the five state components that a rejected `execute_task` must not
/// modify: task status, task reward, keeper balance, fees accrued, and the
/// registry's token balance.
///
/// Called on every rejection path — `VerificationFailed`, `ProofTooLarge`,
/// or a host error from budget exhaustion — so the check is in one place and
/// cannot be forgotten on a new code path.
#[allow(clippy::too_many_arguments)]
fn assert_state_unchanged(
    client: &KeeperRegistryClient,
    task_id: u64,
    task_before: &keeper_registry::Task,
    keeper: &Address,
    keeper_balance_before: i128,
    fees_before: i128,
    token_client: &token::Client,
    registry_addr: &Address,
    registry_token_balance_before: i128,
) {
    let task_after = client.get_task(&task_id);

    assert_eq!(
        task_after.status, task_before.status,
        "task status must not change after a rejected execution \
         (before={:?}, after={:?})",
        task_before.status, task_after.status
    );

    assert_eq!(
        task_after.reward, task_before.reward,
        "task reward must not change after a rejected execution"
    );

    let keeper_balance_after = client.keeper_balance(keeper);
    assert_eq!(
        keeper_balance_after, keeper_balance_before,
        "keeper_balance must not change after a rejected execution \
         (before={keeper_balance_before}, after={keeper_balance_after})"
    );

    let fees_after = client.fees_accrued();
    assert_eq!(
        fees_after, fees_before,
        "fees_accrued must not change after a rejected execution \
         (before={fees_before}, after={fees_after})"
    );

    let registry_token_balance_after = token_client.balance(registry_addr);
    assert_eq!(
        registry_token_balance_after, registry_token_balance_before,
        "registry token balance must not change after a rejected execution \
         (before={registry_token_balance_before}, after={registry_token_balance_after})"
    );
}
