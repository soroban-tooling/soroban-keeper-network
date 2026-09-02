/**
 * The remaining admin entry points.
 *
 * `transfer_admin` is the one method in this SDK with a materially different
 * signing shape: the contract calls `require_auth` on both the outgoing and the
 * incoming admin (see `contracts/keeper-registry/src/lib.rs`), so it needs two
 * signatures in one transaction and goes through `invokeMultiAuth`. `upgrade`
 * and `sweepFees` are ordinary single-auth calls, grouped here because all
 * three are the admin surface left over from the single-auth set (#230).
 */

import type { AuthEntrySigner } from "../core/auth.js";
import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, bytesN32Arg, i128Arg, toBigInt } from "../core/scval.js";
import { KeeperContractError, KeeperErrorCode } from "../errors.js";

export interface TransferAdminParams extends SignedCallOptions {
  /** `G...` of the current admin. Also the transaction source, so it pays the fee. */
  currentAdmin: string;
  /** `G...` of the incoming admin. Must separately consent to taking the role. */
  newAdmin: string;
  /**
   * Auth-entry signers covering both addresses.
   *
   * Required, and separate from `signer`: the envelope signature satisfies only
   * the source account, so the incoming admin's consent has to be supplied as
   * its own auth-entry signature. Use `keypairAuthSigner` for a Node caller
   * holding the keys.
   */
  authSigners: readonly AuthEntrySigner[];
}

export interface UpgradeParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** Hash of the already-installed replacement WASM. Exactly 32 bytes. */
  newWasmHash: Uint8Array;
}

export interface SweepFeesParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
  /** `G...` or `C...` address the swept fees are sent to. */
  treasury: string;
  /** Amount to sweep, in the reward token's own units. `i128`, so `bigint`. */
  amount: IntegerInput;
}

/**
 * Hands the admin role to `newAdmin`.
 *
 * Both parties sign: the contract will not transfer the role to an address that
 * has not itself authorized taking it, which is what makes an accidental
 * lock-out impossible. A missing signature for either address is caught before
 * submission -- see `signAuthEntries` -- rather than costing a fee on a
 * transaction that fails `require_auth`.
 */
export async function transferAdmin(
  caller: ContractCaller,
  params: TransferAdminParams,
): Promise<void> {
  const { currentAdmin, newAdmin, authSigners, signer } = params;

  await caller.invokeMultiAuth<void>({
    method: "transfer_admin",
    source: currentAdmin,
    args: [addressArg(currentAdmin, "currentAdmin"), addressArg(newAdmin, "newAdmin")],
    authSigners,
    ...(signer ? { signer } : {}),
  });
}

/**
 * Swaps the contract's WASM for a hash already installed on-chain.
 *
 * `newWasmHash` is length-checked locally by {@link bytesN32Arg}: the
 * contract's parameter is a `BytesN<32>`, and a wrong-length value would
 * otherwise surface as an opaque XDR encoding failure rather than a clear
 * statement of which argument was wrong.
 */
export async function upgrade(caller: ContractCaller, params: UpgradeParams): Promise<void> {
  const { admin, newWasmHash, signer } = params;

  await caller.invoke<void>({
    method: "upgrade",
    source: admin,
    args: [addressArg(admin, "admin"), bytesN32Arg(newWasmHash, "newWasmHash")],
    ...(signer ? { signer } : {}),
  });
}

/**
 * Moves up to the accrued protocol fees to `treasury`.
 *
 * Two conditions the contract also enforces are checked first, because neither
 * can ever succeed and both are cheaper to answer here: a non-positive amount
 * needs no network call at all, and an amount above what has actually accrued
 * needs one free `fees_accrued` simulation instead of a submitted transaction.
 * Both raise the discriminant the contract itself would have returned, with
 * `local` set, so a caller branches on one code either way.
 *
 * The accrued balance can change between that read and the sweep; this is a
 * fast, cheap rejection of the obviously-impossible, not a guarantee, and the
 * contract remains the authority.
 */
export async function sweepFees(caller: ContractCaller, params: SweepFeesParams): Promise<void> {
  const { admin, treasury, signer } = params;
  const amount = toBigInt(params.amount, "amount");

  if (amount <= 0n) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidReward,
      `amount must be a positive number of token units, got ${amount}.`,
      { local: true },
    );
  }

  const accrued = await caller.read<bigint>("fees_accrued");
  if (amount > accrued) {
    throw new KeeperContractError(
      KeeperErrorCode.NoRewardsAvailable,
      `amount ${amount} exceeds the ${accrued} currently accrued in protocol fees.`,
      { local: true },
    );
  }

  await caller.invoke<void>({
    method: "sweep_fees",
    source: admin,
    args: [addressArg(admin, "admin"), addressArg(treasury, "treasury"), i128Arg(amount, "amount")],
    ...(signer ? { signer } : {}),
  });
}
