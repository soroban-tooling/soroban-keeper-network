# Contract Error Code Reference

Every Soroban contract in this workspace exposes a `#[contracterror]` enum whose
numeric discriminants are part of the published ABI. Off-chain clients (bots,
SDKs, indexers, and CLIs) decode contract errors by their `u32` discriminant.

> **ABI stability:** Never renumber an existing error variant. When adding a new
> variant to any `contracts/*/src/errors.rs`, allocate the next free discriminant
> and add a corresponding row to this document. The CI check
> `scripts/check-error-docs.sh` fails if any variant in `contracts/*/src/errors.rs`
> is missing from this reference or has a mismatched code.

---

## Keeper Registry (`KeeperError`)

Source: [`contracts/keeper-registry/src/errors.rs`](../contracts/keeper-registry/src/errors.rs)

### Core Lifecycle & Admin (E01)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `1` | `AlreadyInitialized` | `initialize` was called on a registry that is already initialized. | `initialize` | Treat as a deployment bug or idempotent no-op if verifying setup; do not retry. |
| `2` | `Unauthorized` | The caller is not the configured admin. | `pause`, `unpause`, `set_fee_bps`, `set_min_reward`, `set_reputation_floor`, `set_min_stake`, `set_dispute_window`, `sweep_fees`, `transfer_admin`, `slash`, `resolve_slash_appeal`, `resolve_execution_dispute`, `upgrade` | Do not retry with the same signer. Verify the current admin via `get_admin` and sign with the admin key (or submit a governance proposal). |
| `3` | `ContractPaused` | The registry is currently paused by the admin. | `register_task`, `batch_register_tasks`, `increase_reward`, `extend_deadline`, `update_verifier`, `claim_task`, `execute_task`, `cancel_task`, `expire_task`, `withdraw_rewards`, `stake_deposit`, `initiate_unbond`, `withdraw_stake`, `raise_slash_appeal`, `dispute_execution` | Back off and poll `is_paused` until the contract is unpaused before retrying. |
| `4` | `TaskNotFound` | No task exists for the supplied `task_id` (never registered, or its persistent storage entry expired). | `get_task`, `increase_reward`, `extend_deadline`, `update_verifier`, `claim_task`, `execute_task`, `cancel_task`, `expire_task`, `dispute_execution`, `resolve_execution_dispute` | Do not retry. Verify the `task_id` and remove stale tasks from local state. |
| `5` | `InvalidTaskStatus` | The task's current status does not permit the requested transition (e.g., claiming an already-claimed task, executing a non-claimed task, cancelling an executed task, or updating a verifier after claim). | `increase_reward`, `extend_deadline`, `update_verifier`, `claim_task`, `execute_task`, `cancel_task`, `expire_task` | Re-fetch the task with `get_task` to reconcile local state; do not blindly retry the same transition. |
| `6` | `DeadlinePassed` | The current ledger sequence is at or past the task's `deadline`, or a newly proposed deadline is not strictly in the future. | `register_task`, `batch_register_tasks`, `extend_deadline`, `claim_task`, `execute_task` | For registration/extension, pick a future deadline ledger and resubmit. For claim/execute, abandon the task (it can only be expired via `expire_task`). |
| `7` | `DeadlineNotPassed` | `expire_task` was called before the task's `deadline` ledger has been reached. | `expire_task` | Wait until the ledger sequence reaches `task.deadline`, then retry `expire_task`. |
| `8` | `InvalidReward` | A reward, stake, or sweep amount is non-positive, below `min_reward`, or otherwise invalid. | `register_task`, `batch_register_tasks`, `increase_reward`, `set_min_reward`, `sweep_fees`, `stake_deposit`, `initiate_unbond`, `slash`, `set_min_stake` | Validate the amount against `get_min_reward` (and ensure it is strictly positive where required) before resubmitting. |
| `9` | `LockPeriodActive` | The task is currently claimed and its claimer's exclusive lock period (`claimed_at + lock_ledgers`) has not yet elapsed. | `claim_task`, `cancel_task` | Wait until `task.claimed_at + task.lock_ledgers` has passed, then re-check task status before retrying. |
| `10` | `InvalidFeeBps` | `fee_bps` exceeds the maximum allowed basis points (`MAX_FEE_BPS`). | `initialize`, `set_fee_bps` | Supply a `fee_bps` value within `0..=MAX_FEE_BPS` and resubmit. |
| `11` | `NotTaskOwner` | The caller is not the `owner` recorded on the task. | `increase_reward`, `extend_deadline`, `update_verifier`, `cancel_task`, `dispute_execution` | Do not retry with this signer. Sign with the task's `owner` address. |
| `12` | `NotTaskClaimer` | The caller is not the active `claimer` of the task. | `execute_task` | Do not retry. Another keeper holds the active claim; re-fetch `get_task` and move on to other tasks. |
| `13` | `NoRewardsAvailable` | The caller has a zero withdrawable reward balance, or accrued protocol fees are zero. | `withdraw_rewards`, `sweep_fees` | Do not retry until new rewards or fees accrue (or pending credits pass their dispute window). |
| `15` | `NotInitialized` | An entry point requiring configured state was called before `initialize`. | `pause`, `unpause`, `set_fee_bps`, `set_min_reward`, `set_reputation_floor`, `set_min_stake`, `set_dispute_window`, `sweep_fees`, `transfer_admin`, `register_task`, `batch_register_tasks`, `increase_reward`, `extend_deadline`, `update_verifier`, `claim_task`, `execute_task`, `cancel_task`, `expire_task`, `withdraw_rewards`, `stake_deposit`, `initiate_unbond`, `withdraw_stake`, `slash`, `raise_slash_appeal`, `resolve_slash_appeal`, `dispute_execution`, `resolve_execution_dispute` | Initialize the contract via `initialize` before invoking operational entry points. |
| `16` | `TtlTooShort` | `ttl_ledgers` does not cover the task's `deadline` plus the required safety margin, risking storage expiration while escrow is live. | `register_task`, `batch_register_tasks` | Compute a sufficient `ttl_ledgers` (at least `(deadline - current_ledger) + safety_margin`) and resubmit. |
| `17` | `CalldataTooLarge` | `calldata` exceeds `MAX_CALLDATA_LEN`. | `register_task`, `batch_register_tasks` | Shrink or compress the calldata payload to `<= MAX_CALLDATA_LEN` bytes before resubmitting. |
| `18` | `InvalidTaskParams` | `lock_ledgers`, `ttl_ledgers`, or `dispute_window` fell outside allowed protocol bounds. | `register_task`, `batch_register_tasks`, `set_dispute_window` | Adjust the parameter to fall within the contract's documented min/max bounds and resubmit. |
| `19` | `ArithmeticOverflow` | A checked arithmetic operation would overflow or underflow `i128` / `u64` / `u32`. | `register_task`, `batch_register_tasks`, `get_tasks_range`, `execute_task`, `stake_deposit`, `initiate_unbond`, `slash`, `resolve_slash_appeal`, `resolve_execution_dispute` | Reduce input magnitudes, split large batches/ranges, or inspect on-chain balances before retrying. |

