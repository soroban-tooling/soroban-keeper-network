//! Minimal Liquidation Keeper Bot Example in Rust (Issue #342).
//!
//! A native Rust demonstration of an automated keeper bot that polls for liquidation
//! tasks, claims them, simulates off-chain execution, submits proofs, and withdraws rewards.

use soroban_keeper_sdk::{KeeperClient, KeypairSigner, TaskStatus, TaskType};
use soroban_sdk::{Address, Bytes, Env};

fn main() {
    let env = Env::default();
    env.mock_all_auths();

    println!("Starting Minimal Rust Liquidation Keeper Bot...");

    let registry_contract = env.register(keeper_registry::KeeperRegistry, ());
    let keeper_address = Address::generate(&env);
    let signer = KeypairSigner::new(keeper_address.clone());

    let client = KeeperClient::new(&env, registry_contract.clone(), &signer);

    // 1. Scan for recent tasks using range query
    let tasks = client.get_tasks_range(1, 20);
    println!("Fetched {} task slots from registry", tasks.len());

    // 2. Filter claimable liquidation tasks
    for (idx, task_opt) in tasks.iter().enumerate() {
        if let Some(task) = task_opt {
            if task.task_type == TaskType::Liquidation && task.status == TaskStatus::Pending {
                let task_id = (idx + 1) as u64;
                println!("Found pending liquidation task #{}", task_id);

                // 3. Claim task
                let raw_client = keeper_registry::KeeperRegistryClient::new(&env, &registry_contract);
                println!("Claiming task #{}...", task_id);
                raw_client.claim_task(&keeper_address, &task_id);

                // 4. Perform off-chain liquidation calculation & submit execution proof
                let proof = Bytes::from_array(&env, &[0xde, 0xad, 0xbe, 0xef]);
                println!("Executing task #{} with liquidation proof...", task_id);
                raw_client.execute_task(&keeper_address, &task_id, &proof);

                // 5. Check accrued rewards & withdraw
                let balance = raw_client.keeper_balance(&keeper_address);
                println!("Accrued keeper balance: {} stroops", balance);
                if balance > 0 {
                    raw_client.withdraw_rewards(&keeper_address);
                    println!("Successfully withdrew {} stroops to keeper wallet", balance);
                }
            }
        }
    }

    println!("Liquidation Keeper Bot execution cycle completed successfully.");
}
