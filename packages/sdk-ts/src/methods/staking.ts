/**
 * Keeper staking, unbonding, slashing, and the slash-appeal window (epic
 * E06). Mirrors `contracts/keeper-registry/src/staking.rs` -- see
 * `docs/STAKING_DESIGN.md` for the full design.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, boolArg, i128Arg, symbolArg, u32Arg, u64Arg } from "../core/scval.js";
import { KeeperContractError, KeeperErrorCode } from "../errors.js";
import type { PendingCredit, SlashRecord, UnbondRequest } from "../types.js";

// -- stake_deposit -------------------------------------------------------------

export interface StakeDepositParams extends SignedCallOptions {
  /** `G...` address of the keeper depositing collateral. Must authorize the call. */
  keeper: string;
  /** Amount to stake, in the reward token's own units. `i128`, so `bigint`. */
  amount: IntegerInput;
}

/**
 * Posts collateral for `keeper`. Escrows `amount` from the keeper into the
 * contract, via the same reward-token transfer every other transfer in the
 * contract uses.
 */
export async function stakeDeposit(
  caller: ContractCaller,
  params: StakeDepositParams,
): Promise<void> {
  const { keeper, signer } = params;
  const amount = i128Arg(params.amount, "amount");

  await caller.invoke<void>({
    method: "stake_deposit",
    source: keeper,
    args: [addressArg(keeper, "keeper"), amount],
    ...(signer ? { signer } : {}),
  });
}

// -- initiate_unbond -------------------------------------------------------------

export interface InitiateUnbondParams extends SignedCallOptions {
  /** `G...` address of the keeper. Must authorize the call. */
  keeper: string;
  /** Amount to unbond, in the reward token's own units. `i128`, so `bigint`. */
  amount: IntegerInput;
}

/**
 * Starts the unbonding delay for `amount` of `keeper`'s stake.
 *
 * Only one unbond request may be pending per keeper at a time; a second call
 * while one is outstanding rejects with {@link KeeperErrorCode.UnbondAlreadyPending}
 * rather than merging or replacing it -- withdraw the first before starting
 * another. The unbonding amount leaves the effective (claim-gating) stake
 * immediately, well before the delay elapses -- see {@link keeperStake}.
 */
export async function initiateUnbond(
  caller: ContractCaller,
  params: InitiateUnbondParams,
): Promise<void> {
  const { keeper, signer } = params;
  const amount = i128Arg(params.amount, "amount");

  await caller.invoke<void>({
    method: "initiate_unbond",
    source: keeper,
    args: [addressArg(keeper, "keeper"), amount],
    ...(signer ? { signer } : {}),
  });
}

// -- withdraw_stake -------------------------------------------------------------

export interface WithdrawStakeParams extends SignedCallOptions {
  /** `G...` address of the keeper. Must authorize the call. */
  keeper: string;
}

/**
 * Releases `keeper`'s pending unbond request once the delay has elapsed.
 *
 * The boundary is inclusive: at exactly the request's unlock ledger, the
 * request is already withdrawable, mirroring the contract's own `>=`
 * convention (docs/STAKING_DESIGN.md §3). Rejects with
 * {@link KeeperErrorCode.UnbondNotReady} if called before that, or
 * {@link KeeperErrorCode.NoPendingUnbond} if there is no pending request at all.
 *
 * @returns the amount released.
 */
export async function withdrawStake(
  caller: ContractCaller,
  params: WithdrawStakeParams,
): Promise<bigint> {
  const { keeper, signer } = params;

  return caller.invoke<bigint>({
    method: "withdraw_stake",
    source: keeper,
    args: [addressArg(keeper, "keeper")],
    ...(signer ? { signer } : {}),
  });
}

// -- slash -------------------------------------------------------------

export interface SlashParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** `G...` address of the keeper being slashed. */
  keeper: string;
  /** Amount to slash, in the reward token's own units. `i128`, so `bigint`. */
  amount: IntegerInput;
  /**
   * Reason recorded on the slash and emitted in the `Slashed` event. A
   * Soroban `Symbol`: 1-32 characters from `[a-zA-Z0-9_]`, not free text.
   */
  reason: string;
  /** `G...` or `C...` address the slashed amount is sent to. */
  treasury: string;
}

