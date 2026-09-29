//! Administrative entry points: configuration, the pause switch, fee and
//! treasury control, and the upgrade hook.

use soroban_sdk::{contractimpl, log, Address, BytesN, Env};

use crate::constants::MAX_REPUTATION_FLOOR_BPS;
use crate::errors::KeeperError;
use crate::events::*;
use crate::internal::*;
use crate::reputation::reputation_floor_bps;
use crate::types::DataKey;
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

#[contractimpl]
impl KeeperRegistry {
    // ── initialize ───────────────────────────────────────────────────────────
    //
    // Fully implemented. Call once after deployment.
    //
    // Arguments:
    //   admin        — address that controls admin functions
    //   reward_token — SAC / XLM token contract address used for escrow
    //   fee_bps      — platform fee in basis points (e.g. 300 = 3%)

    pub fn initialize(
        e: Env,
        admin: Address,
        reward_token: Address,
        fee_bps: u32,
    ) -> Result<(), KeeperError> {
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(KeeperError::AlreadyInitialized);
        }
        if fee_bps > 10_000 {
            return Err(KeeperError::InvalidFeeBps);
        }
        admin.require_auth();

        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        e.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        e.storage().instance().set(&DataKey::Paused, &false);
        e.storage().instance().set(&DataKey::TaskCounter, &0u64);
        bump_instance(&e);

