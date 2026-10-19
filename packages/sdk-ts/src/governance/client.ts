/**
 * `GovernanceClient` -- a typed client for the governance contract (`contracts/governance`).
 *
 * Follows the SDK's established client conventions, wrapping proposal creation,
 * voting, evaluating, queueing, timelock progression, execution, cancellation,
 * and read-only views.
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
  addressArg,
  governableActionArg,
  i128Arg,
  toBigInt,
  u32Arg,
  u64Arg,
  voteChoiceArg,
} from "./scval.js";
import type {
  GovernableAction,
  Proposal,
  ProposalStatus,
  VoteChoice,
  VoteRecord,
} from "./types.js";

export { keypairSigner };
export type { TransactionSigner };

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
  contractId: string;
  rpcUrl?: string | undefined;
  networkPassphrase: string;
  signer?: TransactionSigner | undefined;
  fee?: string | undefined;
  timeoutSeconds?: number | undefined;
  confirmationTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  server?: RpcServerLike | undefined;
  warn?: ((message: string) => void) | undefined;
}

export interface SignedCallOptions {
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
}

export interface VoteParams extends SignedCallOptions {
  voter: string;
  proposalId: IntegerInput;
  choice: VoteChoice;
}

export interface EvaluateProposalParams extends SignedCallOptions {
  caller: string;
  proposalId: IntegerInput;
}

export interface QueueProposalParams extends SignedCallOptions {
  caller: string;
  proposalId: IntegerInput;
}

export interface ExecuteProposalParams extends SignedCallOptions {
  caller: string;
  proposalId: IntegerInput;
}

export interface CancelProposalParams extends SignedCallOptions {
  caller: string;
  proposalId: IntegerInput;
}

const READ_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optional(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}

export class GovernanceClient {
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

  constructor(options: GovernanceClientOptions) {
    if (!StrKey.isValidContract(options.contractId)) {
      throw new GovernanceSdkError(
        `Invalid contract id ${JSON.stringify(options.contractId)}: expected a C... Soroban contract address.`,
      );
    }
    if (!options.networkPassphrase) {
      throw new GovernanceSdkError("networkPassphrase is required.");
    }
    if (!options.server && !options.rpcUrl) {
      throw new GovernanceSdkError("rpcUrl is required unless a server is supplied.");
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

  // ── views ──────────────────────────────────────────────────────────────────

  async admin(): Promise<string> {
    return String(await this.read<string>("admin"));
  }

  async kprsToken(): Promise<string> {
    return String(await this.read<string>("kprs_token"));
  }

  async registry(): Promise<string> {
    return String(await this.read<string>("registry"));
  }

  async version(): Promise<number> {
    return Number(await this.read<number | bigint>("version"));
  }

  async proposalCount(): Promise<bigint> {
    return BigInt(await this.read<bigint | number>("proposal_count"));
  }

  async proposalThreshold(): Promise<bigint> {
    return BigInt(await this.read<bigint | number>("proposal_threshold"));
  }

  async votingPeriod(): Promise<number> {
    return Number(await this.read<number | bigint>("voting_period"));
  }

  async timelockDelay(): Promise<number> {
    return Number(await this.read<number | bigint>("timelock_delay"));
  }

  async quorumBps(): Promise<number> {
    return Number(await this.read<number | bigint>("quorum_bps"));
  }

  async totalTokenSupply(): Promise<bigint> {
    return BigInt(await this.read<bigint | number>("total_token_supply"));
  }

  async quorumThreshold(): Promise<bigint> {
    return BigInt(await this.read<bigint | number>("quorum_threshold"));
  }

  async getProposal(proposalId: IntegerInput): Promise<Proposal> {
    const raw = await this.read<any>("get_proposal", [u64Arg(proposalId, "proposalId")]);
    return {
      id: raw.id,
      proposer: raw.proposer,
      action: raw.action,
      status: raw.status,
      createdAt: raw.created_at,
      votingEnd: raw.voting_end,
      eta: raw.eta,
      votesFor: BigInt(raw.votes_for),
      votesAgainst: BigInt(raw.votes_against),
      votesAbstain: BigInt(raw.votes_abstain),
    };
  }

  async getProposalStatus(proposalId: IntegerInput): Promise<ProposalStatus> {
    return await this.read<ProposalStatus>("get_proposal_status", [u64Arg(proposalId, "proposalId")]);
  }

  async getProposalState(proposalId: IntegerInput): Promise<ProposalStatus> {
    return await this.read<ProposalStatus>("get_proposal_state", [u64Arg(proposalId, "proposalId")]);
  }

  async getTallies(proposalId: IntegerInput): Promise<[bigint, bigint, bigint]> {
    const raw = await this.read<[bigint | number, bigint | number, bigint | number]>(
      "get_tallies",
      [u64Arg(proposalId, "proposalId")],
    );
    return [BigInt(raw[0]), BigInt(raw[1]), BigInt(raw[2])];
  }

  async hasVoted(proposalId: IntegerInput, voter: string): Promise<boolean> {
    return Boolean(
      await this.read<boolean>("has_voted", [
        u64Arg(proposalId, "proposalId"),
        addressArg(voter, "voter"),
      ]),
    );
  }

  async getVote(proposalId: IntegerInput, voter: string): Promise<VoteRecord | undefined> {
    const raw = await this.read<any | null | undefined>("get_vote", [
      u64Arg(proposalId, "proposalId"),
      addressArg(voter, "voter"),
    ]);
    if (!raw) return undefined;
    return {
      choice: raw.choice,
      weight: BigInt(raw.weight),
    };
  }

  async getVotingPower(account: string): Promise<bigint> {
    return BigInt(await this.read<bigint | number>("get_voting_power", [addressArg(account, "account")]));
  }

  async getVotingPowerAt(account: string, ledger: number): Promise<bigint> {
    return BigInt(
      await this.read<bigint | number>("get_voting_power_at", [
        addressArg(account, "account"),
        u32Arg(ledger, "ledger"),
      ]),
    );
  }

  async isExecutable(proposalId: IntegerInput): Promise<boolean> {
    return Boolean(
      await this.read<boolean>("is_executable", [u64Arg(proposalId, "proposalId")]),
    );
  }

  async isQuorumMet(proposalId: IntegerInput): Promise<boolean> {
    return Boolean(
      await this.read<boolean>("is_quorum_met", [u64Arg(proposalId, "proposalId")]),
    );
  }

  async isPassingThresholdMet(proposalId: IntegerInput): Promise<boolean> {
    return Boolean(
      await this.read<boolean>("is_passing_threshold_met", [u64Arg(proposalId, "proposalId")]),
    );
  }

  async getRemainingDelay(proposalId: IntegerInput): Promise<bigint> {
    return BigInt(
      await this.read<bigint | number>("get_remaining_delay", [u64Arg(proposalId, "proposalId")]),
    );
  }

  // ── mutating entry points ──────────────────────────────────────────────────

  async initialize(params: InitializeParams): Promise<void> {
    const { admin, kprsToken, registry, signer } = params;
    await this.invoke<void>({
      method: "initialize",
      source: admin,
      args: [
        addressArg(admin, "admin"),
        addressArg(kprsToken, "kprsToken"),
        addressArg(registry, "registry"),
      ],
      ...(signer ? { signer } : {}),
    });
  }

  async createProposal(params: CreateProposalParams): Promise<bigint> {
    const { proposer, action, signer } = params;
    const result = await this.invoke<bigint | number>({
      method: "create_proposal",
      source: proposer,
      args: [addressArg(proposer, "proposer"), governableActionArg(action)],
      ...(signer ? { signer } : {}),
    });
    return BigInt(result);
  }

  async vote(params: VoteParams): Promise<void> {
    const { voter, proposalId, choice, signer } = params;
    await this.invoke<void>({
      method: "vote",
      source: voter,
      args: [
        addressArg(voter, "voter"),
        u64Arg(proposalId, "proposalId"),
        voteChoiceArg(choice),
      ],
      ...(signer ? { signer } : {}),
    });
  }

  async evaluateProposal(params: EvaluateProposalParams): Promise<ProposalStatus> {
    const { caller, proposalId, signer } = params;
    return await this.invoke<ProposalStatus>({
      method: "evaluate_proposal",
      source: caller,
      args: [u64Arg(proposalId, "proposalId")],
      ...(signer ? { signer } : {}),
    });
  }

  async queueProposal(params: QueueProposalParams): Promise<bigint> {
    const { caller, proposalId, signer } = params;
    const result = await this.invoke<bigint | number>({
      method: "queue_proposal",
      source: caller,
      args: [u64Arg(proposalId, "proposalId")],
      ...(signer ? { signer } : {}),
    });
    return BigInt(result);
  }

  async executeProposal(params: ExecuteProposalParams): Promise<void> {
    const { caller, proposalId, signer } = params;
    await this.invoke<void>({
      method: "execute_proposal",
      source: caller,
      args: [u64Arg(proposalId, "proposalId")],
      ...(signer ? { signer } : {}),
    });
  }

  async cancelProposal(params: CancelProposalParams): Promise<void> {
    const { caller, proposalId, signer } = params;
    await this.invoke<void>({
      method: "cancel_proposal",
      source: caller,
      args: [addressArg(caller, "caller"), u64Arg(proposalId, "proposalId")],
      ...(signer ? { signer } : {}),
    });
  }

  // ── shared plumbing ────────────────────────────────────────────────────────

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
    if (signer.publicKey !== source) {
      throw new GovernanceSdkError(
        `${method} must be authorized by ${source}, but the available signer is ${signer.publicKey}.`,
      );
    }
    return signer;
  }

  private async loadAccount(source: string, context: string): Promise<Account> {
    if (!StrKey.isValidEd25519PublicKey(source)) {
      throw new GovernanceSdkError(
        `Invalid account address ${JSON.stringify(source)}: expected a G... Stellar address.`,
      );
    }
    try {
      return await this.server.getAccount(source);
    } catch (cause) {
      throw toGovernanceError(cause, `${context} (could not load source account ${source})`);
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

  private async confirm<T>(hash: string, context: string): Promise<T> {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    for (;;) {
      let result: rpc.Api.GetTransactionResponse;
      try {
        result = await this.server.getTransaction(hash);
      } catch (cause) {
        throw toGovernanceError(cause, context);
      }

      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result.returnValue ? (scValToNative(result.returnValue) as T) : (undefined as T);
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw toGovernanceError(result, context);
      }
      if (Date.now() >= deadline) {
        throw new GovernanceSdkError(
          `${context}: transaction ${hash} was still ${result.status} after ${this.confirmationTimeoutMs}ms.`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  getServer(): RpcServerLike {
    return this.server;
  }
}