### Execution Verifier (E04)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `14` | `ProofTooLarge` | `proof` passed to `execute_task` exceeds `MAX_PROOF_LEN`. | `execute_task` | Produce a proof within `MAX_PROOF_LEN` bytes; do not resubmit the oversized proof. |
| `20` | `IncompatibleVerifierInterface` | The attached verifier reported an `interface_version` other than `KEEPER_VERIFIER_INTERFACE_VERSION`; `verify` was not called. | `register_task`, `batch_register_tasks`, `update_verifier`, `execute_task` | Attach a verifier contract that implements the expected interface version. For keepers, skip the task until the owner updates its verifier. |
| `24` | `VerificationFailed` | The task's attached verifier rejected the proof (`verify` returned `false` or panicked). The task remains `Claimed` by the caller. | `execute_task` | Inspect why the proof was rejected (e.g., verifier events or off-chain simulation) and retry with a valid proof while the claim lock and deadline still hold. |

### Batch Operations (E05)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `21` | `BatchTooLarge` | `get_tasks` / `get_tasks_range` requested more than `MAX_BATCH_READ` tasks, or `batch_register_tasks` received more than `MAX_BATCH_SIZE` entries. | `batch_register_tasks`, `get_tasks`, `get_tasks_range` | Chunk the request into pages of at most `MAX_BATCH_READ` (reads) or `MAX_BATCH_SIZE` (writes) and resubmit. |
| `22` | `EmptyBatch` | `batch_register_tasks` was called with an empty `tasks` vector. | `batch_register_tasks` | Skip submitting empty batches on the client side; check upstream task generation logic. |
| `23` | `BatchRewardCeilingExceeded` | The sum of rewards in `batch_register_tasks` exceeded the caller-supplied `max_total_reward` ceiling. No tokens were transferred. | `batch_register_tasks` | Recompute total batch cost, either raise `max_total_reward` or split/trim the batch, and resubmit. |

