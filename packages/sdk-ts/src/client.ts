/**
 * `KeeperRegistryClient` -- the shared plumbing every typed method in this SDK
 * is built on, plus the thin delegations that expose them.
 *
 * The keeper-bot example hand-rolls the same simulate/build/sign/submit dance
 * in `invokeContract`/`readContract`. This class implements that split exactly
 * once -- a free read path and a signing write path -- so a per-entry-point
 * wrapper in `src/methods/` is argument conversion and nothing else.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Operation,
  StrKey,
  type Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { ContractCaller, TransactionSigner } from "./core/caller.js";
import { KeeperRpcError, KeeperSdkError, toKeeperError } from "./errors.js";
import type { IntegerInput } from "./core/scval.js";
import type { Task } from "./types.js";
import type { ContractCompatibility, VersionOptions } from "./methods/views.js";
import * as views from "./methods/views.js";
import type { WithdrawRewardsParams } from "./methods/withdrawRewards.js";
import { tryWithdrawRewards, withdrawRewards } from "./methods/withdrawRewards.js";
import type { ExecuteTaskParams } from "./methods/executeTask.js";
import type { AuthEntrySigner } from "./core/auth.js";
import { signAuthEntries } from "./core/auth.js";
import { executeTask } from "./methods/executeTask.js";
import type { RegisterTaskParams } from "./methods/registerTask.js";
import { registerTask } from "./methods/registerTask.js";
import type { IncreaseRewardParams } from "./methods/increaseReward.js";
import { increaseReward } from "./methods/increaseReward.js";
import type { ExtendDeadlineParams } from "./methods/extendDeadline.js";
import { extendDeadline } from "./methods/extendDeadline.js";
import type { ClaimTaskOutcome, ClaimTaskParams } from "./methods/claimTask.js";
import { claimTask } from "./methods/claimTask.js";
import type { CancelTaskOutcome, CancelTaskParams } from "./methods/cancelTask.js";
import { cancelTask } from "./methods/cancelTask.js";
import type { ExpireTaskParams } from "./methods/expireTask.js";
import { expireTask } from "./methods/expireTask.js";
import type {
  SweepFeesParams,
  TransferAdminParams,
  UpgradeParams,
} from "./methods/adminDualAuth.js";
import { sweepFees, transferAdmin, upgrade } from "./methods/adminDualAuth.js";
import type {
  AdminCallParams,
  SetFeeBpsParams,
  SetMinRewardParams,
} from "./methods/admin.js";
import { pause, setFeeBps, setMinReward, unpause } from "./methods/admin.js";

/**
 * The subset of `rpc.Server` this SDK uses.
 *
 * Declared structurally so tests (and any caller with its own transport) can
 * substitute a stand-in without a live network, and so the SDK does not depend
 * on parts of the RPC surface it never calls.
 */
export type RpcServerLike = Pick<
  rpc.Server,
  | "getAccount"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getLatestLedger"
  | "getEvents"
>;

/** Minimal `Keypair` surface, so callers need not import the class type. */
interface KeypairLike {
  publicKey(): string;
  sign(data: Buffer): Buffer;
}

/**
 * Adapts a `Keypair` (or anything with the same shape) to a
 * `TransactionSigner`, for Node-side callers holding a secret key.
 */
export function keypairSigner(keypair: KeypairLike): TransactionSigner {
  return {
    publicKey: keypair.publicKey(),
    signTransaction(xdrBase64, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(xdrBase64, networkPassphrase);
      tx.sign(keypair as never);
      return tx.toXDR();
    },
  };
}

export interface KeeperRegistryClientOptions {
  /** `C...` address of the deployed keeper-registry contract. */
  contractId: string;
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl?: string | undefined;
  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Default signer for state-changing calls; a per-call `signer` overrides it. */
  signer?: TransactionSigner | undefined;
  /** Base fee in stroops for built transactions. Defaults to `BASE_FEE`. */
  fee?: string | undefined;
  /** Transaction validity window in seconds. Defaults to 30. */
  timeoutSeconds?: number | undefined;
  /** How long to wait for a submitted transaction to leave `PENDING`. */
  confirmationTimeoutMs?: number | undefined;
  /** Delay between confirmation polls. */
  pollIntervalMs?: number | undefined;
  /**
   * Pre-built RPC server. Supplying one skips constructing a `rpc.Server` from
   * `rpcUrl` -- the seam this package's tests use to run without a network.
   */
  server?: RpcServerLike | undefined;
  /** Sink for non-fatal warnings. Defaults to `console.warn`. */
  warn?: ((message: string) => void) | undefined;
}

