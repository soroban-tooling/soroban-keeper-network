//! Event emission.
//!
//! Every event uses a two-symbol topic pair `(verb, noun)` so off-chain
//! consumers can filter without decoding the payload. The README event table
//! is the published contract for these shapes.

use soroban_sdk::{symbol_short, Address, Bytes, BytesN, Env};

// ─────────────────────────────────────────────────────────────────────────────
// Events — emitted for off-chain keeper bots to consume
// ─────────────────────────────────────────────────────────────────────────────

pub fn emit_task_registered(e: &Env, task_id: u64, owner: &Address, reward: i128, deadline: u64) {
    e.events().publish(
        (symbol_short!("reg"), symbol_short!("task")),
        (task_id, owner.clone(), reward, deadline),
    );
}

pub fn emit_task_claimed(e: &Env, task_id: u64, keeper: &Address) {
    e.events().publish(
        (symbol_short!("claim"), symbol_short!("task")),
        (task_id, keeper.clone(), e.ledger().sequence()),
    );
}

pub fn emit_task_executed(
    e: &Env,
    task_id: u64,
    keeper: &Address,
    net_reward: i128,
    proof: &Bytes,
) {
    e.events().publish(
        (symbol_short!("exec"), symbol_short!("task")),
        (task_id, keeper.clone(), net_reward, proof.clone()),
    );
}

pub fn emit_task_expired(e: &Env, task_id: u64) {
    e.events()
        .publish((symbol_short!("exp"), symbol_short!("task")), (task_id,));
}

pub fn emit_task_cancelled(e: &Env, task_id: u64, owner: &Address) {
    e.events().publish(
        (symbol_short!("cancel"), symbol_short!("task")),
        (task_id, owner.clone()),
    );
}

pub fn emit_rewards_withdrawn(e: &Env, keeper: &Address, amount: i128) {
    e.events().publish(
        (symbol_short!("wdraw"), symbol_short!("reward")),
        (keeper.clone(), amount),
    );
}

pub fn emit_paused(e: &Env, paused: bool) {
    e.events()
        .publish((symbol_short!("paused"), symbol_short!("admin")), (paused,));
}

pub fn emit_fee_updated(e: &Env, old_bps: u32, new_bps: u32) {
    e.events().publish(
        (symbol_short!("fee"), symbol_short!("admin")),
        (old_bps, new_bps),
    );
}

pub fn emit_admin_transferred(e: &Env, old_admin: &Address, new_admin: &Address) {
    e.events().publish(
        (symbol_short!("admin"), symbol_short!("xfer")),
        (old_admin.clone(), new_admin.clone()),
    );
}

pub fn emit_reward_increased(e: &Env, task_id: u64, new_reward: i128) {
    e.events().publish(
        (symbol_short!("topup"), symbol_short!("task")),
        (task_id, new_reward),
    );
}

pub fn emit_deadline_extended(e: &Env, task_id: u64, new_deadline: u64) {
    e.events().publish(
        (symbol_short!("extend"), symbol_short!("task")),
        (task_id, new_deadline),
    );
}

pub fn emit_min_reward_updated(e: &Env, old_min: i128, new_min: i128) {
    e.events().publish(
        (symbol_short!("minrwd"), symbol_short!("admin")),
        (old_min, new_min),
    );
}

pub fn emit_fees_swept(e: &Env, treasury: &Address, amount: i128, remaining: i128) {
    e.events().publish(
        (symbol_short!("sweep"), symbol_short!("admin")),
        (treasury.clone(), amount, remaining),
    );
}

pub fn emit_initialized(e: &Env, admin: &Address, reward_token: &Address, fee_bps: u32) {
    e.events().publish(
        (symbol_short!("init"), symbol_short!("admin")),
        (admin.clone(), reward_token.clone(), fee_bps),
    );
}

/// Emitted when a task's attached verifier rejects a proof (`verify` returned
/// `false`, or the call panicked). Distinct from `TaskExecuted`: the two are
/// mutually exclusive for a given `execute_task` call — a rejection emits
/// this and returns `KeeperError::VerificationFailed` without crediting the
/// keeper, transferring anything, or changing the task's status.
pub fn emit_verification_failed(e: &Env, task_id: u64, keeper: &Address) {
    e.events().publish(
        (symbol_short!("verfail"), symbol_short!("task")),
        (task_id, keeper.clone()),
    );
}

pub fn emit_upgraded(e: &Env, admin: &Address, new_wasm_hash: &BytesN<32>) {
    e.events().publish(
        (symbol_short!("upgrade"), symbol_short!("admin")),
        (admin.clone(), new_wasm_hash.clone()),
    );
}

pub fn emit_verifier_updated(e: &Env, task_id: u64, verifier: &Option<Address>) {
    e.events().publish(
        (symbol_short!("verifier"), symbol_short!("task")),
        (task_id, verifier.clone()),
    );
}

