//! Task lifecycle: registration, funding, claiming, execution, and the two
//! refund paths (owner cancel and permissionless expiry).

use soroban_sdk::{contractimpl, log, Address, Bytes, Env};

use crate::constants::*;
use crate::errors::KeeperError;
use crate::events::*;
use crate::internal::*;
use crate::types::{DataKey, Task, TaskStatus, TaskType};
use crate::verifier::KeeperVerifierClient;
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

#[contractimpl]
impl KeeperRegistry {
    // ── register_task ────────────────────────────────────────────────────────
    //
    // Fully implemented. Any dApp or wallet calls this to post a task.
    // The reward is escrowed in this contract immediately on registration.
    //
    // Arguments:
    //   owner        — address funding the task (must auth)
    //   task_type    — classification (Liquidation, OraclePricePush, …)
    //   calldata     — encoded params the keeper uses to build the target
    //                  call; capped at MAX_CALLDATA_LEN bytes, rejected with
    //                  CalldataTooLarge otherwise
    //   reward       — XLM stroops escrowed as bounty
    //   deadline     — unix timestamp after which the task expires
    //   ttl_ledgers  — how long to keep the storage entry alive; must be at
    //                  least `MIN_TTL_LEDGERS`
    //   lock_ledgers — ledgers the claimer holds exclusive rights; must be in
    //                  `[MIN_LOCK_LEDGERS, MAX_LOCK_LEDGERS]`
    //   verifier     — optional on-chain proof verifier (docs/VERIFIER_DESIGN.md).
    //                  `None` behaves exactly as before this parameter existed;
    //                  `Some(addr)` is stored on the task but does not change
    //                  this function's own behavior — only `execute_task`
    //                  consumes it. Any address is accepted (verifiers are
    //                  permissionless).
    //
    // Returns the new task_id.

    // The task parameters are all distinct scalars a caller must supply; a
    // params struct would just move them without improving the ABI.
    #[allow(clippy::too_many_arguments)]
    pub fn register_task(
        e: Env,
        owner: Address,
        task_type: TaskType,
        calldata: Bytes,
        reward: i128,
        deadline: u64,
        ttl_ledgers: u32,
        lock_ledgers: u32,
        verifier: Option<Address>,
    ) -> Result<u64, KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        validate_task_params(
            &e,
            reward,
            min_reward_floor(&e),
            deadline,
            calldata.len(),
            ttl_ledgers,
            lock_ledgers,
        )?;

        bump_instance(&e);

        // Escrow the reward from the owner into this contract.
        reward_token(&e)?.transfer(&owner, &e.current_contract_address(), &reward);

        let task_id = next_task_id(&e);
        let task = Task {
            owner: owner.clone(),
            task_type,
            calldata,
            reward,
            deadline,
            ttl_ledgers,
            verifier: None,
            status: TaskStatus::Pending,

            claimer: None,
            claim_ledger: None,
            lock_ledgers,
            verifier,
        };
        save_task(&e, task_id, &task);
        emit_task_registered(&e, task_id, &owner, reward, deadline);

