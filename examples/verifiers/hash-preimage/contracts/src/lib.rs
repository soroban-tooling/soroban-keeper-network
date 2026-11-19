#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, Address, Bytes, BytesN, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    ExpectedHash(u64),
    Owner,
}

/// The official IKeeperVerifier interface from docs/VERIFIER_DESIGN.md
#[contractclient(name = "KeeperVerifierClient")]
pub trait IKeeperVerifier {
    /// Returns `true` if `proof` is a valid witness that `keeper` correctly
    /// executed `task_id`'s off-chain work, `false` otherwise.
    ///
    /// Must not panic on a merely-invalid proof — return `false`.
    fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool;
}

#[contract]
pub struct HashPreimageVerifier;

#[contractimpl]
impl HashPreimageVerifier {
    /// Initialize the contract owner
    pub fn initialize(env: Env, owner: Address) {
        if env.storage().instance().has(&DataKey::Owner) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().extend_ttl(50_000, 100_000);
    }

    /// Sets the expected SHA-256 hash for a given task ID.
    /// Only the registered task owner or contract owner may register the expected hash.
    pub fn set_expected_hash(env: Env, task_id: u64, expected_hash: BytesN<32>) {
        if let Some(owner) = env.storage().instance().get::<_, Address>(&DataKey::Owner) {
            owner.require_auth();
        }
        env.storage()
            .persistent()
            .set(&DataKey::ExpectedHash(task_id), &expected_hash);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ExpectedHash(task_id), 50_000, 100_000);
    }

    /// Retrieves the expected hash configured for a task ID.
    pub fn get_expected_hash(env: Env, task_id: u64) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::ExpectedHash(task_id))
    }

    /// Verifies that `proof` matches the SHA-256 preimage of the hash set for `task_id`.
    /// Implements `IKeeperVerifier::verify` as documented in `docs/VERIFIER_DESIGN.md`.
    ///
    /// Criteria:
    /// - Returns false if proof is empty.
    /// - Returns false if no hash is configured for task_id.
    /// - Returns false if sha256(proof) != expected_hash.
    /// - Returns true if sha256(proof) == expected_hash.
    pub fn verify(env: Env, task_id: u64, _keeper: Address, proof: Bytes) -> bool {
        // Empty proof is never acceptable
        if proof.is_empty() {
            return false;
        }

        // Fetch expected hash
        let expected_hash = match env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&DataKey::ExpectedHash(task_id))
        {
            Some(hash) => hash,
            None => return false,
        };

        // Compute sha256 of the proof
        let actual_hash = env.crypto().sha256(&proof);

        actual_hash == expected_hash
    }
}

#[cfg(test)]
mod test;
