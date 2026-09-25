//! Event emission.
//!
//! Every event uses a two-symbol topic pair `(verb, noun)` so off-chain
//! consumers can filter without decoding the payload, mirroring
//! `contracts/keeper-registry/src/events.rs`.

use soroban_sdk::{symbol_short, Address, BytesN, Env};

pub fn emit_initialized(e: &Env, admin: &Address, reward_token: &Address) {
    e.events().publish(
        (symbol_short!("init"), symbol_short!("admin")),
        (admin.clone(), reward_token.clone()),
    );
}

pub fn emit_recipient_added(e: &Env, recipient: &Address, shares_bps: u32) {
    e.events().publish(
        (symbol_short!("radd"), symbol_short!("recip")),
        (recipient.clone(), shares_bps),
    );
}

pub fn emit_recipient_removed(e: &Env, recipient: &Address) {
    e.events().publish(
        (symbol_short!("rrm"), symbol_short!("recip")),
        (recipient.clone(),),
    );
}

pub fn emit_recipient_shares_updated(
    e: &Env,
    recipient: &Address,
    old_shares_bps: u32,
    new_shares_bps: u32,
) {
    e.events().publish(
        (symbol_short!("rshr"), symbol_short!("recip")),
        (recipient.clone(), old_shares_bps, new_shares_bps),
    );
}

/// One per recipient credited by a single `distribute` call.
/// `total_distributed` is the running lifetime total *after* this credit, so
/// an indexer can validate its own running sum against the contract's without
/// a separate view call.
pub fn emit_distributed(e: &Env, recipient: &Address, amount: i128, total_distributed: i128) {
    e.events().publish(
        (symbol_short!("dist"), symbol_short!("recip")),
        (recipient.clone(), amount, total_distributed),
    );
}

pub fn emit_withdrawn(e: &Env, recipient: &Address, amount: i128) {
    e.events().publish(
        (symbol_short!("wdraw"), symbol_short!("recip")),
        (recipient.clone(), amount),
    );
}

pub fn emit_paused(e: &Env, paused: bool) {
    e.events()
        .publish((symbol_short!("paused"), symbol_short!("admin")), (paused,));
}

pub fn emit_admin_transferred(e: &Env, old_admin: &Address, new_admin: &Address) {
    e.events().publish(
        (symbol_short!("admin"), symbol_short!("xfer")),
        (old_admin.clone(), new_admin.clone()),
    );
}

pub fn emit_upgraded(e: &Env, admin: &Address, new_wasm_hash: &BytesN<32>) {
    e.events().publish(
        (symbol_short!("upgrade"), symbol_short!("admin")),
        (admin.clone(), new_wasm_hash.clone()),
    );
}
