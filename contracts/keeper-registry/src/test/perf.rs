//! CPU-instruction regression ceilings.

use soroban_sdk::{testutils::{Address as _, Ledger as _}, Address, Bytes};

use super::common::*;

// ─────────────────────────────────────────────────────────────────────────────
// CPU-instruction regression ceilings — issue 0107. `claim_task` and
// `execute_task` are the two entry points most likely to be called under real
// load (every keeper bot calls them once per task), so a silent cost
// regression there is the one most likely to surprise a keeper's transaction
// budget in production.
//
// Measured via `env.cost_estimate().budget().cpu_instruction_cost()` (the
// same budget-tracking API issue 0100's CI job uses) at the time these tests
// were written: `claim_task` costs ~100,555 instructions, `execute_task`
// costs ~158,338. The ceilings below are set at roughly 3x each measured
// value — loose enough that an ordinary change (one extra storage read, a
// slightly bigger event) won't trip it, but tight enough to catch an
// accidental order-of-magnitude regression, such as a refactor that starts
// calling `bump_instance` twice by mistake, or a verifier integration that
// reruns the whole load/save path per call. (Confirmed these have teeth: a
// temporary ceiling of 1 during development made both fail with the exact
// measured instruction count in the message, not an opaque error.)
const CLAIM_TASK_CPU_INSN_CEILING: u64 = 350_000;
const EXECUTE_TASK_CPU_INSN_CEILING: u64 = 500_000;

#[test]
fn test_claim_task_cpu_instructions_within_ceiling() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.env.cost_estimate().budget().reset_default();
    s.registry.claim_task(&keeper, &id);
    let consumed = s.env.cost_estimate().budget().cpu_instruction_cost();

    assert!(
        consumed < CLAIM_TASK_CPU_INSN_CEILING,
        "claim_task consumed {consumed} CPU instructions, exceeding the regression \
         ceiling of {CLAIM_TASK_CPU_INSN_CEILING}"
    );
}

#[test]
fn test_execute_task_cpu_instructions_within_ceiling() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);

    s.env.cost_estimate().budget().reset_default();
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    let consumed = s.env.cost_estimate().budget().cpu_instruction_cost();

    assert!(
        consumed < EXECUTE_TASK_CPU_INSN_CEILING,
        "execute_task consumed {consumed} CPU instructions, exceeding the regression \
         ceiling of {EXECUTE_TASK_CPU_INSN_CEILING}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// E06 — Keeper Staking & Slashing (#431). Same rationale and methodology as
// the two ceilings above: measured via `cost_estimate().budget()` at the
// time these tests were written, set at roughly 3x each measured value.
// Measured baselines: stake_deposit ~227,095, initiate_unbond ~93,890,
// withdraw_stake ~264,395, slash ~273,553. Confirmed these have teeth the
// same way: temporarily setting a ceiling to 1 during development made the
// corresponding test fail with the exact measured instruction count in the
// message, not an opaque error.
const STAKE_DEPOSIT_CPU_INSN_CEILING: u64 = 700_000;
const INITIATE_UNBOND_CPU_INSN_CEILING: u64 = 300_000;
const WITHDRAW_STAKE_CPU_INSN_CEILING: u64 = 800_000;
const SLASH_CPU_INSN_CEILING: u64 = 850_000;

#[test]
fn test_stake_deposit_cpu_instructions_within_ceiling() {
    use soroban_sdk::token;
    let s = setup();
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &10_000_000i128);

    s.env.cost_estimate().budget().reset_default();
    s.registry.stake_deposit(&keeper, &500_000i128);
    let consumed = s.env.cost_estimate().budget().cpu_instruction_cost();

    assert!(
        consumed < STAKE_DEPOSIT_CPU_INSN_CEILING,
        "stake_deposit consumed {consumed} CPU instructions, exceeding the regression \
         ceiling of {STAKE_DEPOSIT_CPU_INSN_CEILING}"
    );
}

#[test]
fn test_initiate_unbond_cpu_instructions_within_ceiling() {
    use soroban_sdk::token;
    let s = setup();
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &10_000_000i128);
    s.registry.stake_deposit(&keeper, &500_000i128);

    s.env.cost_estimate().budget().reset_default();
    s.registry.initiate_unbond(&keeper, &200_000i128);
    let consumed = s.env.cost_estimate().budget().cpu_instruction_cost();

    assert!(
        consumed < INITIATE_UNBOND_CPU_INSN_CEILING,
        "initiate_unbond consumed {consumed} CPU instructions, exceeding the regression \
         ceiling of {INITIATE_UNBOND_CPU_INSN_CEILING}"
    );
}

#[test]
fn test_withdraw_stake_cpu_instructions_within_ceiling() {
    use soroban_sdk::token;
    let s = setup();
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &10_000_000i128);
    s.registry.stake_deposit(&keeper, &500_000i128);
    let release_ledger = s.registry.initiate_unbond(&keeper, &200_000i128);
    s.env.ledger().with_mut(|li| li.sequence_number = release_ledger);

    s.env.cost_estimate().budget().reset_default();
    s.registry.withdraw_stake(&keeper);
    let consumed = s.env.cost_estimate().budget().cpu_instruction_cost();

    assert!(
        consumed < WITHDRAW_STAKE_CPU_INSN_CEILING,
        "withdraw_stake consumed {consumed} CPU instructions, exceeding the regression \
         ceiling of {WITHDRAW_STAKE_CPU_INSN_CEILING}"
    );
}

#[test]
fn test_slash_cpu_instructions_within_ceiling() {
    use soroban_sdk::token;
    let s = setup();
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &10_000_000i128);
    s.registry.stake_deposit(&keeper, &500_000i128);
    let treasury = Address::generate(&s.env);

    s.env.cost_estimate().budget().reset_default();
    s.registry.slash(
        &s.admin,
        &keeper,
        &50_000i128,
        &soroban_sdk::symbol_short!("fraud"),
        &soroban_sdk::BytesN::from_array(&s.env, &[1u8; 32]),
        &treasury,
    );
    let consumed = s.env.cost_estimate().budget().cpu_instruction_cost();

    assert!(
        consumed < SLASH_CPU_INSN_CEILING,
        "slash consumed {consumed} CPU instructions, exceeding the regression \
         ceiling of {SLASH_CPU_INSN_CEILING}"
    );
}
