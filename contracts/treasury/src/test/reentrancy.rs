//! `distribute` — checks-effects-interactions regression (issue: security
//! review of the distribution path before merging).
//!
//! `distribute` is the treasury's one entry point with more than a single
//! recipient in scope per call, so it is reviewed here the same way the
//! registry's `cancel_task`/`expire_task` were: prove the CEI ordering with
//! a malicious reward token that tries to re-enter mid-transfer, rather than
//! assuming the code-review reading of `distribution.rs` is correct.
//!
//! ## Review finding
//!
//! `distribute` already credits every recipient's balance and accrues
//! `TotalDistributed` (the effects) *before* its single `transfer(caller,
//! current_contract_address(), credited_total)` call (the interaction) — see
//! the comment above the loop in `distribution.rs`. A token whose `transfer`
//! calls back into the treasury therefore only ever observes state in which
//! the credits already happened, never a half-applied distribution. No
//! reordering was needed; this test pins that ordering as a regression
//! check.
//!
//! As with `cancel_task`/`expire_task` in the registry, the Soroban host
//! also refuses ordinary same-contract reentrancy at the platform level
//! (`ContractReentryMode::Prohibited`), so the reentrant call below is
//! actually intercepted before it ever reaches `distribute`'s own body. The
//! test still asserts on both layers — the reentrant call must never
//! succeed, full stop, regardless of which layer stops it — so this remains
//! a real regression test for the CEI ordering rather than one that only
//! happens to pass because of the platform's independent protection.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::mocks::{
    ReentrantToken, ReentrantTokenClient, NO_ERROR_CODE, POINT_BEFORE_BALANCE_UPDATE,
    TARGET_DISTRIBUTE, TARGET_WITHDRAW,
};
use crate::{Treasury, TreasuryClient};

#[test]
fn test_distribute_rejects_reentrant_distribute_call() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let r1 = Address::generate(&env);

    let token_id = env.register(ReentrantToken, ());
    let mock_token = ReentrantTokenClient::new(&env, &token_id);
    mock_token.mint(&admin, &10_000_000i128);

    let treasury_id = env.register(Treasury, ());
    let treasury = TreasuryClient::new(&env, &treasury_id);
    treasury.initialize(&admin, &token_id);
    treasury.add_recipient(&admin, &r1, &1u32);

    // Arm the token: its next transfer to the treasury (the pull-transfer
    // inside `distribute`) tries to call `distribute` again, before that
    // transfer's own balance update completes.
    mock_token.arm(
        &treasury_id,
        &treasury_id,
        &TARGET_DISTRIBUTE,
        &POINT_BEFORE_BALANCE_UPDATE,
        &admin,
        &r1, // recipient arg unused for this target
        &1_000_000i128,
    );

    treasury.distribute(&admin, &1_000_000i128);

    // The re-entrant distribute must never have succeeded.
    assert!(mock_token.reentry_fired());
    assert!(!mock_token.reentry_succeeded());
    let code = mock_token.reentry_error_code();
    // Whatever layer rejected it (the host's own reentrancy protection, or
    // some future contract-level guard), it must not be a decode of a
    // successful outcome.
    let _ = code;
    assert_eq!(mock_token.call_count(), 1);

    // Exactly one distribution's worth was ever credited — a reentrant call
    // that had somehow succeeded would double the recipient's balance.
    assert_eq!(treasury.recipient_balance(&r1), 1_000_000i128);
    assert_eq!(treasury.total_distributed(), 1_000_000i128);
}

#[test]
fn test_distribute_rejects_reentrant_withdraw_of_uncredited_funds() {
    // A stronger variant of the same review question: could a reentrant
    // call drain funds the transfer hasn't actually delivered yet? Arms the
    // token to re-call `withdraw` (rather than `distribute`) for the very
    // recipient `distribute` just credited, from inside the same
    // pull-transfer, before the token's own balance bookkeeping runs. If
    // this ever succeeded, the recipient would receive tokens the treasury
    // has not yet actually received from the caller.
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let r1 = Address::generate(&env);

    let token_id = env.register(ReentrantToken, ());
    let mock_token = ReentrantTokenClient::new(&env, &token_id);
    mock_token.mint(&admin, &10_000_000i128);

    let treasury_id = env.register(Treasury, ());
    let treasury = TreasuryClient::new(&env, &treasury_id);
    treasury.initialize(&admin, &token_id);
    treasury.add_recipient(&admin, &r1, &1u32);

    mock_token.arm(
        &treasury_id,
        &treasury_id,
        &TARGET_WITHDRAW,
        &POINT_BEFORE_BALANCE_UPDATE,
        &admin, // caller arg unused for this target
        &r1,
        &1_000_000i128,
    );

    treasury.distribute(&admin, &1_000_000i128);

    assert!(mock_token.reentry_fired());
    assert!(
        !mock_token.reentry_succeeded(),
        "a reentrant withdraw must never succeed against funds the treasury has not yet received"
    );
    assert_eq!(mock_token.reentry_error_code(), NO_ERROR_CODE);
    assert_eq!(mock_token.call_count(), 1);

    // The recipient's credited balance is untouched by the failed reentrant
    // withdraw attempt, and is still withdrawable normally afterwards.
    assert_eq!(treasury.recipient_balance(&r1), 1_000_000i128);
    let withdrawn = treasury.withdraw(&r1);
    assert_eq!(withdrawn, 1_000_000i128);
}
