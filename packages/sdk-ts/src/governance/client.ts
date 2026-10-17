/**
 * `GovernanceClient` -- a typed client for the Governance contract
 * (`contracts/governance`).
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { TransactionSigner } from "../core/caller.js";
import { keypairSigner } from "../client.js";
import {
  GovernanceContractError,
  GovernanceErrorCode,
  GovernanceSdkError,
  toGovernanceError,
} from "./errors.js";
import type { IntegerInput } from "./scval.js";
import {
  actionToScVal,
  addressArg,
  scValToProposal,
  toBigInt,
  u32Arg,
  u64Arg,
} from "./scval.js";
import { GovernableAction, Proposal, ProposalStatus, VoteType } from "./types.js";

export { keypairSigner };
export type { TransactionSigner };

/** The subset of `rpc.Server` this client uses. */
export type RpcServerLike = Pick<
  rpc.Server,
  | "getAccount"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getLatestLedger"
  | "getEvents"
>;

export interface GovernanceClientOptions {
  /** `C...` address of the deployed governance contract. */
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
  /** Pre-built RPC server. Supplying one skips constructing one from `rpcUrl`. */
  server?: RpcServerLike | undefined;
  /** Sink for non-fatal warnings. Defaults to `console.warn`. */
  warn?: ((message: string) => void) | undefined;
}

/** Arguments shared by every state-changing wrapper method. */
export interface SignedCallOptions {
  /** Signer for this call, overriding the client's default. */
  signer?: TransactionSigner;
}

export interface InitializeParams extends SignedCallOptions {
  admin: string;
  kprsToken: string;
  registry: string;
}

export interface CreateProposalParams extends SignedCallOptions {
  proposer: string;
  action: GovernableAction;
  eta: IntegerInput;
}

export interface VoteParams extends SignedCallOptions {
  voter: string;
  proposalId: IntegerInput;
  support: VoteType | number;
}

export interface ExecuteProposalParams extends SignedCallOptions {
  proposalId: IntegerInput;
  caller?: string;
}