/**
 * Admin-authorized reduction of `keeper`'s collateral (docs/STAKING_DESIGN.md
 * §4-5 -- dispute-based, not automatic: epic E04's on-chain verifier work
 * never landed, so there is no on-chain check that can trigger this).
 *
 * `amount` may draw from `keeper`'s bonded stake plus anything sitting in a
 * pending unbond request, not the bonded stake alone -- unbonding does not
 * let a keeper evade a slash by front-running it with `initiate_unbond`
 * (docs/STAKING_SECURITY_REVIEW.md, "Unbonding as a slash-evasion path").
 * Rejects with {@link KeeperErrorCode.InsufficientStake} if `amount` exceeds
 * that combined total.
 *
 * @returns the new slash's id, for later reference by {@link raiseSlashAppeal}.
 */
export async function slash(caller: ContractCaller, params: SlashParams): Promise<bigint> {
  const { admin, keeper, reason, treasury, signer } = params;
  const amount = i128Arg(params.amount, "amount");

  if (typeof params.amount === "bigint" ? params.amount <= 0n : params.amount <= 0) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidReward,
      `amount must be a positive number of token units, got ${params.amount}.`,
      { local: true },
    );
  }

  return caller.invoke<bigint>({
    method: "slash",
    source: admin,
    args: [
      addressArg(admin, "admin"),
      addressArg(keeper, "keeper"),
      amount,
      symbolArg(reason, "reason"),
      addressArg(treasury, "treasury"),
    ],
    ...(signer ? { signer } : {}),
  });
}

// -- set_min_stake -------------------------------------------------------------

export interface SetMinStakeParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** New minimum bonded stake `claim_task` requires. `i128`, so `bigint`. `0n` disables the check. */
  minStake: IntegerInput;
}

/**
 * Sets the minimum bonded stake `claim_task` requires (docs/STAKING_DESIGN.md
 * §6). Default `0n` -- no requirement -- mirroring `set_min_reward`'s pattern
 * for the task-side floor. Existing claims are unaffected; only future
 * `claim_task` calls are validated against the new value.
 */
export async function setMinStake(
  caller: ContractCaller,
  params: SetMinStakeParams,
): Promise<void> {
  const { admin, signer } = params;
  const minStake = i128Arg(params.minStake, "minStake");

  await caller.invoke<void>({
    method: "set_min_stake",
    source: admin,
    args: [addressArg(admin, "admin"), minStake],
    ...(signer ? { signer } : {}),
  });
}

// -- raise_slash_appeal / resolve_slash_appeal --------------------------------

export interface RaiseSlashAppealParams extends SignedCallOptions {
  /** `G...` address of the slashed keeper. Must authorize the call. */
  keeper: string;
  /** Id of the slash to appeal, from {@link slash}'s return value. */
  slashId: IntegerInput;
}

/**
 * Appeals a slash. Only the slashed keeper itself has standing
 * (docs/STAKING_DESIGN.md §4.1). Must be called within the admin-configured
 * dispute window of the slash, and at most once per `slashId`; rejects with
 * {@link KeeperErrorCode.AppealWindowClosed} or
 * {@link KeeperErrorCode.AppealAlreadyRaised} respectively.
 *
 * Raising an appeal does not by itself reverse anything -- it flags the
 * record for the admin to resolve via {@link resolveSlashAppeal}.
 */
export async function raiseSlashAppeal(
  caller: ContractCaller,
  params: RaiseSlashAppealParams,
): Promise<void> {
  const { keeper, signer } = params;
  const slashId = u64Arg(params.slashId, "slashId");

  await caller.invoke<void>({
    method: "raise_slash_appeal",
    source: keeper,
    args: [addressArg(keeper, "keeper"), slashId],
    ...(signer ? { signer } : {}),
  });
}

export interface ResolveSlashAppealParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** Id of the slash whose appeal is being resolved. */
  slashId: IntegerInput;
  /**
   * `true` refunds the slashed amount and restores the keeper's stake --
   * the admin must fund the refund itself, since the contract no longer
   * holds the slashed amount (it already moved to the treasury address at
   * slash time). `false` leaves the slash standing with no transfer.
   */
  upholdAppeal: boolean;
}