### Staking, Slashing & Execution Disputes (E06)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `25` | `InsufficientStake` | `slash` or `initiate_unbond` requested an amount greater than the keeper's available stake. | `initiate_unbond`, `slash` | Query the keeper's current stake and submit an amount `<=` available stake. |
| `26` | `UnbondNotReady` | `withdraw_stake` was called before the pending unbond request's `unlock_ledger` has been reached. | `withdraw_stake` | Wait until the ledger sequence reaches `unbond_request.unlock_ledger`, then retry `withdraw_stake`. |
| `27` | `UnbondAlreadyPending` | `initiate_unbond` was called while an earlier unbond request for the same keeper has not yet been withdrawn. | `initiate_unbond` | Wait for the existing unbond request to unlock and call `withdraw_stake` before initiating a new unbond. |
| `28` | `NoPendingUnbond` | `withdraw_stake` was called when no `UnbondRequest` exists for the keeper. | `withdraw_stake` | Call `initiate_unbond` first, or reconcile local state if the withdrawal already succeeded. |
| `29` | `MinStakeNotMet` | `claim_task` rejected a keeper whose active stake is below the configured `MinStake` floor. | `claim_task` | Top up stake via `stake_deposit` to meet `get_min_stake`, then retry claiming. |
| `30` | `SlashNotFound` | `raise_slash_appeal` or `resolve_slash_appeal` referenced a `slash_id` with no matching `Slash` record (or no pending appeal to resolve). | `raise_slash_appeal`, `resolve_slash_appeal` | Verify the `slash_id` and its appeal state before retrying. |
| `31` | `AppealWindowClosed` | `raise_slash_appeal` was called after `DISPUTE_WINDOW_LEDGERS` elapsed since the slash. | `raise_slash_appeal` | Do not retry; the appeal window is permanently closed. |
| `32` | `AppealAlreadyRaised` | `raise_slash_appeal` was called for a `slash_id` that already has an appeal on file. | `raise_slash_appeal` | Do not retry; await admin resolution via `resolve_slash_appeal`. |
| `33` | `NotSlashedKeeper` | `raise_slash_appeal` was called by an address other than the slashed keeper recorded on the `Slash`. | `raise_slash_appeal` | Sign the appeal transaction with the slashed keeper's address. |
| `34` | `NoPendingCredit` | `dispute_execution` found no matching `PendingCredit` for the task (never executed, already finalized, or already resolved). | `dispute_execution` | Do not retry; the execution credit is no longer pending. |
| `35` | `ExecutionAlreadyDisputed` | `dispute_execution` was called for a `task_id` whose pending credit is already marked disputed. | `dispute_execution` | Do not retry; await admin resolution via `resolve_execution_dispute`. |
| `36` | `DisputeWindowClosed` | `dispute_execution` was called after the pending credit's `unlock_ledger` had already passed. | `dispute_execution` | Do not retry; the dispute window has closed and the credit is eligible to finalize. |
| `37` | `NoDisputedCredit` | `resolve_execution_dispute` found no disputed `PendingCredit` for the supplied `task_id`. | `resolve_execution_dispute` | Verify the `task_id` and whether the dispute was already resolved; do not retry. |