        emit_initialized(&e, &admin, &reward_token, fee_bps);
        Ok(())
    }

    // ── pause / unpause ───────────────────────────────────────────────────────
    //
    // Admin emergency circuit breaker. The rule of thumb: anything that opens
    // new exposure (new escrow, new claims, new execution payouts) is blocked;
    // anything that only lets value flow back out to whoever already owns it
    // stays open, so an incident response can never itself become a fund
    // freeze. Read-only views are never gated.
    //
    // Verified against `require_not_paused(&e)?` (or its absence) at the top
    // of each function, current as of the pause-policy-matrix test suite in
    // `test.rs` (`test_pause_policy_matrix_entry_point_by_entry_point` et al.)
    // — that test is the source of truth if this table and the code ever
    // drift apart again.
    //
    // | Entry point       | While paused | Why                                   |
    // |--------------------|-------------|----------------------------------------|
    // | `register_task`    | BLOCKED     | opens new escrow exposure              |
    // | `batch_register_`  | BLOCKED     | same, N times over — follows           |
    // | `tasks`            |             | `register_task` exactly                |
    // | `claim_task`       | BLOCKED     | opens new keeper exposure              |
    // | `execute_task`     | BLOCKED     | pays out new rewards                   |
    // | `increase_reward`  | BLOCKED     | opens new escrow exposure              |
    // | `extend_deadline`  | BLOCKED     | stops deadline from being moved on a   |
    // |                    |             | paused task, which could otherwise     |
    // |                    |             | re-open it to interaction when the     |
    // |                    |             | intent of pause is to freeze activity. |
    // | `cancel_task`      | allowed     | owner reclaiming pending-task escrow;  |
    // |                    |             | liveness, not new exposure             |
    // | `expire_task`      | allowed     | permissionless fund recovery           |
    // | `withdraw_rewards` | allowed     | keeper pulling already-earned balance  |
    // | `stake_deposit`    | BLOCKED     | opens new keeper exposure              |
    // | `initiate_unbond`  | allowed     | keeper requesting stake return;        |
    // |                    |             | no new exposure                        |
    // | `withdraw_stake`   | allowed     | keeper pulling already-owned funds     |
    // | `slash`            | allowed     | admin action; never gated              |
    // | read-only views    | allowed     | side-effect-free, never gated          |
    //
    // `set_fee_bps`/`set_min_reward`/`set_reputation_floor`/`transfer_admin`/
    // `upgrade`/`sweep_fees`/`slash` are admin-only (`require_admin`) and were never in
    // scope for the pause gate at all — pausing doesn't restrict what the admin
    // itself can do.

    pub fn pause(e: Env, admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Paused, &true);
        emit_paused(&e, true);
        Ok(())
    }
    pub fn unpause(e: Env, admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Paused, &false);
        emit_paused(&e, false);
        Ok(())
    }
    // ── set_fee_bps ───────────────────────────────────────────────────────────
    //
    // Admin adjusts the platform fee. The new rate only affects tasks executed
    // after this call; already-accrued fees are unaffected.

    pub fn set_fee_bps(e: Env, admin: Address, new_bps: u32) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if new_bps > 10_000 {
            return Err(KeeperError::InvalidFeeBps);
        }
        bump_instance(&e);
        let old_bps = fee_bps(&e);
        e.storage().instance().set(&DataKey::FeeBps, &new_bps);
        emit_fee_updated(&e, old_bps, new_bps);
        Ok(())
    }
    // ── set_min_reward ────────────────────────────────────────────────────────
    //
    // Admin sets the minimum reward a task may be registered with. Existing
    // tasks are unaffected; only future registrations are validated.

    pub fn set_min_reward(e: Env, admin: Address, min_reward: i128) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if min_reward < 0 {
            return Err(KeeperError::InvalidReward);
        }
        bump_instance(&e);
        let old_min: i128 = min_reward_floor(&e);
        e.storage().instance().set(&DataKey::MinReward, &min_reward);
        emit_min_reward_updated(&e, old_min, min_reward);
        Ok(())
    }
    // ── set_reputation_floor ──────────────────────────────────────────────────
    //
    // Admin sets the minimum stored reputation score, in basis points, a keeper
    // needs to claim a task (see `reputation::require_reputation_floor`). `0`,
    // the default, disables the check. Only future claims are affected; an
    // existing claim is never revoked.

    pub fn set_reputation_floor(e: Env, admin: Address, floor_bps: u32) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if floor_bps > MAX_REPUTATION_FLOOR_BPS {
            return Err(KeeperError::InvalidReputationFloor);
        }
        bump_instance(&e);
        let old_floor = reputation_floor_bps(&e);
        e.storage()
            .instance()
            .set(&DataKey::ReputationFloor, &floor_bps);
        emit_reputation_floor_updated(&e, old_floor, floor_bps);
        Ok(())
    }
    // ── transfer_admin ────────────────────────────────────────────────────────
    //
    // Hands the admin role to a new address. Both the current admin and the
    // incoming admin must authorize, so the role can never be transferred to an
    // address that has not consented to take it (no accidental lock-out).

    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        new_admin.require_auth();
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        emit_admin_transferred(&e, &admin, &new_admin);
        Ok(())
    }
    // ── upgrade ───────────────────────────────────────────────────────────────
    //
    // Admin swaps the contract WASM for a new hash (already installed on-chain).
    // Storage layout is preserved across the upgrade.

    pub fn upgrade(e: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        bump_instance(&e);

        // Emitted *before* the wasm swap: once `update_current_contract_wasm`
        // runs, the rest of this invocation continues under the new code's
        // semantics, which we should not assume anything about. Emitting the
        // record first keeps it independent of whatever the new code does.
        emit_upgraded(&e, &admin, &new_wasm_hash);

        e.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        log!(&e, "Contract upgraded by {} to {:?}", admin, new_wasm_hash);
        Ok(())
    }
    // ── sweep_fees ────────────────────────────────────────────────────────────
    //
    // Admin moves up to the accrued protocol fees to a treasury address. The
    // amount is checked against the FeesAccrued accumulator, so a sweep can
    // never dip into task escrow or keeper balances.
    //
    // E08 (docs/TREASURY_DESIGN.md §3): this stays a plain token transfer.
    // To route fees through the treasury contract (`contracts/treasury`),
    // the admin passes that contract's address as `treasury`; its
    // permissionless `distribute` then splits what arrived across the
    // configured recipients as a separate step. The registry never calls
    // into the treasury, so a treasury fault cannot fail a sweep or reach
    // task escrow, and this entry point's signature is unchanged.

    pub fn sweep_fees(
        e: Env,
        admin: Address,
        treasury: Address,
        amount: i128,
    ) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;

        if amount <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        let accrued: i128 = e
            .storage()
            .instance()
            .get(&DataKey::FeesAccrued)
            .unwrap_or(0);
        if amount > accrued {
            return Err(KeeperError::NoRewardsAvailable);
        }

        bump_instance(&e);
        // Effects before interaction.
        e.storage()
            .instance()
            .set(&DataKey::FeesAccrued, &(accrued - amount));
        reward_token(&e)?.transfer(&e.current_contract_address(), &treasury, &amount);

        let remaining = accrued - amount;
        emit_fees_swept(&e, &treasury, amount, remaining);
        Ok(())
    }
}
