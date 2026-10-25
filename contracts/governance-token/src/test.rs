#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Env};

#[allow(dead_code)]
struct Setup {
    env: Env,
    admin: Address,
    early_keepers: Address,
    treasury: Address,
    core_team: Address,
    public_distribution: Address,
    client: GovernanceTokenClient<'static>,
}

#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let early_keepers = Address::generate(&env);
    let treasury = Address::generate(&env);
    let core_team = Address::generate(&env);
    let public_distribution = Address::generate(&env);

    let contract_id = env.register(GovernanceToken, ());
    let client = GovernanceTokenClient::new(&env, &contract_id);

    client.initialize(
        &admin,
        &early_keepers,
        &treasury,
        &core_team,
        &public_distribution,
    );

    Setup {
        env: unsafe { core::mem::transmute(env) },
        admin,
        early_keepers,
        treasury,
        core_team,
        public_distribution,
        client: unsafe { core::mem::transmute(client) },
    }
}

#[test]
fn test_initial_distribution_matches_specification_exactly() {
    let Setup {
        client,
        early_keepers,
        treasury,
        core_team,
        public_distribution,
        ..
    } = setup();

    // 1. Early Keepers / Community: 40% (40,000,000 KPRS)
    assert_eq!(
        client.balance(&early_keepers),
        400_000_000_000_000i128,
        "Early keepers allocation must be exactly 40M KPRS"
    );

    // 2. Protocol DAO Treasury: 25% (25,000,000 KPRS)
    assert_eq!(
        client.balance(&treasury),
        250_000_000_000_000i128,
        "Treasury allocation must be exactly 25M KPRS"
    );

    // 3. Core Team: 20% (20,000,000 KPRS)
    assert_eq!(
        client.balance(&core_team),
        200_000_000_000_000i128,
        "Core team allocation must be exactly 20M KPRS"
    );

    // 4. Public / Liquidity: 15% (15,000,000 KPRS)
    assert_eq!(
        client.balance(&public_distribution),
        150_000_000_000_000i128,
        "Public allocation must be exactly 15M KPRS"
    );

    // 5. Total Sum equals 100M KPRS
    let total = client.balance(&early_keepers)
        + client.balance(&treasury)
        + client.balance(&core_team)
        + client.balance(&public_distribution);
    assert_eq!(
        total, 1_000_000_000_000_000i128,
        "Total initial supply must equal 100,000,000 KPRS"
    );
}

#[test]
fn test_standard_soroban_token_metadata() {
    let Setup { client, env, .. } = setup();

    assert_eq!(client.decimals(), 7);
    assert_eq!(client.symbol(), String::from_str(&env, "KPRS"));
    assert_eq!(
        client.name(),
        String::from_str(&env, "Keeper Network Governance Token")
    );
}

#[test]
fn test_standard_transfers_and_allowances() {
    let Setup {
        client,
        env,
        public_distribution,
        ..
    } = setup();

    let recipient = Address::generate(&env);
    let spender = Address::generate(&env);

    // Standard transfer from liquid allocation
    let amount = 1_000_000 * ONE_TOKEN;
    client.transfer(&public_distribution, &recipient, &amount);
    assert_eq!(client.balance(&recipient), amount);
    assert_eq!(
        client.balance(&public_distribution),
        ALLOC_PUBLIC - amount
    );

    // Approve and transfer_from
    let expiration = env.ledger().sequence() + 100;
    client.approve(&recipient, &spender, &amount, &expiration);
    assert_eq!(client.allowance(&recipient, &spender), amount);

    let third_party = Address::generate(&env);
    client.transfer_from(&spender, &recipient, &third_party, &amount);
    assert_eq!(client.balance(&third_party), amount);
    assert_eq!(client.balance(&recipient), 0);
    assert_eq!(client.allowance(&recipient, &spender), 0);
}

#[test]
fn test_on_chain_vesting_enforces_cliff_and_linear_schedule() {
    let Setup {
        client,
        env,
        core_team,
        ..
    } = setup();

    let recipient = Address::generate(&env);
    let start_timestamp = env.ledger().timestamp();

    // ── Phase 1: Day 0 (before 6-month cliff) ──
    assert_eq!(client.balance(&core_team), ALLOC_CORE_TEAM);
    assert_eq!(client.vested_balance(&core_team), 0);
    assert_eq!(client.unvested_balance(&core_team), ALLOC_CORE_TEAM);
    assert_eq!(client.spendable_balance(&core_team), 0);

    // Any transfer attempt of unvested tokens MUST be rejected
    let res = client.try_transfer(&core_team, &recipient, &ONE_TOKEN);
    assert_eq!(res, Err(Ok(TokenError::TokensLocked)));

    // ── Phase 2: Day 100 (still before 180-day cliff) ──
    env.ledger().set_timestamp(start_timestamp + (100 * 24 * 60 * 60));
    assert_eq!(client.spendable_balance(&core_team), 0);
    let res = client.try_transfer(&core_team, &recipient, &ONE_TOKEN);
    assert_eq!(res, Err(Ok(TokenError::TokensLocked)));

    // ── Phase 3: Day 182 (cliff elapsed, ~25% vested) ──
    let elapsed = 182.5 * 24.0 * 60.0 * 60.0;
    env.ledger().set_timestamp(start_timestamp + (elapsed as u64));

    let vested = client.vested_balance(&core_team);
    assert!(
        vested > 4_000_000 * ONE_TOKEN && vested < 6_000_000 * ONE_TOKEN,
        "After cliff (quarter way into 2 yrs), approximately 25% should be vested"
    );
    let spendable = client.spendable_balance(&core_team);
    assert_eq!(spendable, vested);

    // Transferring up to spendable balance succeeds
    let transfer_amount = 1_000_000 * ONE_TOKEN;
    assert!(transfer_amount <= spendable);
    client.transfer(&core_team, &recipient, &transfer_amount);
    assert_eq!(client.balance(&recipient), transfer_amount);

    // Attempting to transfer more than remaining spendable balance fails
    let excessive = client.spendable_balance(&core_team) + 1;
    let res = client.try_transfer(&core_team, &recipient, &excessive);
    assert_eq!(res, Err(Ok(TokenError::TokensLocked)));

    // ── Phase 4: Day 735 (full 2-year vesting duration passed) ──
    env.ledger().set_timestamp(start_timestamp + (735 * 24 * 60 * 60));
    assert_eq!(client.unvested_balance(&core_team), 0);
    let remaining = client.balance(&core_team);
    assert_eq!(client.spendable_balance(&core_team), remaining);

    // All remaining tokens can now be freely transferred
    client.transfer(&core_team, &recipient, &remaining);
    assert_eq!(client.balance(&core_team), 0);
    assert_eq!(client.balance(&recipient), ALLOC_CORE_TEAM);
}