### Keeper Reputation (E07)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `38` | `ReputationBelowFloor` | `claim_task` rejected a keeper whose reputation score is below the admin-configured floor. | `claim_task` | Do not retry immediately; a keeper cannot raise its score without claiming, so wait until the admin lowers the floor via `set_reputation_floor`. |
| `39` | `InvalidReputationFloor` | `set_reputation_floor` was given a floor above `MAX_REPUTATION_FLOOR_BPS`. | `set_reputation_floor` | Supply a floor within `0..=MAX_REPUTATION_FLOOR_BPS` and resubmit. |

### Task Conditions (E10)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `40` | `ConditionNotMet` | The task's attached condition contract returned `false` or failed to evaluate. The task remains in its previous claimable state. | `claim_task` | Monitor the underlying condition (e.g., time window or oracle price) and retry `claim_task` once the condition is satisfied. |

---

## Treasury (`TreasuryError`)

Source: [`contracts/treasury/src/errors.rs`](../contracts/treasury/src/errors.rs)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `1` | `AlreadyInitialized` | `initialize` was called on a treasury that is already initialized. | `initialize` | Treat as a deployment bug or idempotent setup check; do not retry. |
| `2` | `Unauthorized` | The caller is not the configured treasury admin. | `pause`, `unpause`, `add_recipient`, `remove_recipient`, `update_recipient_shares`, `distribute`, `transfer_admin`, `upgrade` | Do not retry with this signer. Query `get_admin` and sign with the admin key (or submit a governance proposal). |
| `3` | `ContractPaused` | The treasury is currently paused by the admin. | `add_recipient`, `remove_recipient`, `update_recipient_shares`, `distribute`, `withdraw` | Back off and poll `is_paused` until the treasury is unpaused. |
| `4` | `NotInitialized` | An entry point requiring configured state was called before `initialize`. | `pause`, `unpause`, `add_recipient`, `remove_recipient`, `update_recipient_shares`, `distribute`, `withdraw`, `transfer_admin`, `upgrade` | Initialize the treasury via `initialize` before invoking operational entry points. |
| `5` | `RecipientNotFound` | The specified recipient address is not registered in the treasury. | `remove_recipient`, `update_recipient_shares` | Query the current recipient list to reconcile state; do not retry with an unregistered address. |
| `6` | `RecipientAlreadyExists` | `add_recipient` was called for an address that is already registered. | `add_recipient` | Use `update_recipient_shares` to modify an existing recipient's allocation instead. |
| `7` | `InvalidShares` | `shares_bps` is zero, exceeds `MAX_SHARES_BPS`, or causes total recipient shares to exceed `MAX_SHARES_BPS`. | `add_recipient`, `update_recipient_shares` | Ensure `1 <= shares_bps <= MAX_SHARES_BPS` and that the sum of all recipients' shares does not exceed `MAX_SHARES_BPS`, then resubmit. |
| `8` | `NoRecipients` | `distribute` was called when no recipients are registered (or total shares are zero). | `distribute` | Register at least one recipient with `add_recipient` before calling `distribute`. |
| `9` | `InvalidAmount` | The amount passed to `distribute` is not strictly positive (`<= 0`). | `distribute` | Pass an amount `> 0` and resubmit. |
| `10` | `NoRewardsAvailable` | `withdraw` was called by a recipient with a zero withdrawable balance. | `withdraw` | Wait until `distribute` credits rewards to this recipient before calling `withdraw`. |
| `11` | `ArithmeticOverflow` | A checked arithmetic operation would overflow or underflow during share summation, distribution, or balance crediting. | `add_recipient`, `update_recipient_shares`, `distribute` | Check recipient share totals and distribution amount bounds before retrying. |
| `12` | `TooManyRecipients` | `add_recipient` would exceed `MAX_RECIPIENTS`. | `add_recipient` | Remove an existing recipient via `remove_recipient` before adding a new one. |

