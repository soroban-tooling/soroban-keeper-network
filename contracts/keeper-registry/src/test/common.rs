//! Shared fixtures for the test suite.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Bytes, Env,
};

use crate::{KeeperRegistry, KeeperRegistryClient, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// Shared test setup
// ─────────────────────────────────────────────────────────────────────────────

/// `ttl_ledgers` that satisfies the contract's must-cover-deadline rule for the
/// standard 1-hour test deadline: 3_600s at 5s per ledger is 720 ledgers to the
/// deadline, plus the 17_280-ledger safety margin. Tests that deliberately
/// exercise the `TtlTooShort` rejection pass a literal instead.
/// See `required_ttl_ledgers` in `lib.rs`.
pub(crate) const DEFAULT_TTL_LEDGERS: u32 = 18_000;

pub(crate) struct TestSetup {
    pub(crate) env: Env,
    pub(crate) admin: Address,
    pub(crate) registry: KeeperRegistryClient<'static>,
    pub(crate) token_id: Address,
}

/// Deploys a SAC-wrapped token, mints 10M units to the admin, and returns the token's address.
pub(crate) fn deploy_token(env: &Env, admin: &Address) -> Address {
    let token_admin = Address::generate(env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    token::StellarAssetClient::new(env, &token_id).mint(admin, &10_000_000i128);
    token_id
}

/// Deploys and initializes the KeeperRegistry contract.
pub(crate) fn deploy_registry<'a>(
    env: &'a Env,
    admin: &Address,
    token_id: &Address,
) -> KeeperRegistryClient<'a> {
    let registry_id = env.register(KeeperRegistry, ());
    let registry_client = KeeperRegistryClient::new(env, &registry_id);
    registry_client.initialize(admin, token_id, &300u32); // Default 3% fee
    registry_client
}

// The transmutes below intentionally re-bind the env/client to a 'static
// lifetime — the standard Soroban test-harness pattern for a shared Setup.
#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
pub(crate) fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = deploy_token(&env, &admin);
    // The client is bound to the lifetime of `env_for_registry`.
    let env_for_registry = env.clone();
    let registry = deploy_registry(&env_for_registry, &admin, &token_id);

    // Leak env to get a 'static lifetime — standard soroban test pattern.
    TestSetup {
        env: unsafe { core::mem::transmute(env) },
        admin,
        registry: unsafe { core::mem::transmute(registry) }, // Now transmutes a client with a 'static lifetime.
        token_id,
    }
}

pub(crate) fn calldata(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"liquidate:position:42")
}

/// Registers a standard 1-hour task funded by `admin` and returns its id.
pub(crate) fn register_default_task(s: &TestSetup) -> u64 {
    register_reward_task(s, 1_000_000i128)
}

/// Same as `register_default_task` but with a caller-chosen reward, so tests
/// can exercise several distinct amounts (e.g. non-round fee splits) without
/// duplicating the register_task call boilerplate.
pub(crate) fn register_reward_task(s: &TestSetup, reward: i128) -> u64 {
    let deadline = s.env.ledger().timestamp() + 3_600;
    s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &reward,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &120u32,
        &None,
    )
}

/// Advances the ledger sequence and timestamp so lock-window / deadline logic
/// can be exercised deterministically.
pub(crate) fn advance(env: &Env, ledgers: u32, seconds: u64) {
    env.ledger().with_mut(|li| {
        li.sequence_number += ledgers;
        li.timestamp += seconds;
    });
}

/// Drives a full register → claim → execute cycle and returns the keeper.
pub(crate) fn executed_task_keeper(s: &TestSetup) -> Address {
    let keeper = Address::generate(&s.env);
    let id = register_default_task(s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    keeper
}

/// Registers a task with the given `lock_ledgers`, claims it as `keeper`, and
/// returns `(task_id, unlock_at)` where `unlock_at = claim_ledger + lock_ledgers`
/// — the first ledger sequence at which the lock is considered expired.
pub(crate) fn claim_with_lock(s: &TestSetup, keeper: &Address, lock_ledgers: u32) -> (u64, u32) {
    let deadline = s.env.ledger().timestamp() + 3_600;
    let id = s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000i128,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &lock_ledgers,
        &None,
    );
    s.registry.claim_task(keeper, &id);
    let claim_ledger = s.registry.get_task(&id).claim_ledger.unwrap();
    (id, claim_ledger + lock_ledgers)
}

/// Advances the ledger sequence to exactly `target` (timestamp untouched).
pub(crate) fn goto_ledger(env: &Env, target: u32) {
    let current = env.ledger().sequence();
    advance(env, target - current, 0);
}
