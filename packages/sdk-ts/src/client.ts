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
