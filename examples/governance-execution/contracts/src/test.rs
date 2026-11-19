#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    symbol_short, Address, Env,
};

#[test]
fn test_governance_timelock_execution() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(GovernanceExecutionContract, ());
    let client = GovernanceExecutionContractClient::new(&env, &contract_id);

    let target = Address::generate(&env);
    let keeper = Address::generate(&env);

    let start_time = 1_000_000u64;
    let timelock_eta = start_time + 86400u64; // 24-hour timelock

    env.ledger().set_timestamp(start_time);

    client.queue_proposal(&1, &timelock_eta, &target, &symbol_short!("param_up"));

    // 1. CRITERION 2: Execution before the timelock MUST fail on-chain!
    // Try executing 1 hour before ETA:
    env.ledger().set_timestamp(timelock_eta - 3600);
    let res_early = client.try_execute_proposal(&1, &keeper);
    assert_eq!(
        res_early.unwrap_err().unwrap(),
        GovernanceError::TimelockNotElapsed
    );

    // Try executing 1 second before ETA:
    env.ledger().set_timestamp(timelock_eta - 1);
    let res_1s_early = client.try_execute_proposal(&1, &keeper);
    assert_eq!(
        res_1s_early.unwrap_err().unwrap(),
        GovernanceError::TimelockNotElapsed
    );

    // 2. Execution at or after timelock succeeds!
    env.ledger().set_timestamp(timelock_eta);
    client.execute_proposal(&1, &keeper);

    let prop = client.get_proposal(&1);
    assert_eq!(prop.status, ProposalStatus::Executed);
    assert_eq!(prop.executed_by, Some(keeper));
}