/**
 * Source account used for read-only simulations.
 *
 * Views are simulated, never submitted, so the source is never charged and
 * never needs to exist on-chain. Using a fixed all-zero account rather than the
 * caller's own means a view works against a freshly deployed registry from a
 * machine holding no funded key at all -- which is exactly the case
 * `admin()`-on-an-uninitialized-registry has to serve.
 */
/**
 * How long a signed auth entry stays valid, in ledgers (~5s each, so ~1 hour).
 * Long enough to survive submission and retry, short enough that a signature
 * captured off the wire is not reusable indefinitely.
 */
const AUTH_ENTRY_VALIDITY_LEDGERS = 720;

const READ_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class KeeperRegistryClient implements ContractCaller {
  readonly contractId: string;
  readonly networkPassphrase: string;

  private readonly contract: Contract;
  private readonly server: RpcServerLike;
  private readonly defaultSigner: TransactionSigner | undefined;
  private readonly fee: string;
  private readonly timeoutSeconds: number;
  private readonly confirmationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly warnSink: (message: string) => void;

  constructor(options: KeeperRegistryClientOptions) {
    // Fail fast and locally. A malformed contract id or an empty passphrase
    // otherwise surfaces much later as an opaque RPC rejection, on a call the
    // caller has already paid to build.
    if (!StrKey.isValidContract(options.contractId)) {
      throw new KeeperSdkError(
        `Invalid contract id ${JSON.stringify(options.contractId)}: expected a C... Soroban contract address.`,
      );
    }
    if (!options.networkPassphrase) {
      throw new KeeperSdkError("networkPassphrase is required.");
    }
    if (!options.server && !options.rpcUrl) {
      throw new KeeperSdkError("rpcUrl is required unless a server is supplied.");
    }

    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase;
    this.contract = new Contract(options.contractId);
    this.server = options.server ?? new rpc.Server(options.rpcUrl as string);
    this.defaultSigner = options.signer;
    this.fee = options.fee ?? BASE_FEE;
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.warnSink = options.warn ?? ((message: string) => console.warn(message));
  }

  // -- typed entry points ----------------------------------------------------

  /** See {@link views.admin}. */
  admin(): Promise<string | undefined> {
    return views.admin(this);
  }

  /** See {@link views.getFeeBps}. */
  getFeeBps(): Promise<number> {
    return views.getFeeBps(this);
  }

  /** See {@link views.isPaused}. */
  isPaused(): Promise<boolean> {
    return views.isPaused(this);
  }

  /** See {@link views.feesAccrued}. */
  feesAccrued(): Promise<bigint> {
    return views.feesAccrued(this);
  }

  /** See {@link views.rewardTokenAddress}. */
  rewardTokenAddress(): Promise<string | undefined> {
    return views.rewardTokenAddress(this);
  }

  /** See {@link views.minReward}. */
  minReward(): Promise<bigint> {
    return views.minReward(this);
  }

  /** See {@link views.version}. Warns if the contract is outside this SDK's range. */
  version(options?: VersionOptions): Promise<number> {
    return views.version(this, options);
  }

  /** See {@link views.checkContractCompatibility}. */
  checkContractCompatibility(): Promise<ContractCompatibility> {
    return views.checkContractCompatibility(this);
  }

  /** See {@link views.getTask}. */
  getTask(taskId: IntegerInput): Promise<Task> {
    return views.getTask(this, taskId);
  }

  /** See {@link views.taskCount}. */
  taskCount(): Promise<number> {
    return views.taskCount(this);
  }

  /** See {@link views.keeperBalance}. */
  keeperBalance(keeper: string): Promise<bigint> {
    return views.keeperBalance(this, keeper);
  }

  /** See {@link views.isClaimable}. */
  isClaimable(taskId: IntegerInput): Promise<boolean> {
    return views.isClaimable(this, taskId);
  }

  /** See {@link transferAdmin}. */
  transferAdmin(params: TransferAdminParams): Promise<void> {
    return transferAdmin(this, params);
  }

  /** See {@link upgrade}. */
  upgrade(params: UpgradeParams): Promise<void> {
    return upgrade(this, params);
  }

  /** See {@link sweepFees}. */
  sweepFees(params: SweepFeesParams): Promise<void> {
    return sweepFees(this, params);
  }

  /** See {@link pause}. */
  pause(params: AdminCallParams): Promise<void> {
    return pause(this, params);
  }

  /** See {@link unpause}. */
  unpause(params: AdminCallParams): Promise<void> {
    return unpause(this, params);
  }

  /** See {@link setFeeBps}. */
  setFeeBps(params: SetFeeBpsParams): Promise<void> {
    return setFeeBps(this, params);
  }

  /** See {@link setMinReward}. */
  setMinReward(params: SetMinRewardParams): Promise<void> {
    return setMinReward(this, params);
  }

  /** See {@link withdrawRewards}. */
  withdrawRewards(params: WithdrawRewardsParams): Promise<bigint> {
    return withdrawRewards(this, params);
  }

  /** See {@link tryWithdrawRewards}: resolves to `0n` instead of rejecting. */
  tryWithdrawRewards(params: WithdrawRewardsParams): Promise<bigint> {
    return tryWithdrawRewards(this, params);
  }

  /** See {@link executeTask}. */
  executeTask(params: ExecuteTaskParams): Promise<void> {
    return executeTask(this, params);
  }

  /** See {@link registerTask}. */
  registerTask(params: RegisterTaskParams): Promise<bigint> {
    return registerTask(this, params);
  }

  /** See {@link increaseReward}. */
  increaseReward(params: IncreaseRewardParams): Promise<void> {
    return increaseReward(this, params);
  }

  /** See {@link extendDeadline}. */
  extendDeadline(params: ExtendDeadlineParams): Promise<void> {
    return extendDeadline(this, params);
  }

  /** See {@link claimTask}: routine claim-race outcomes are returned, not thrown. */
  claimTask(params: ClaimTaskParams): Promise<ClaimTaskOutcome> {
    return claimTask(this, params);
  }

  /** See {@link cancelTask}: a live lock and a terminal status are returned, not thrown. */
  cancelTask(params: CancelTaskParams): Promise<CancelTaskOutcome> {
    return cancelTask(this, params);
  }

  /** See {@link expireTask}. */
  expireTask(params: ExpireTaskParams): Promise<void> {
    return expireTask(this, params);
  }

  // -- shared plumbing -------------------------------------------------------

  /**
   * Simulates a read-only entry point and returns its decoded return value.
   *
   * Free: nothing is signed or submitted.
   *
   * @internal Plumbing for the wrappers above; not a supported entry point.
   */
  async read<T>(method: string, args: xdr.ScVal[] = []): Promise<T> {
    const context = `${method} simulation failed`;
    const account = new Account(READ_SOURCE_ACCOUNT, "0");
    const tx = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(tx);
    } catch (cause) {
      throw toKeeperError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toKeeperError(simulation.error, context);
    }
    const result = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result;
    return result ? (scValToNative(result.retval) as T) : (undefined as T);
  }

  /**
   * Simulates, signs, submits, and confirms a state-changing entry point, then
   * returns its decoded return value (`undefined` for the void ones).
   *
   * Simulation runs first so a call the contract would reject costs a failed
   * simulation rather than a submitted transaction and its fee.
   *
   * @internal Plumbing for the wrappers above; not a supported entry point.
   */
  async invoke<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    /** Address that must authorize; also the transaction source. */
    source: string;
    signer?: TransactionSigner;
  }): Promise<T> {
    const { method, args = [], source } = params;
    const context = `${method} failed`;
    const signer = this.resolveSigner(method, source, params.signer);

    const account = await this.loadAccount(source, context);
    const built = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(built);
    } catch (cause) {
      throw toKeeperError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toKeeperError(simulation.error, context);
    }

    const prepared = rpc.assembleTransaction(built, simulation).build();
    const signedXdr = await signer.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(signed as never);
    } catch (cause) {
      throw toKeeperError(cause, context);
    }
    if (sent.status !== "PENDING") {
      throw toKeeperError(sent.errorResult ?? `submission returned ${sent.status}`, context);
    }

    return this.confirm<T>(sent.hash, context);
  }

  /**
   * Like {@link invoke}, but additionally signs the Soroban auth entries that
   * require an address other than the source account.
   *
   * Only `transfer_admin` needs this today. The flow differs from `invoke` in
   * one place: after simulation reports which addresses must authorize, each
   * matching entry is signed and the transaction is *rebuilt* carrying those
   * signed entries, because auth entries are part of the operation and cannot
   * be attached to an already-built transaction.
   *
   * @internal Plumbing for the wrappers above; not a supported entry point.
   */
  async invokeMultiAuth<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    source: string;
    signer?: TransactionSigner;
    /** Signers for every address the call requires, including the source. */
    authSigners: readonly AuthEntrySigner[];
  }): Promise<T> {
    const { method, args = [], source, authSigners } = params;
    const context = `${method} failed`;
    const signer = this.resolveSigner(method, source, params.signer);

    const account = await this.loadAccount(source, context);
    // `build()` advances the local sequence counter, so the rebuild below needs
    // the value from before the first build, not the mutated one.
    const startingSequence = account.sequenceNumber();
    const built = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(built);
    } catch (cause) {
      throw toKeeperError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toKeeperError(simulation.error, context);
    }

    const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
    const entries = success.result?.auth ?? [];

    let validUntilLedgerSeq: number;
    try {
      validUntilLedgerSeq =
        (await this.server.getLatestLedger()).sequence + AUTH_ENTRY_VALIDITY_LEDGERS;
    } catch (cause) {
      throw toKeeperError(cause, context);
    }

    const signedAuth = await signAuthEntries(
      entries,
      authSigners,
      validUntilLedgerSeq,
      this.networkPassphrase,
      method,
    );

    const rebuilt = new TransactionBuilder(new Account(source, startingSequence), {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: (built.operations[0] as Operation.InvokeHostFunction).func,
          auth: signedAuth,
        }),
      )
      .setTimeout(this.timeoutSeconds)
      .build();

    const prepared = rpc.assembleTransaction(rebuilt, simulation).build();
    const signedXdr = await signer.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(signed as never);
    } catch (cause) {
      throw toKeeperError(cause, context);
    }
    if (sent.status !== "PENDING") {
      throw toKeeperError(sent.errorResult ?? `submission returned ${sent.status}`, context);
    }

    return this.confirm<T>(sent.hash, context);
  }

  /** @internal Non-fatal diagnostics sink. */
  warn(message: string): void {
    this.warnSink(message);
  }

  private resolveSigner(
    method: string,
    source: string,
    override: TransactionSigner | undefined,
  ): TransactionSigner {
    const signer = override ?? this.defaultSigner;
    if (!signer) {
      throw new KeeperSdkError(
        `${method} is a state-changing call and needs a signer: pass one to the client constructor or to this call.`,
      );
    }
    if (signer.publicKey !== source) {
      // Silently signing with a different key produces a transaction that is
      // valid but fails the contract's require_auth, spending a fee on a
      // failure whose real cause is invisible in the result.
      throw new KeeperSdkError(
        `${method} must be authorized by ${source}, but the available signer is ${signer.publicKey}.`,
      );
    }
    return signer;
  }

  private async loadAccount(source: string, context: string): Promise<Account> {
    if (!StrKey.isValidEd25519PublicKey(source)) {
      throw new KeeperSdkError(
        `Invalid account address ${JSON.stringify(source)}: expected a G... Stellar address.`,
      );
    }
    try {
      return await this.server.getAccount(source);
    } catch (cause) {
      throw toKeeperError(cause, `${context} (could not load source account ${source})`);
    }
  }

  private buildTransaction(account: Account, method: string, args: xdr.ScVal[]) {
    return new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(this.timeoutSeconds)
      .build();
  }

  /** Polls until the submitted transaction leaves `NOT_FOUND`/`PENDING`. */
  private async confirm<T>(hash: string, context: string): Promise<T> {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    for (;;) {
      let result: rpc.Api.GetTransactionResponse;
      try {
        result = await this.server.getTransaction(hash);
      } catch (cause) {
        throw toKeeperError(cause, context);
      }

      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result.returnValue ? (scValToNative(result.returnValue) as T) : (undefined as T);
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        // A transaction that failed on-chain carries the contract's
        // Result::Err in its diagnostic events; hand the whole response to the
        // decoder rather than guessing which field this RPC version populated.
        throw toKeeperError(result, context);
      }
      if (Date.now() >= deadline) {
        throw new KeeperRpcError(
          `${context}: transaction ${hash} was still ${result.status} after ${this.confirmationTimeoutMs}ms. It may still succeed; re-check with getTransaction("${hash}").`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** @internal Simulates and assembles `method(args)` from `source`, without signing or submitting — the seam {@link "./transactionBuilder.js"} builds unsigned transactions on. */
  async buildAssembledTransaction(
    source: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<Transaction> {
    const context = `${method} simulation failed`;
    const account = await this.loadAccount(source, context);
    const built = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(built);
    } catch (cause) {
      throw toKeeperError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toKeeperError(simulation.error, context);
    }
    return rpc.assembleTransaction(built, simulation).build();
  }

  /** @internal The underlying RPC server — escape hatch for {@link "./transactionBuilder.js"}'s submit path. */
  getServer(): RpcServerLike {
    return this.server;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
