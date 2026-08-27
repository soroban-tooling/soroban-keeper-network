//! `split_reward` arithmetic, the version constant, and `initialize`.

use soroban_sdk::{testutils::Address as _, Address, Env};

use super::common::*;
use crate::{split_reward, KeeperError, KeeperRegistry, KeeperRegistryClient};

// ─────────────────────────────────────────────────────────────────────────────
// Pure-function invariants: split_reward
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_split_reward_invariants() {
    // Exhaustively sweep a grid of rewards and fee rates and assert the core
    // accounting invariants hold for every combination — no value is ever
    // created or destroyed by the split.
    let rewards = [
        1i128,
        2,
        7,
        100,
        999,
        1_000_000,
        7_777_777,
        i128::from(u64::MAX),
    ];
    let fee_rates = [0u32, 1, 3, 250, 300, 1_000, 5_000, 9_999, 10_000];

    for &reward in &rewards {
        for &bps in &fee_rates {
            let (keeper_net, fee) = split_reward(reward, bps).expect("split should succeed");

            // 1. Conservation: nothing leaks.
            assert_eq!(keeper_net + fee, reward, "reward={reward} bps={bps}");
            // 2. Non-negative shares.
            assert!(keeper_net >= 0 && fee >= 0, "reward={reward} bps={bps}");
            // 3. Fee never exceeds the reward.
            assert!(fee <= reward, "reward={reward} bps={bps}");
            // 4. Fee matches the basis-point formula (floor division).
            assert_eq!(
                fee,
                reward * bps as i128 / 10_000,
                "reward={reward} bps={bps}"
            );
        }
    }
}

/// The sweep above proves the sum invariant holds everywhere, but it does not
/// pin the *direction* of the rounding or the point at which the fee stops
/// being collected at all. These tests do, so that the guarantee documented on
/// `split_reward` — fee is `floor(reward * fee_bps / 10_000)`, keeper takes the
/// remainder, protocol never collects more than the nominal rate — fails
/// loudly here if anyone changes the arithmetic.
///
/// Every case asserts the sum invariant `keeper_net + fee == reward` alongside
/// its specific values, so a change that fixed the specific numbers by
/// breaking conservation could not slip through.
#[test]
fn test_split_reward_rounds_down_to_the_keeper_at_the_dust_boundary() {
    const DEFAULT_BPS: u32 = 300; // 3%, the rate `setup()` initializes with

    // (reward, expected_fee, expected_keeper_net) at 300 bps. The fee is zero
    // below 34 stroops: 33 * 300 / 10_000 == 0.99 → 0.
    let cases = [
        (1i128, 0i128, 1i128),
        (33, 0, 33),  // last reward that pays no fee at all
        (34, 1, 33),  // first reward that pays a non-zero fee
        (100, 3, 97), // the rate is exact here — 3% of 100
        (10_000_000, 300_000, 9_700_000),
    ];

    for (reward, expected_fee, expected_net) in cases {
        let (net, fee) = split_reward(reward, DEFAULT_BPS).expect("split should succeed");
        assert_eq!(fee, expected_fee, "fee for reward={reward}");
        assert_eq!(net, expected_net, "keeper_net for reward={reward}");
        assert_eq!(net + fee, reward, "conservation for reward={reward}");
        // The protocol never takes more than the nominal rate: the exact
        // (unrounded) fee is fee_bps/10_000 of the reward, and integer
        // division can only have discarded a remainder.
        assert!(
            fee * 10_000 <= reward * DEFAULT_BPS as i128,
            "fee exceeded the nominal rate for reward={reward}"
        );
    }
}

#[test]
fn test_split_reward_dust_threshold_matches_the_documented_formula() {
    // The documented threshold is `reward >= ceil(10_000 / fee_bps)`. Confirm
    // it holds — rather than only at 300 bps — by checking that the fee is
    // zero at one stroop below the threshold and non-zero at it, for a spread
    // of rates. This is the formula the README tells operators to use when
    // choosing `min_reward`, so it is worth pinning against the real
    // arithmetic instead of trusting the algebra.
    for bps in [1u32, 3, 250, 300, 1_000, 5_000, 9_999] {
        let threshold = (10_000 + bps as i128 - 1) / bps as i128; // ceil division

        let (net_below, fee_below) =
            split_reward(threshold - 1, bps).expect("split should succeed");
        assert_eq!(fee_below, 0, "expected no fee below threshold at bps={bps}");
        assert_eq!(net_below, threshold - 1, "keeper takes it all at bps={bps}");
        assert_eq!(
            net_below + fee_below,
            threshold - 1,
            "conservation bps={bps}"
        );

        let (net_at, fee_at) = split_reward(threshold, bps).expect("split should succeed");
        assert!(
            fee_at >= 1,
            "expected a non-zero fee at threshold at bps={bps}"
        );
        assert_eq!(net_at + fee_at, threshold, "conservation at bps={bps}");
    }
}

#[test]
fn test_split_reward_zero_fee_rate_gives_the_keeper_everything() {
    // `DEFAULT_FEE_BPS` is 0, so this is also the behaviour of a registry
    // whose `FeeBps` has never been written.
    for reward in [1i128, 33, 34, 1_000_000, i128::from(u64::MAX)] {
        let (net, fee) = split_reward(reward, 0).expect("split should succeed");
        assert_eq!(fee, 0, "reward={reward}");
        assert_eq!(net, reward, "reward={reward}");
        assert_eq!(net + fee, reward, "conservation for reward={reward}");
    }
}

#[test]
fn test_split_reward_full_fee_rate_leaves_the_keeper_nothing() {
    // 10_000 bps == 100%. `set_fee_bps` accepts it (the bound is
    // `> 10_000` → `InvalidFeeBps`), so this is a legal admin setting and the
    // one case where a keeper executes a task for no reward at all. Asserted
    // deliberately rather than left implicit: if this is ever considered
    // undesirable it is a policy change in `set_fee_bps`, not here.
    for reward in [1i128, 34, 1_000_000] {
        let (net, fee) = split_reward(reward, 10_000).expect("split should succeed");
        assert_eq!(fee, reward, "reward={reward}");
        assert_eq!(net, 0, "reward={reward}");
        assert_eq!(net + fee, reward, "conservation for reward={reward}");
    }
}

/// `VERSION` is the only signal an off-chain client has that the ABI it
/// compiled against is the ABI it is talking to, so this assertion is
/// deliberately a hardcoded literal rather than a comparison against the
/// `VERSION` constant — the point is that changing the constant without
/// noticing the ABI change is what breaks integrators. Bump both together,
/// and add a CHANGELOG entry saying what changed.
#[test]
fn test_version_is_exposed() {
    let s = setup();
    assert_eq!(s.registry.version(), 4u32);
}

#[test]
fn test_initialize_sets_state() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    registry.initialize(&admin, &token_id, &300u32);

    assert_eq!(registry.admin(), Some(admin));
    assert_eq!(registry.get_fee_bps(), 300u32);
    assert!(!registry.is_paused());
    assert_eq!(registry.reward_token_address(), Some(token_id));
    assert_eq!(registry.task_count(), 0u64);
}

#[test]
fn test_initialize_twice_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    registry.initialize(&admin, &token_id, &300u32);
    assert_eq!(
        registry.try_initialize(&admin, &token_id, &300u32),
        Err(Ok(KeeperError::AlreadyInitialized))
    );
}

#[test]
fn test_initialize_fee_over_10000_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    assert_eq!(
        registry.try_initialize(&admin, &token_id, &10_001u32),
        Err(Ok(KeeperError::InvalidFeeBps))
    );
}
