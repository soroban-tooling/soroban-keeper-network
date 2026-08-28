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
import type { ExtendDeadlineParams } from "./methods/extendDeadline.js";
import { extendDeadline } from "./methods/extendDeadline.js";

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

  /** See {@link extendDeadline}. */
  extendDeadline(params: ExtendDeadlineParams): Promise<void> {
    return extendDeadline(this, params);
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
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