        Ok(task_id)
    }
    // ── increase_reward ──────────────────────────────────────────────────────
    //
    // The owner tops up the bounty on a task that hasn't finished yet (Pending
    // or Claimed) to attract keepers. The extra amount is escrowed immediately.

    pub fn increase_reward(
        e: Env,
        owner: Address,
        task_id: u64,
        additional: i128,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        if additional <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        match task.status {
            TaskStatus::Pending | TaskStatus::Claimed => {}
            _ => return Err(KeeperError::InvalidTaskStatus),
        }

        bump_instance(&e);
        reward_token(&e)?.transfer(&owner, &e.current_contract_address(), &additional);
        task.reward = task
            .reward
            .checked_add(additional)
            .expect("reward overflow");
        save_task(&e, task_id, &task);

        emit_reward_increased(&e, task_id, task.reward);
        Ok(())
    }
    // ── extend_deadline ──────────────────────────────────────────────────────
    //
    // The owner pushes out the deadline on an unfinished task so keepers have
    // more time. The new deadline must be strictly later than the current one.

    pub fn extend_deadline(
        e: Env,
        owner: Address,
        task_id: u64,
        new_deadline: u64,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        match task.status {
            TaskStatus::Pending | TaskStatus::Claimed => {}
            _ => return Err(KeeperError::InvalidTaskStatus),
        }
        if new_deadline <= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        bump_instance(&e);
        task.deadline = new_deadline;
        save_task(&e, task_id, &task);

        emit_deadline_extended(&e, task_id, new_deadline);
        log!(&e, "Task {} deadline extended to {}", task_id, new_deadline);
        Ok(())
    }
    // ── update_verifier ──────────────────────────────────────────────────────
    //
    // The owner sets or clears the attached verifier address before a task is
    // claimed. Restricted strictly to `Pending` status to prevent griefing.

    pub fn update_verifier(
        e: Env,
        owner: Address,
        task_id: u64,
        new_verifier: Option<Address>,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        if task.status != TaskStatus::Pending {
            return Err(KeeperError::InvalidTaskStatus);
        }

        bump_instance(&e);
        task.verifier = new_verifier.clone();
        save_task(&e, task_id, &task);

        emit_verifier_updated(&e, task_id, &new_verifier);
        Ok(())
    }
    // ── claim_task ───────────────────────────────────────────────────────────

    //
    // Permissionless first-come-first-served claiming. A Pending task may be
    // claimed by anyone; a Claimed task may be re-claimed only after its
    // previous claimer's lock window has elapsed (see `lock_expired`), which
    // stops a keeper from squatting on a task it never intends to execute.

    pub fn claim_task(e: Env, keeper: Address, task_id: u64) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        let mut task = load_task(&e, task_id)?;

        if e.ledger().timestamp() >= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        match task.status {
            TaskStatus::Pending => {}
            TaskStatus::Claimed => {
                // Only allow a takeover once the current lock has expired.
                if !lock_expired(&e, &task) {
                    return Err(KeeperError::LockPeriodActive);
                }
            }
            _ => return Err(KeeperError::InvalidTaskStatus),
        }

        bump_instance(&e);
        task.status = TaskStatus::Claimed;
        task.claimer = Some(keeper.clone());
        task.claim_ledger = Some(e.ledger().sequence());
        save_task(&e, task_id, &task);

        emit_task_claimed(&e, task_id, &keeper);
        Ok(())
    }
    // ── execute_task ─────────────────────────────────────────────────────────
    //
    // The claiming keeper submits proof that it performed the off-chain action
    // and is credited its share of the escrowed reward. The protocol fee stays
    // in the contract (later swept by admin via `sweep_fees`). The reward is
    // credited to an internal balance rather than transferred out here so the
    // keeper controls when it pays the withdrawal transfer cost.
    //
    // If the task has a `verifier` attached (docs/VERIFIER_DESIGN.md), it is
    // called before any of the above: a rejection (explicit `false` or a
    // panic) returns `KeeperError::VerificationFailed` with the task left
    // exactly as it was (still `Claimed`, nothing credited or transferred).
    // With no verifier attached, proof handling is unchanged from the MVP:
    //
    // The proof is emitted in `TaskExecuted` (not just logged) so it is
    // publicly recoverable off-chain — this MVP trusts the claimer to submit
    // it (see README's Known Design Decisions), and that trade-off only holds
    // if a keeper submitting garbage can be identified after the fact. Its
    // size is bounded by `MAX_PROOF_LEN` since event data is charged against
    // the paying keeper's transaction resource budget.
    //
    // Verifier resource cost note: When an `IKeeperVerifier` is attached to
    // a task (Phase 2), the calling keeper pays for the full gas/resource cost
    // of the verifier sub-call. Soroban does not support caller-side sub-call
    // budget caps; keepers should simulate the verifier (`verify`) pre-claim
    // to estimate resource cost before committing to a claim (see
    // `docs/VERIFIER_DESIGN.md` §3).

    pub fn execute_task(
        e: Env,
        keeper: Address,
        task_id: u64,
        proof: Bytes,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        if proof.len() > MAX_PROOF_LEN {
            return Err(KeeperError::ProofTooLarge);
        }

        let mut task = load_task(&e, task_id)?;

        if task.status != TaskStatus::Claimed {
            return Err(KeeperError::InvalidTaskStatus);
        }
        // Only the keeper that currently holds the claim may execute.
        if task.claimer.as_ref() != Some(&keeper) {
            return Err(KeeperError::NotTaskClaimer);
        }
        if e.ledger().timestamp() >= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        // Verifier gate (docs/VERIFIER_DESIGN.md §1-2): `None` is the
        // unchanged wave-1 MVP path. `Some(addr)` must approve before any
        // state changes below — `try_verify` catches a callee panic the same
        // way an explicit `false` is handled, so a broken or malicious
        // verifier can only ever cause this typed rejection, never abort the
        // transaction or brick the task (it stays `Claimed` and retryable,
        // or falls back to `expire_task` at the deadline).
        if let Some(verifier) = task.verifier.clone() {
            let approved = matches!(
                KeeperVerifierClient::new(&e, &verifier).try_verify(&task_id, &keeper, &proof),
                Ok(Ok(true))
            );
            if !approved {
                emit_verification_failed(&e, task_id, &keeper);
                return Err(KeeperError::VerificationFailed);
            }
        }

        bump_instance(&e);
        let (keeper_net, fee) = split_reward(task.reward, fee_bps(&e))?;
        credit_keeper(&e, &keeper, keeper_net)?;
        accrue_fee(&e, fee)?;

        task.status = TaskStatus::Executed;
        save_task(&e, task_id, &task);

        emit_task_executed(&e, task_id, &keeper, keeper_net, &proof);
        Ok(())
    }
    // ── cancel_task ──────────────────────────────────────────────────────────
    //
    // The owner reclaims a task. Pending tasks can be cancelled immediately.
    // Claimed tasks can also be cancelled by the owner once the claimer's lock
    // period has expired (`lock_expired(&e, &task) == true`), so a keeper that
    // has started work has exclusive time to execute before escrow can be pulled.

    pub fn cancel_task(e: Env, owner: Address, task_id: u64) -> Result<(), KeeperError> {
        owner.require_auth();

        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        match task.status {
            TaskStatus::Pending => {}
            TaskStatus::Claimed => {
                if !lock_expired(&e, &task) {
                    return Err(KeeperError::LockPeriodActive);
                }
            }
            _ => return Err(KeeperError::InvalidTaskStatus),
        }

        bump_instance(&e);
        // Effects before interaction: a re-entrant cancel must find the task
        // already Cancelled and be rejected by the status guard above.
        let refund = task.reward;
        task.status = TaskStatus::Cancelled;
        save_task(&e, task_id, &task);

        reward_token(&e)?.transfer(&e.current_contract_address(), &owner, &refund);

        emit_task_cancelled(&e, task_id, &owner);
        Ok(())
    }
    // ── expire_task ──────────────────────────────────────────────────────────
    //
    // Permissionless deadline enforcement: once a task's deadline has passed
    // without execution, anyone may call this to return the escrow to the owner.
    // It is intentionally callable by any address (not just the owner) so a
    // stuck task can always be unwound and its funds recovered — a keeper bot
    // can even do this as a courtesy while scanning.

    pub fn expire_task(e: Env, task_id: u64) -> Result<(), KeeperError> {
        let mut task = load_task(&e, task_id)?;

        match task.status {
            TaskStatus::Pending | TaskStatus::Claimed => {}
            _ => return Err(KeeperError::InvalidTaskStatus),
        }
        if e.ledger().timestamp() < task.deadline {
            return Err(KeeperError::DeadlineNotPassed);
        }

        let refund = task.reward;
        let owner = task.owner.clone();

        // Effects before interaction: a re-entrant call for the same task_id
        // now sees status Expired and is rejected by the guard above, so the
        // refund can never be paid twice out of the contract's pooled escrow.
        bump_instance(&e);
        task.status = TaskStatus::Expired;
        save_task(&e, task_id, &task);

        reward_token(&e)?.transfer(&e.current_contract_address(), &owner, &refund);

        emit_task_expired(&e, task_id);
        Ok(())
    }
    // ── withdraw_rewards ─────────────────────────────────────────────────────
    //
    // A keeper pulls its accumulated balance. Follows checks-effects-
    // interactions: the stored balance is zeroed BEFORE the token transfer, so
    // even a malicious reward token that re-enters cannot double-spend the
    // balance. Returns the amount withdrawn.

    pub fn withdraw_rewards(e: Env, keeper: Address) -> Result<i128, KeeperError> {
        keeper.require_auth();

        let key = DataKey::KeeperReward(keeper.clone());
        let balance: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if balance <= 0 {
            return Err(KeeperError::NoRewardsAvailable);
        }

        bump_instance(&e);
        // Effects before interaction.
        e.storage().persistent().set(&key, &0i128);
        reward_token(&e)?.transfer(&e.current_contract_address(), &keeper, &balance);

        emit_rewards_withdrawn(&e, &keeper, balance);
        Ok(balance)
    }
}