const READ_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class GovernanceClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly server: RpcServerLike;
  readonly fee: string;
  readonly timeoutSeconds: number;
  readonly confirmationTimeoutMs: number;
  readonly pollIntervalMs: number;
  private readonly defaultSigner: TransactionSigner | undefined;
  private readonly warnSink: (message: string) => void;

  constructor(options: GovernanceClientOptions) {
    if (!StrKey.isValidContract(options.contractId)) {
      throw new GovernanceSdkError(
        `contractId must be a C... contract address, got ${JSON.stringify(options.contractId)}.`,
      );
    }
    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase;
    this.fee = options.fee ?? BASE_FEE;
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.defaultSigner = options.signer;
    this.warnSink = options.warn ?? ((msg) => console.warn(msg));

    if (options.server) {
      this.server = options.server;
    } else if (options.rpcUrl) {
      this.server = new rpc.Server(options.rpcUrl);
    } else {
      throw new GovernanceSdkError("GovernanceClient needs either `server` or `rpcUrl`.");
    }
  }

  // ── State-changing entry points ──────────────────────────────────────────

  /**
   * Initializes the governance contract with admin, KPRS token address, and registry address.
   */
  async initialize(params: InitializeParams): Promise<void> {
    await this.invoke<void>({
      method: "initialize",
      args: [
        addressArg(params.admin, "admin"),
        addressArg(params.kprsToken, "kprsToken"),
        addressArg(params.registry, "registry"),
      ],
      source: params.admin,
      ...(params.signer ? { signer: params.signer } : {}),
    });
  }

  /**
   * Creates and queues a proposal for execution after the specified timelock ETA.
   */
  async createProposal(params: CreateProposalParams): Promise<bigint> {
    const raw = await this.invoke<unknown>({
      method: "create_proposal",
      args: [
        addressArg(params.proposer, "proposer"),
        actionToScVal(params.action),
        u64Arg(params.eta, "eta"),
      ],
      source: params.proposer,
      ...(params.signer ? { signer: params.signer } : {}),
    });
    return BigInt(raw as string | number | bigint);
  }

  /**
   * Casts a vote on an active proposal.
   */
  async vote(params: VoteParams): Promise<void> {
    await this.invoke<void>({
      method: "vote",
      args: [
        addressArg(params.voter, "voter"),
        u64Arg(params.proposalId, "proposalId"),
        u32Arg(params.support, "support"),
      ],
      source: params.voter,
      ...(params.signer ? { signer: params.signer } : {}),
    });
  }

  /**
   * Alias for `vote`.
   */
  async castVote(params: VoteParams): Promise<void> {
    return this.vote(params);
  }

  /**
   * Executes a passed, queued proposal whose timelock has elapsed.
   */
  async executeProposal(params: ExecuteProposalParams): Promise<void> {
    const signer = params.signer ?? this.defaultSigner;
    const caller = params.caller ?? signer?.publicKey;
    if (!caller) {
      throw new GovernanceSdkError("executeProposal requires a caller address or a configured signer.");
    }

    await this.invoke<void>({
      method: "execute_proposal",
      args: [u64Arg(params.proposalId, "proposalId")],
      source: caller,
      ...(params.signer ? { signer: params.signer } : {}),
    });
  }

  // ── Read-only views ──────────────────────────────────────────────────────

  /**
   * Semantic version view of the contract logic.
   */
  async version(): Promise<number> {
    const raw = await this.read<unknown>("version");
    return Number(raw);
  }

  /**
   * Contract admin address.
   */
  async admin(): Promise<string> {
    return this.read<string>("admin");
  }

  /**
   * Configured KPRS governance token contract address.
   */
  async kprsToken(): Promise<string> {
    return this.read<string>("kprs_token");
  }

  /**
   * Configured KeeperRegistry address.
   */
  async registry(): Promise<string> {
    return this.read<string>("registry");
  }

  /**
   * Reads voting power from the configured KPRS token contract for an account.
   */
  async getVotingPower(account: string): Promise<bigint> {
    const raw = await this.read<unknown>("get_voting_power", [
      addressArg(account, "account"),
    ]);
    return BigInt(raw as string | number | bigint);
  }

  /**
   * Retrieves a proposal by its unique ID.
   */
  async getProposal(proposalId: IntegerInput): Promise<Proposal> {
    const raw = await this.read<unknown>("get_proposal", [
      u64Arg(proposalId, "proposalId"),
    ]);
    return scValToProposal(raw);
  }

  // ── Internal plumbing ────────────────────────────────────────────────────

  async read<T>(method: string, args: xdr.ScVal[] = []): Promise<T> {
    const context = `${method} simulation failed`;
    const account = new Account(READ_SOURCE_ACCOUNT, "0");
    const tx = this.buildTransaction(account, method, args);

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(tx);
    } catch (cause) {
      throw toGovernanceError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toGovernanceError(simulation.error, context);
    }
    const result = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result;
    return result ? (scValToNative(result.retval) as T) : (undefined as T);
  }

  async invoke<T>(params: {
    method: string;
    args?: xdr.ScVal[];
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
      throw toGovernanceError(cause, context);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toGovernanceError(simulation.error, context);
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
      throw toGovernanceError(cause, context);
    }
    if (sent.status !== "PENDING") {
      throw toGovernanceError(sent.errorResult ?? `submission returned ${sent.status}`, context);
    }

    return this.confirm<T>(sent.hash, context);
  }

  private resolveSigner(
    method: string,
    source: string,
    override: TransactionSigner | undefined,
  ): TransactionSigner {
    const signer = override ?? this.defaultSigner;
    if (!signer) {
      throw new GovernanceSdkError(
        `${method} is a state-changing call and needs a signer: pass one to the client constructor or to this call.`,
      );
    }
    return signer;
  }

  private async loadAccount(address: string, context: string): Promise<Account> {
    try {
      return await this.server.getAccount(address);
    } catch (cause) {
      throw toGovernanceError(cause, context);
    }
  }

  private buildTransaction(
    account: Account,
    method: string,
    args: xdr.ScVal[],
  ) {
    const contract = new Contract(this.contractId);
    return new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(this.timeoutSeconds)
      .build();
  }

  private async confirm<T>(hash: string, context: string): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < this.confirmationTimeoutMs) {
      let tx: rpc.Api.GetTransactionResponse;
      try {
        tx = await this.server.getTransaction(hash);
      } catch (cause) {
        throw toGovernanceError(cause, context);
      }

      if (tx.status === "SUCCESS") {
        const val = tx.returnValue;
        return val ? (scValToNative(val) as T) : (undefined as T);
      }
      if (tx.status === "FAILED") {
        throw toGovernanceError(tx.resultXdr ?? tx, context);
      }

      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    throw toGovernanceError(`timed out after ${this.confirmationTimeoutMs}ms waiting for ${hash}`, context);
  }
}
