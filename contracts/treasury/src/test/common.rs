//! Shared fixtures for the test suite. Mirrors
//! `contracts/keeper-registry/src/test/common.rs`.

use soroban_sdk::{testutils::Address as _, token, Address, Env};

use crate::{Treasury, TreasuryClient};

pub(crate) struct TestSetup {
    pub(crate) env: Env,
    pub(crate) admin: Address,
    pub(crate) treasury: TreasuryClient<'static>,
    pub(crate) token_id: Address,
}

/// Deploys a SAC-wrapped token, mints 10M units to `funder`, and returns the
/// token's address.
pub(crate) fn deploy_token(env: &Env, funder: &Address) -> Address {
    let token_admin = Address::generate(env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    token::StellarAssetClient::new(env, &token_id).mint(funder, &10_000_000i128);
    token_id
}

/// Deploys and initializes the Treasury contract.
pub(crate) fn deploy_treasury<'a>(
    env: &'a Env,
    admin: &Address,
    token_id: &Address,
) -> TreasuryClient<'a> {
    let treasury_id = env.register(Treasury, ());
    let treasury_client = TreasuryClient::new(env, &treasury_id);
    treasury_client.initialize(admin, token_id);
    treasury_client
}

// The transmutes below intentionally re-bind the env/client to a 'static
// lifetime — the standard Soroban test-harness pattern for a shared Setup,
// mirroring `keeper-registry::test::common::setup`.
#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
pub(crate) fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = deploy_token(&env, &admin);
    let env_for_treasury = env.clone();
    let treasury = deploy_treasury(&env_for_treasury, &admin, &token_id);

    TestSetup {
        env: unsafe { core::mem::transmute(env) },
        admin,
        treasury: unsafe { core::mem::transmute(treasury) },
        token_id,
    }
}