/**
 * Admin-only resolution of a raised appeal. Either way the appeal is
 * considered resolved and its record is removed, so it cannot be
 * re-resolved -- a second call for the same `slashId` rejects with
 * {@link KeeperErrorCode.SlashNotFound}.
 */
export async function resolveSlashAppeal(
  caller: ContractCaller,
  params: ResolveSlashAppealParams,
): Promise<void> {
  const { admin, upholdAppeal, signer } = params;
  const slashId = u64Arg(params.slashId, "slashId");

  await caller.invoke<void>({
    method: "resolve_slash_appeal",
    source: admin,
    args: [addressArg(admin, "admin"), slashId, boolArg(upholdAppeal)],
    ...(signer ? { signer } : {}),
  });
}

// -- set_dispute_window ---------------------------------------------------------

export interface SetDisputeWindowParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** New execution-dispute hold, in ledgers. `0` disables it (default). */
  ledgers: number;
}

/**
 * Sets how long a freshly `execute_task`-credited reward is held before
 * `withdraw_rewards` will pay it out (docs/STAKING_DESIGN.md §4.2). Default
 * `0` -- disabled, the unchanged wave-1 MVP behavior of immediate
 * withdrawability. Only affects credits from executions after this call;
 * already-pending credits keep the unlock ledger they were given.
 */
export async function setDisputeWindow(
  caller: ContractCaller,
  params: SetDisputeWindowParams,
): Promise<void> {
  const { admin, signer } = params;
  const ledgers = u32Arg(params.ledgers, "ledgers");

  await caller.invoke<void>({
    method: "set_dispute_window",
    source: admin,
    args: [addressArg(admin, "admin"), ledgers],
    ...(signer ? { signer } : {}),
  });
}

// -- dispute_execution / resolve_execution_dispute ------------------------------

export interface DisputeExecutionParams extends SignedCallOptions {
  /** `G...` address of the task's owner. Must authorize the call. */
  owner: string;
  /** Id of the task whose still-pending credit is being disputed. */
  taskId: IntegerInput;
}

/**
 * Disputes an executed task's still-pending credit, before it finalizes into
 * the keeper's withdrawable balance. Only the task's own owner has standing
 * (mirrors `cancel_task`'s owner-only authorization). Rejects with
 * {@link KeeperErrorCode.DisputeWindowClosed} once the credit's unlock ledger
 * has already passed.
 */
export async function disputeExecution(
  caller: ContractCaller,
  params: DisputeExecutionParams,
): Promise<void> {
  const { owner, signer } = params;
  const taskId = u64Arg(params.taskId, "taskId");

  await caller.invoke<void>({
    method: "dispute_execution",
    source: owner,
    args: [addressArg(owner, "owner"), taskId],
    ...(signer ? { signer } : {}),
  });
}

export interface ResolveExecutionDisputeParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** Id of the disputed task. */
  taskId: IntegerInput;
  /**
   * `true` removes the pending credit without ever crediting the keeper's
   * reward balance -- the reward is simply never paid; the admin is expected
   * to follow up with a separate {@link slash} call if the underlying
   * misbehavior warrants it. `false` clears the disputed flag, returning the
   * credit to the normal finalization path once its unlock ledger passes.
   */
  upholdDispute: boolean;
}

/** Admin-only resolution of a raised execution dispute. */
export async function resolveExecutionDispute(
  caller: ContractCaller,
  params: ResolveExecutionDisputeParams,
): Promise<void> {
  const { admin, upholdDispute, signer } = params;
  const taskId = u64Arg(params.taskId, "taskId");

  await caller.invoke<void>({
    method: "resolve_execution_dispute",
    source: admin,
    args: [addressArg(admin, "admin"), taskId, boolArg(upholdDispute)],
    ...(signer ? { signer } : {}),
  });
}

// -- read-only views -------------------------------------------------------------

