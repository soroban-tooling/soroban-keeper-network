// Shared simulate/build/sign/submit plumbing, factored out of the
// `invokeContract`/`readContract` pair the keeper-bot example hand-rolls
// (examples/keeper-bot/index.js) into a reusable, typed primitive every
// client method builds on. See backlog 0153.

import {
  Account,
  BASE_FEE,
  Contract,
  rpc as SorobanRpc,
  scValToNative,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

import type { KeeperRegistryClientConfig } from "../types";

/** How long a built transaction accepts a signature before it expires. */
const DEFAULT_TX_TIMEOUT_SECONDS = 30;

/** How many times to poll `getTransaction` awaiting confirmation. */
const CONFIRMATION_POLL_ATTEMPTS = 30;
const CONFIRMATION_POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal signer: given an unsigned transaction, returns it signed. */
export interface TransactionSigner {
  sign(tx: Transaction): Transaction | Promise<Transaction>;
}

/**
 * Shared read-only (simulation-only, no submission) and mutating
 * (simulate → assemble → sign → submit → confirm) call paths. One instance
 * is created per {@link KeeperRegistryClient}; per-entry-point methods
 * (`getTask`, `registerTask`, ...) are thin wrappers over `read`/`invoke`.
 */
export class ContractInvoker {
  private readonly server: InstanceType<typeof SorobanRpc.Server>;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: KeeperRegistryClientConfig) {
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.contractId);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Evaluates a contract call via simulation only — no transaction is
   * signed or submitted, and no sequence number is consumed. Safe (and
   * cheap) to call as often as needed, e.g. on every poll of a React hook.
   *
   * Simulation still builds a transaction envelope, so the source account
   * must exist on-chain (be funded) — mirrors the same requirement the
   * keeper-bot's `readContract` has today.
   */
  async read<T>(sourcePublicKey: string, method: string, args: xdr.ScVal[]): Promise<T> {
    const account = await this.server.getAccount(sourcePublicKey);
    const tx = this.buildUnsignedTx(account, method, args);

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    return sim.result ? (scValToNative(sim.result.retval) as T) : (undefined as T);
  }

  /**
   * Simulates, assembles, signs (via `signer`), submits, and polls for
   * confirmation of a mutating contract call. Throws if simulation fails,
   * if the network rejects the submission, or if the transaction does not
   * reach `SUCCESS` within the poll window.
   */
  async invoke<T>(sourcePublicKey: string, signer: TransactionSigner, method: string, args: xdr.ScVal[]): Promise<T> {
    const account = await this.server.getAccount(sourcePublicKey);
    const tx = this.buildUnsignedTx(account, method, args);
    return this.simulateSignAndSend<T>(tx, signer);
  }

  /**
   * Builds an unsigned transaction for `method` without simulating it —
   * the lower-level primitive `buildTransaction` (backlog 0170) wraps for
   * wallet-signing flows, where the SDK must never see a private key.
   */
  buildUnsignedTransaction(sourcePublicKey: string, method: string, args: xdr.ScVal[]): Promise<Transaction> {
    return this.server.getAccount(sourcePublicKey).then((account) => this.buildUnsignedTx(account, method, args));
  }

  /**
   * Builds an unsigned transaction for `method` **and** simulates + assembles
   * it (attaches the Soroban resource footprint) before returning — the
   * result is ready to hand directly to a wallet's `signTransaction` or a
   * fee-bump sponsor for signing, with no further simulation step required
   * or safe to perform (see `transactionBuilder.ts`'s `submitSignedTransaction`
   * doc comment for why re-simulating after signing would invalidate the
   * signature). This is what `buildTransaction` (backlog 0170) actually
   * calls; `buildUnsignedTransaction` above stays available as the
   * lower-level, unassembled primitive for a caller that wants to control
   * the simulate/assemble step itself.
   */
  async buildAndAssembleTransaction(sourcePublicKey: string, method: string, args: xdr.ScVal[]): Promise<Transaction> {
    const account = await this.server.getAccount(sourcePublicKey);
    const tx = this.buildUnsignedTx(account, method, args);
    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    return SorobanRpc.assembleTransaction(tx, sim).build();
  }

  /** Simulates (to attach resource footprint/fees) and signs an already-built unsigned transaction, then submits and confirms it. */
  async simulateSignAndSend<T>(tx: Transaction, signer: TransactionSigner): Promise<T> {
    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }

    const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
    const signed = await signer.sign(prepared);

    const sendResponse = await this.server.sendTransaction(signed);
    if (sendResponse.status === "ERROR") {
      throw new Error(`Send failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }

    let getResponse = await this.server.getTransaction(sendResponse.hash);
    let attempts = 0;
    while (
      getResponse.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < CONFIRMATION_POLL_ATTEMPTS
    ) {
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
      getResponse = await this.server.getTransaction(sendResponse.hash);
      attempts++;
    }

    if (getResponse.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction failed with status: ${getResponse.status}`);
    }

    if (getResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && "returnValue" in getResponse) {
      const returnValue = (getResponse as { returnValue?: xdr.ScVal }).returnValue;
      return returnValue !== undefined ? (scValToNative(returnValue) as T) : (undefined as T);
    }
    return undefined as T;
  }

  private buildUnsignedTx(account: Account, method: string, args: xdr.ScVal[]): Transaction {
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
      .build();
  }

  getServer(): InstanceType<typeof SorobanRpc.Server> {
    return this.server;
  }
}
