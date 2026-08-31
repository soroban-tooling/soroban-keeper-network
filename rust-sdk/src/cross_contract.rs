//! Transaction and invocation builder for contract-to-contract calls (issue #337).
//!
//! When calling the keeper registry from inside another contract's logic,
//! there is no transaction to sign; execution is already inside a host invocation.
//! [`KeeperRegistryCrossContract`] constructs typed [`CrossContractInvocation`]s
//! that can be passed directly to `env.invoke_contract`.

use keeper_registry::types::TaskType;
use soroban_sdk::{vec, Address, Bytes, Env, FromVal, IntoVal, Symbol, Val, Vec};

/// Represents an un-executed cross-contract invocation.
#[derive(Clone, Debug, PartialEq)]
pub struct CrossContractInvocation<'a> {
    pub contract: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub env: &'a Env,
}

impl<'a> CrossContractInvocation<'a> {
    /// Create a new cross-contract invocation descriptor.
    pub fn new(env: &'a Env, contract: Address, function_name: &str, args: Vec<Val>) -> Self {
        Self {
            contract,
            function: Symbol::new(env, function_name),
            args,
            env,
        }
    }

    /// Execute this invocation via the Soroban host environment.
    pub fn invoke<T: FromVal<Env, Val>>(&self) -> T {
        self.env
            .invoke_contract(&self.contract, &self.function, self.args.clone())
    }
}

/// Typed cross-contract call builder for the Keeper Registry.
pub struct KeeperRegistryCrossContract<'a> {
    pub env: &'a Env,
    pub contract: Address,
}

impl<'a> KeeperRegistryCrossContract<'a> {
    /// Create a new builder targeting `contract` on `env`.
    pub fn new(env: &'a Env, contract: Address) -> Self {
        Self { env, contract }
    }

    /// Build invocation for `register_task`.
    #[allow(clippy::too_many_arguments)]
    pub fn register_task(
        &self,
        owner: &Address,
        task_type: &TaskType,
        calldata: &Bytes,
        reward: i128,
        deadline: u64,
        ttl_ledgers: u32,
        lock_ledgers: u32,
    ) -> CrossContractInvocation<'a> {
        let args = vec![
            self.env,
            owner.into_val(self.env),
            task_type.into_val(self.env),
            calldata.into_val(self.env),
            reward.into_val(self.env),
            deadline.into_val(self.env),
            ttl_ledgers.into_val(self.env),
            lock_ledgers.into_val(self.env),
        ];
        CrossContractInvocation::new(self.env, self.contract.clone(), "register_task", args)
    }

    /// Build invocation for `increase_reward`.
    pub fn increase_reward(
        &self,
        owner: &Address,
        task_id: u64,
        additional: i128,
    ) -> CrossContractInvocation<'a> {
        let args = vec![
            self.env,
            owner.into_val(self.env),
            task_id.into_val(self.env),
            additional.into_val(self.env),
        ];
        CrossContractInvocation::new(self.env, self.contract.clone(), "increase_reward", args)
    }

    /// Build invocation for `extend_deadline`.
    pub fn extend_deadline(
        &self,
        owner: &Address,
        task_id: u64,
        new_deadline: u64,
    ) -> CrossContractInvocation<'a> {
        let args = vec![
            self.env,
            owner.into_val(self.env),
            task_id.into_val(self.env),
            new_deadline.into_val(self.env),
        ];
        CrossContractInvocation::new(self.env, self.contract.clone(), "extend_deadline", args)
    }

    /// Build invocation for `claim_task`.
    pub fn claim_task(&self, keeper: &Address, task_id: u64) -> CrossContractInvocation<'a> {
        let args = vec![
            self.env,
            keeper.into_val(self.env),
            task_id.into_val(self.env),
        ];
        CrossContractInvocation::new(self.env, self.contract.clone(), "claim_task", args)
    }

    /// Build invocation for `execute_task`.
    pub fn execute_task(
        &self,
        keeper: &Address,
        task_id: u64,
        proof: &Bytes,
    ) -> CrossContractInvocation<'a> {
        let args = vec![
            self.env,
            keeper.into_val(self.env),
            task_id.into_val(self.env),
            proof.into_val(self.env),
        ];
        CrossContractInvocation::new(self.env, self.contract.clone(), "execute_task", args)
    }

    /// Build invocation for `cancel_task`.
    pub fn cancel_task(&self, owner: &Address, task_id: u64) -> CrossContractInvocation<'a> {
        let args = vec![
            self.env,
            owner.into_val(self.env),
            task_id.into_val(self.env),
        ];
        CrossContractInvocation::new(self.env, self.contract.clone(), "cancel_task", args)
    }

    /// Build invocation for `expire_task`.
    pub fn expire_task(&self, task_id: u64) -> CrossContractInvocation<'a> {
        let args = vec![self.env, task_id.into_val(self.env)];
        CrossContractInvocation::new(self.env, self.contract.clone(), "expire_task", args)
    }

    /// Build invocation for `withdraw_rewards`.
    pub fn withdraw_rewards(&self, keeper: &Address) -> CrossContractInvocation<'a> {
        let args = vec![self.env, keeper.into_val(self.env)];
        CrossContractInvocation::new(self.env, self.contract.clone(), "withdraw_rewards", args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keeper_registry::KeeperRegistryClient;
    use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, IntoVal, Symbol, Val};

    #[test]
    fn test_register_task_arguments_encoding_matches_client() {
        let env = Env::default();
        let registry_id = Address::generate(&env);
        let owner = Address::generate(&env);
        let task_type = TaskType::Liquidation;
        let calldata = Bytes::from_slice(&env, &[1, 2, 3]);
        let reward = 1_000i128;
        let deadline = 10_000u64;
        let ttl_ledgers = 50_000u32;
        let lock_ledgers = 100u32;

        let builder = KeeperRegistryCrossContract::new(&env, registry_id.clone());
        let invocation = builder.register_task(
            &owner,
            &task_type,
            &calldata,
            reward,
            deadline,
            ttl_ledgers,
            lock_ledgers,
        );

        assert_eq!(invocation.contract, registry_id);
        assert_eq!(invocation.function, Symbol::new(&env, "register_task"));

        let expected_args: Vec<Val> = (
            owner,
            task_type,
            calldata,
            reward,
            deadline,
            ttl_ledgers,
            lock_ledgers,
        )
            .into_val(&env);

        assert_eq!(invocation.args.len(), expected_args.len());
        for i in 0..invocation.args.len() {
            assert_eq!(invocation.args.get(i), expected_args.get(i));
        }
    }

    #[test]
    fn test_claim_and_execute_task_encodings() {
        let env = Env::default();
        let registry_id = Address::generate(&env);
        let keeper = Address::generate(&env);
        let task_id = 7u64;
        let proof = Bytes::from_slice(&env, &[0xaa, 0xbb]);

        let builder = KeeperRegistryCrossContract::new(&env, registry_id.clone());

        let claim_inv = builder.claim_task(&keeper, task_id);
        let expected_claim_args: Vec<Val> = (keeper.clone(), task_id).into_val(&env);
        assert_eq!(claim_inv.function, Symbol::new(&env, "claim_task"));
        assert_eq!(claim_inv.args, expected_claim_args);

        let exec_inv = builder.execute_task(&keeper, task_id, &proof);
        let expected_exec_args: Vec<Val> = (keeper, task_id, proof).into_val(&env);
        assert_eq!(exec_inv.function, Symbol::new(&env, "execute_task"));
        assert_eq!(exec_inv.args, expected_exec_args);
    }
}
