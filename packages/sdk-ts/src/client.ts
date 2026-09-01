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
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { ContractCaller, TransactionSigner } from "./core/caller.js";
import { KeeperRpcError, KeeperSdkError, toKeeperError } from "./errors.js";
import type { ContractCompatibility, VersionOptions } from "./methods/views.js";
import * as views from "./methods/views.js";
import type { WithdrawRewardsParams } from "./methods/withdrawRewards.js";
import { tryWithdrawRewards, withdrawRewards } from "./methods/withdrawRewards.js";
import type { ExecuteTaskParams } from "./methods/executeTask.js";
import { executeTask } from "./methods/executeTask.js";

/**
 * The subset of `rpc.Server` this SDK uses.
 *
 * Declared structurally so tests (and any caller with its own transport) can
 * substitute a stand-in without a live network, and so the SDK does not depend
 * on parts of the RPC surface it never calls.
 */
export type RpcServerLike = Pick<
  rpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction"
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
  /** See {@link withdrawRewards}. */
  withdrawRewards(params: WithdrawRewardsParams): Promise<bigint> {
    return withdrawRewards(this, params);
  }

  /** See {@link tryWithdrawRewards}: resolves to `0n` instead of rejecting. */
  tryWithdrawRewards(params: WithdrawRewardsParams): Promise<bigint> {
    return tryWithdrawRewards(this, params);
  /** See {@link executeTask}. */
  executeTask(params: ExecuteTaskParams): Promise<void> {
    return executeTask(this, params);
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
// The core of the SDK: a typed client wrapping the repetitive
// simulate-build-sign-submit dance the keeper-bot example currently
// hand-rolls. See backlog 0153.

import { StrKey } from "@stellar/stellar-sdk";

import { ContractInvoker } from "./core/contractInvoker";
import { decodeKeeperError, KeeperContractError, TaskNotFoundError } from "./errors";
import { getTask } from "./methods/views";
import { buildFeeBumpTransaction, buildTransaction, submitSignedTransaction } from "./transactionBuilder";
import type { KeeperRegistryClientConfig, Task } from "./types";

/**
 * Typed client for the keeper-registry contract. Constructor validates its
 * inputs so a malformed contract address or network passphrase fails fast
 * with a clear error, rather than surfacing as an opaque RPC failure later.
 *
 * ```ts
 * const client = new KeeperRegistryClient({ contractId, rpcUrl, networkPassphrase });
 * const task = await client.getTask(taskId);
 * ```
 */
export class KeeperRegistryClient {
  readonly config: KeeperRegistryClientConfig;
  /** @internal exposed for `methods/*` and `transactionBuilder.ts`, not part of the public API. */
  readonly invoker: ContractInvoker;

  constructor(config: KeeperRegistryClientConfig) {
    if (!StrKey.isValidContract(config.contractId)) {
      throw new Error(`KeeperRegistryClient: "${config.contractId}" is not a valid Soroban contract address (expected a "C..." StrKey).`);
    }
    if (!config.rpcUrl || !/^https?:\/\//.test(config.rpcUrl)) {
      throw new Error(`KeeperRegistryClient: "${config.rpcUrl}" is not a valid RPC URL.`);
    }
    if (!config.networkPassphrase) {
      throw new Error("KeeperRegistryClient: networkPassphrase is required.");
    }

    this.config = config;
    this.invoker = new ContractInvoker(config);
  }

  /**
   * `getTask` on a nonexistent id rejects with {@link TaskNotFoundError}
   * rather than returning a nullish value, so a caller cannot mistake
   * "task does not exist" for "task exists and every field happens to be
   * falsy."
   */
  async getTask(taskId: number, sourcePublicKey?: string): Promise<Task> {
    try {
      return await getTask(this.invoker, taskId, this.config.readOnlySourceAccount, sourcePublicKey);
    } catch (err) {
      const code = decodeKeeperError(err instanceof Error ? err.message : undefined);
      if (code !== undefined) {
        if (code === 4 /* TaskNotFound, see errors.ts KeeperErrorCode */) {
          throw new TaskNotFoundError(taskId);
        }
        throw new KeeperContractError(code);
      }
      throw err;
    }
  }

  buildTransaction = buildTransaction.bind(null, this);
  buildFeeBumpTransaction = buildFeeBumpTransaction.bind(null, this);
  submitSignedTransaction = submitSignedTransaction.bind(null, this);
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
// The Soroban RPC client moved to this subpath in @stellar/stellar-sdk — it
// is NOT a `SorobanRpc` named export off the package root in the version
// this SDK targets (^16.2.0), even though examples/keeper-bot/index.js
// (pre-migration) imports it that way. That import resolves to `undefined`
// at runtime in this version — a real, pre-existing bug in the bot's own
// code, independent of this SDK (see this PR's description). This client
// uses the correct, current import path.
import * as Soroban from "@stellar/stellar-sdk/rpc";
import { NETWORK_PRESETS, type NetworkName, type NetworkPreset } from "./network.js";

export interface KeeperRegistryClientOptions {
  readonly contractId: string;
  /** Either a preset name ("testnet" | "futurenet" | "mainnet") or a fully custom preset (for a local sandbox, say). */
  readonly network: NetworkName | NetworkPreset;
  readonly keypair: Keypair;
  /** Passed through to `Soroban.Server`. Defaults to `false`, matching the keeper-bot's existing behavior. */
  readonly allowHttp?: boolean;
}

/**
 * A thin wrapper over `@stellar/stellar-sdk`'s Soroban RPC client, exposing
 * exactly the two operations `examples/keeper-bot/index.js` hand-rolled as
 * `invokeContract`/`readContract` (issue 0163/0166 in the SDK epic) — this
 * class's `invoke`/`read` methods have IDENTICAL semantics and IDENTICAL
 * error messages to that bot's original functions, so migrating the bot onto
 * this client is a like-for-like swap, not a behavior change.
 *
 * Deliberately NOT a full contract-method-per-function client (e.g. no
 * generated `claimTask()`/`executeTask()` methods) — that would require
 * either code generation from the contract's WASM or hand-writing one method
 * per contract function, both larger undertakings than this scaffold's
 * scope. `invoke`/`read` are the generic building blocks every specific
 * contract call is built from; a fuller, generated client is a natural next
 * step once this shape is validated by real usage (the keeper-bot
 * migration).
 */
export class KeeperRegistryClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  private readonly server: Soroban.Server;
  /** The keypair this client signs `invoke()` transactions with. Public so callers can build ScVal args (e.g. `Address.fromString(client.keypair.publicKey())`) without threading a second copy of it through their own code. */
  readonly keypair: Keypair;
  private readonly contract: Contract;

  constructor(options: KeeperRegistryClientOptions) {
    this.contractId = options.contractId;
    const preset =
      typeof options.network === "string"
        ? NETWORK_PRESETS[options.network]
        : options.network;
    this.networkPassphrase = preset.networkPassphrase;
    this.rpcUrl = preset.rpcUrl;
    this.keypair = options.keypair;
    this.server = new Soroban.Server(this.rpcUrl, {
      allowHttp: options.allowHttp ?? false,
    });
    this.contract = new Contract(this.contractId);
  }

  /** The underlying `Soroban.Server` — escape hatch for anything this wrapper doesn't (yet) cover. */
  get rpc(): Soroban.Server {
    return this.server;
  }

  /**
   * Simulates, signs, submits, and polls for confirmation of a contract
   * call that mutates state.
   *
   * Ported behavior-for-behavior from the keeper-bot's `invokeContract` +
   * `simulateAndSend`: same simulate → assemble → sign → send → poll
   * sequence, same 30-attempt / 2-second poll loop, same error message
   * shapes ("Simulation failed: ...", "Send failed: ...", "Transaction
   * failed with status: ...").
   */
  async invoke(
    method: string,
    args: readonly xdr.ScVal[],
  ): Promise<Soroban.Api.GetSuccessfulTransactionResponse> {
    const account = await this.server.getAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResponse = await this.server.simulateTransaction(tx);
    if (Soroban.Api.isSimulationError(simResponse)) {
      throw new Error(`Simulation failed: ${simResponse.error}`);
    }

    const preparedTx = Soroban.assembleTransaction(tx, simResponse).build();
    preparedTx.sign(this.keypair);

    const sendResponse = await this.server.sendTransaction(preparedTx);
    if (sendResponse.status === "ERROR") {
      throw new Error(
        `Send failed: ${JSON.stringify(sendResponse.errorResult)}`,
      );
    }

    let getResponse = await this.server.getTransaction(sendResponse.hash);
    let attempts = 0;
    while (
      getResponse.status === Soroban.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 30
    ) {
      await sleep(2000);
      getResponse = await this.server.getTransaction(sendResponse.hash);
      attempts++;
    }

    if (getResponse.status === Soroban.Api.GetTransactionStatus.SUCCESS) {
      return getResponse;
    }
    throw new Error(`Transaction failed with status: ${getResponse.status}`);
  }

  /**
   * Evaluates a read-only contract function via simulation. No transaction
   * is signed, submitted, or confirmed, and no sequence number is consumed.
   *
   * Ported behavior-for-behavior from the keeper-bot's `readContract`,
   * including its documented caveat: simulation still builds a transaction
   * envelope, so the calling account must already exist (be funded) on-chain.
   */
  async read(method: string, args: readonly xdr.ScVal[]): Promise<unknown> {
    const account = await this.server.getAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (Soroban.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    return sim.result ? scValToNative(sim.result.retval) : null;
  }

  /**
   * Reads the deployed contract's `VERSION` (issue 0164 in the SDK epic).
   *
   * The contract's `version()` view returns a `u32` (see
   * `contracts/keeper-registry/src/views.rs` / `constants.rs`), which
   * `scValToNative` decodes as a JS `number` — never a string.
   *
   * Returns `undefined` rather than throwing when the read fails for any
   * reason (e.g. an older deployment without a `version` function at all) —
   * the caller decides whether that's an error; this method only reports
   * what it found.
   */
  async version(): Promise<number | undefined> {
    try {
      const result = await this.read("version", []);
      return typeof result === "number" ? result : undefined;
    } catch {
      return undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
