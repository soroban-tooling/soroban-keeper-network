//! Minimal example contract calling into the Keeper Registry directly (issue #337).
//!
//! Demonstrates how an external contract can register a task on behalf of its caller
//! using `KeeperRegistryCrossContract` without requiring local signing keys or RPC servers.

#![no_std]

use keeper_registry::types::TaskType;
use keeper_registry::KeeperError;
use soroban_keeper_sdk::KeeperRegistryCrossContract;
use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

#[contract]
pub struct CallingContract;

#[contractimpl]
impl CallingContract {
    /// Register a task on behalf of caller by performing a cross-contract call to the keeper registry.
    pub fn register_on_behalf_of(
        env: Env,
        registry: Address,
        owner: Address,
        task_type: TaskType,
        calldata: Bytes,
        reward: i128,
        deadline: u64,
        ttl_ledgers: u32,
        lock_ledgers: u32,
    ) -> Result<u64, KeeperError> {
        owner.require_auth();

        let registry_sdk = KeeperRegistryCrossContract::new(&env, registry);
        let invocation = registry_sdk.register_task(
            &owner,
            &task_type,
            &calldata,
            reward,
            deadline,
            ttl_ledgers,
            lock_ledgers,
        );

        invocation.invoke()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_invocation_builder_compiles_and_formats() {
        let env = Env::default();
        let registry = Address::generate(&env);
        let owner = Address::generate(&env);
        let sdk = KeeperRegistryCrossContract::new(&env, registry.clone());

        let inv = sdk.register_task(
            &owner,
            &TaskType::Liquidation,
            &Bytes::from_slice(&env, &[1, 2]),
            100,
            1_000,
            10_000,
            100,
        );

        assert_eq!(inv.contract, registry);
    }
}