/**
 * A keeper's current bonded stake (`0n` if never deposited or fully
 * withdrawn). Excludes anything currently mid-unbond -- that amount is still
 * part of the total until {@link withdrawStake} actually releases it (still
 * slashable, still counted toward the contract's solvency invariant).
 */
export async function keeperStake(caller: ContractCaller, keeper: string): Promise<bigint> {
  return BigInt(
    await caller.read<bigint | number>("keeper_stake", [addressArg(keeper, "keeper")]),
  );
}

/** Raw shape `scValToNative` produces for the contract's `UnbondRequest` struct. */
interface RawUnbondRequest {
  amount: bigint;
  unlock_ledger: number | bigint;
}

/** A keeper's pending unbond request, if any. */
export async function pendingUnbond(
  caller: ContractCaller,
  keeper: string,
): Promise<UnbondRequest | undefined> {
  const raw = await caller.read<RawUnbondRequest | null | undefined>("pending_unbond", [
    addressArg(keeper, "keeper"),
  ]);
  if (raw === null || raw === undefined) return undefined;
  return { amount: BigInt(raw.amount), unlockLedger: Number(raw.unlock_ledger) };
}

/**
 * The minimum bonded stake `claim_task` requires (`0n` if unset -- no
 * requirement).
 */
export async function minStake(caller: ContractCaller): Promise<bigint> {
  return BigInt(await caller.read<bigint | number>("min_stake"));
}

/** Raw shape `scValToNative` produces for the contract's `SlashRecord` struct. */
interface RawSlashRecord {
  keeper: string;
  amount: bigint;
  reason: string;
  ledger: number | bigint;
  appealed: boolean;
}

/**
 * A specific slash record by id, if it still exists. A resolved appeal
 * removes its record -- see {@link resolveSlashAppeal} -- so this returns
 * `undefined` for a `slashId` that was either never issued or already
 * appeal-resolved.
 */
export async function getSlash(
  caller: ContractCaller,
  slashId: IntegerInput,
): Promise<SlashRecord | undefined> {
  const raw = await caller.read<RawSlashRecord | null | undefined>("get_slash", [
    u64Arg(slashId, "slashId"),
  ]);
  if (raw === null || raw === undefined) return undefined;
  return {
    keeper: raw.keeper,
    amount: BigInt(raw.amount),
    reason: raw.reason,
    ledger: Number(raw.ledger),
    appealed: raw.appealed,
  };
}

/**
 * A keeper's aggregate slash history: `{ count, totalSlashed }`, both zero if
 * the keeper has never been slashed. Lets a dashboard or keeper bot read a
 * keeper's track record without replaying every `Slashed` event.
 */
export async function slashHistory(
  caller: ContractCaller,
  keeper: string,
): Promise<{ count: number; totalSlashed: bigint }> {
  const [count, totalSlashed] = await caller.read<[number | bigint, bigint | number]>(
    "slash_history",
    [addressArg(keeper, "keeper")],
  );
  return { count: Number(count), totalSlashed: BigInt(totalSlashed) };
}

/**
 * Ledgers a freshly `execute_task`-credited reward is held before it becomes
 * withdrawable (`0` if unset -- disabled).
 */
export async function disputeWindow(caller: ContractCaller): Promise<number> {
  return Number(await caller.read<number | bigint>("dispute_window"));
}

/** Raw shape `scValToNative` produces for the contract's `PendingCredit` struct. */
interface RawPendingCredit {
  task_id: number | bigint;
  net_reward: bigint;
  unlock_ledger: number | bigint;
  disputed: boolean;
}

/**
 * A keeper's not-yet-finalized `execute_task` credits, ordered by unlock
 * ledger. Empty once every credit for this keeper has either finalized into
 * the reward balance or been disputed away.
 */
export async function pendingReward(
  caller: ContractCaller,
  keeper: string,
): Promise<PendingCredit[]> {
  const raw = await caller.read<RawPendingCredit[]>("pending_reward", [
    addressArg(keeper, "keeper"),
  ]);
  return raw.map((credit) => ({
    taskId: Number(credit.task_id),
    netReward: BigInt(credit.net_reward),
    unlockLedger: Number(credit.unlock_ledger),
    disputed: credit.disputed,
  }));
}
