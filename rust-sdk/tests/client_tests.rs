use soroban_keeper_sdk::{
    BatchTaskParams, KeeperClient, KeypairSigner, TaskRegisteredEvent, TaskType,
    TransactionSigner,
};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

struct CustomHsmSigner {
    addr: Address,
}

impl TransactionSigner for CustomHsmSigner {
    fn address(&self) -> Address {
        self.addr.clone()
    }

    fn sign_payload(&self, payload: &[u8]) -> Result<soroban_sdk::Bytes, soroban_keeper_sdk::SignerError> {
        let mut bytes = Bytes::new(&self.addr.env());
        for &b in payload {
            bytes.push_back(b);
        }
        Ok(bytes)
    }
}

#[test]
fn test_signer_abstraction() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let signer = CustomHsmSigner { addr: addr.clone() };

    assert_eq!(signer.address(), addr);
    let payload = [1u8, 2, 3, 4];
    let sig = signer.sign_payload(&payload).unwrap();
    assert_eq!(sig.len(), 4);
}

#[test]
fn test_event_decoding() {
    let env = Env::default();
    let owner = Address::generate(&env);
    
    let event = TaskRegisteredEvent {
        task_id: 42,
        owner: owner.clone(),
        reward: 5_000_000,
        deadline: 1_700_000_000,
    };

    assert_eq!(event.task_id, 42);
    assert_eq!(event.owner, owner);
    assert_eq!(event.reward, 5_000_000);
}

#[test]
fn test_client_initialization_and_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(keeper_registry::KeeperRegistry, ());
    let admin_addr = Address::generate(&env);
    let reward_token = Address::generate(&env);
    let signer = KeypairSigner::new(admin_addr.clone());

    let client = KeeperClient::new(&env, contract_id.clone(), &signer);

    // Initialize
    client.initialize(&reward_token, 300).expect("Failed to initialize");

    // Pause & Unpause
    client.pause().expect("Failed to pause");
    client.unpause().expect("Failed to unpause");

    // Fee bps update
    client.set_fee_bps(500).expect("Failed to set fee bps");

    // Min reward
    client.set_min_reward(1000).expect("Failed to set min reward");
}

#[test]
fn test_batch_operations_and_queries() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(keeper_registry::KeeperRegistry, ());
    let admin_addr = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(admin_addr.clone());
    let reward_token = token_contract.address();
    let signer = KeypairSigner::new(admin_addr.clone());

    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &reward_token);
    token_admin.mint(&admin_addr, &100_000_000);

    let client = KeeperClient::new(&env, contract_id.clone(), &signer);
    client.initialize(&reward_token, 300).expect("Failed to initialize");

    let mut tasks = Vec::new(&env);
    tasks.push_back(BatchTaskParams {
        task_type: TaskType::Liquidation,
        calldata: Bytes::from_array(&env, &[1, 2, 3]),
        reward: 1_000_000,
        deadline: env.ledger().timestamp() + 100,
        ttl_ledgers: 25_000,
        lock_ledgers: 20,
    });

    let task_ids = client.batch_register_tasks(tasks, 1_000_000).expect("Failed to batch register");
    assert_eq!(task_ids.len(), 1);

    let retrieved = client.get_tasks(task_ids.clone());
    assert_eq!(retrieved.len(), 1);
    assert!(retrieved.get(0).unwrap().is_some());

    let range = client.get_tasks_range(1, 10);
    assert_eq!(range.len(), 10);
    assert!(range.get(0).unwrap().is_some());
}