---

## Governance (`GovernanceError`)

Source: [`contracts/governance/src/errors.rs`](../contracts/governance/src/errors.rs)

| Code | Variant | Meaning | Returned by | Caller reaction |
| ---: | --- | --- | --- | --- |
| `1` | `NotInitialized` | A governance entry point was called before `initialize`. | `create_proposal`, `vote`, `evaluate_proposal`, `queue_proposal`, `execute_proposal`, `cancel_proposal` | Initialize the governance contract before submitting proposals or votes. |
| `2` | `Unauthorized` | The caller is not authorized to perform the requested governance action (e.g., cancelling another user's proposal without admin rights). | `cancel_proposal` | Sign with the proposal creator or authorized admin address; do not retry with an unauthorized key. |
| `3` | `InsufficientHoldings` | The proposer does not hold enough governance tokens to meet the proposal threshold. | `create_proposal` | Acquire or delegate sufficient governance tokens to meet the proposal threshold, then resubmit. |
| `4` | `ProposalNotFound` | No proposal exists for the supplied `proposal_id`. | `vote`, `get_tally`, `get_tallies`, `get_proposal`, `evaluate_proposal`, `queue_proposal`, `execute_proposal`, `cancel_proposal`, `get_remaining_delay`, `is_executable` | Verify the `proposal_id`; do not retry. |
| `5` | `InvalidProposalType` | The submitted proposal type or payload is not supported by governance. | `create_proposal` | Construct a valid proposal action supported by the governance contract and resubmit. |
| `6` | `VotingClosed` | `vote` was called after the proposal's voting period ended or when the proposal is no longer active. | `vote` | Do not retry; voting on this proposal is closed. |
| `7` | `AlreadyVoted` | The voter has already cast a vote on this proposal. | `vote` | Do not retry; each address may vote at most once per proposal. |
| `8` | `NotInTimelock` | Execution was attempted on a proposal that has not been queued in the timelock. | `execute_proposal` | Queue the passed proposal via `queue_proposal` and wait for the timelock delay before executing. |
| `9` | `CannotExecute` | The proposal is not eligible for execution (e.g., timelock delay has not elapsed or status is not executable). | `execute_proposal` | Check `is_executable` and `get_remaining_delay`; wait until the timelock elapses if still queued. |
| `10` | `ProposalNotPassed` | The proposal did not meet the passing threshold or quorum required to proceed. | `queue_proposal`, `execute_proposal` | Do not retry; the proposal failed and cannot be queued or executed. |
| `11` | `InvalidChoice` | The supplied vote choice is not a valid `VoteChoice` variant. | `vote` | Submit a valid vote choice (`Against`, `For`, or `Abstain`). |
| `12` | `QuorumNotMet` | Total votes cast did not reach the required quorum basis points of total supply. | `evaluate_proposal`, `queue_proposal`, `execute_proposal` | Do not retry; the proposal failed quorum. |
| `13` | `AlreadyExecuted` | `execute_proposal` was called on a proposal that has already been executed. | `execute_proposal` | Treat as already completed; do not retry. |
| `14` | `TokenTransferFailed` | A governance token transfer or balance interaction failed during proposal lifecycle handling. | `create_proposal`, `execute_proposal` | Verify token contract state, balances, and approvals before retrying. |
