/**
 * In-memory stand-in for the governance contract's state machine.
 */

import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { GovernanceClient, keypairSigner } from "../../src/governance/client.js";
import type { RpcServerLike } from "../../src/governance/client.js";
import { GovernanceErrorCode } from "../../src/governance/errors.js";
import { GovernableAction, Proposal, ProposalStatus, VoteType } from "../../src/governance/types.js";

export const GOVERNANCE_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

/** Thrown internally to mark a call the contract would have rejected. */
class ContractRejection extends Error {
  constructor(readonly code: GovernanceErrorCode) {
    super(`HostError: Error(Contract, #${code})`);
  }
}

interface ProposalState {
  id: bigint;
  proposer: string;
  action: unknown;
  eta: bigint;
  status: ProposalStatus;
  votes: Map<string, number>;
}

export class FakeGovernance implements RpcServerLike {
  ledgerSequence = 100_000;
  currentTimestamp = 1_700_000_000n;

  readonly methods: string[] = [];

  private adminAddr: string | undefined;
  private kprsTokenAddr: string | undefined;
  private registryAddr: string | undefined;
  private initialized = false;

  private proposalCount = 0n;
  private readonly proposals = new Map<bigint, ProposalState>();
  private readonly votingPower = new Map<string, bigint>();

  setVotingPower(account: string, power: bigint) {
    this.votingPower.set(account, power);
  }

  setTimestamp(ts: bigint) {
    this.currentTimestamp = ts;
  }

  advanceTime(seconds: bigint) {
    this.currentTimestamp += seconds;
  }

  // ── RpcServerLike ─────────────────────────────────────────────────────────

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return { id: "fake", protocolVersion: 22, sequence: this.ledgerSequence };
  }

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "1");
  }

  async simulateTransaction(tx: unknown): Promise<rpc.Api.SimulateTransactionResponse> {
    const { method, args } = decodeCall(tx);
    this.methods.push(method);

    let retval: unknown;
    try {
      retval = this.dispatch(method, args);
    } catch (error) {
      if (!(error instanceof ContractRejection)) throw error;
      return {
        _parsed: true,
        id: "1",
        latestLedger: 1,
        error: error.message,
        events: [],
      } as unknown as rpc.Api.SimulateTransactionResponse;
    }

    return {
      _parsed: true,
      id: "1",
      latestLedger: 1,
      events: [],
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      result: { retval: toScVal(retval), auth: [] },
    } as unknown as rpc.Api.SimulateTransactionResponse;
  }

  async sendTransaction(tx: { hash: () => Buffer }): Promise<rpc.Api.SendTransactionResponse> {
    return {
      status: "PENDING",
      hash: tx.hash().toString("hex"),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    } as rpc.Api.SendTransactionResponse;
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: 1,
      txHash: hash,
      returnValue: this.lastReturnValue,
    } as unknown as rpc.Api.GetTransactionResponse;
  }

  async getEvents(): Promise<rpc.Api.GetEventsResponse> {
    return { events: [], latestLedger: this.ledgerSequence };
  }

  private lastReturnValue: xdr.ScVal = xdr.ScVal.scvVoid();

  private setReturn(val: unknown): unknown {
    this.lastReturnValue = toScVal(val);
    return val;
  }

  // ── Modelled dispatch ─────────────────────────────────────────────────────

  private dispatch(method: string, args: unknown[]): unknown {
    switch (method) {
      case "initialize": {
        if (this.initialized) throw new ContractRejection(GovernanceErrorCode.AlreadyInitialized);
        this.adminAddr = args[0] as string;
        this.kprsTokenAddr = args[1] as string;
        this.registryAddr = args[2] as string;
        this.initialized = true;
        return this.setReturn(undefined);
      }
      case "version":
        return this.setReturn(1);
      case "admin":
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        return this.setReturn(this.adminAddr);
      case "kprs_token":
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        return this.setReturn(this.kprsTokenAddr);
      case "registry":
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        return this.setReturn(this.registryAddr);
      case "get_voting_power": {
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const account = args[0] as string;
        const power = this.votingPower.get(account) ?? 100_000_000n;
        return this.setReturn(power);
      }
      case "create_proposal": {
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const proposer = args[0] as string;
        const action = args[1];
        const eta = BigInt(args[2] as string | number | bigint);

        this.proposalCount += 1n;
        const id = this.proposalCount;
        this.proposals.set(id, {
          id,
          proposer,
          action,
          eta,
          status: ProposalStatus.Queued,
          votes: new Map(),
        });
        return this.setReturn(id);
      }
      case "get_proposal": {
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const id = BigInt(args[0] as string | number | bigint);
        const p = this.proposals.get(id);
        if (!p) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        return this.setReturn({
          id: p.id,
          proposer: p.proposer,
          action: p.action,
          eta: p.eta,
          status: p.status,
        });
      }
      case "vote": {
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const voter = args[0] as string;
        const id = BigInt(args[1] as string | number | bigint);
        const support = Number(args[2]);
        const p = this.proposals.get(id);
        if (!p) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        p.votes.set(voter, support);
        return this.setReturn(undefined);
      }
      case "execute_proposal": {
        if (!this.initialized) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const id = BigInt(args[0] as string | number | bigint);
        const p = this.proposals.get(id);
        if (!p) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        if (p.status === ProposalStatus.Executed) {
          throw new ContractRejection(GovernanceErrorCode.ProposalAlreadyExecuted);
        }
        if (p.status !== ProposalStatus.Queued) {
          throw new ContractRejection(GovernanceErrorCode.ProposalNotQueued);
        }
        if (this.currentTimestamp < p.eta) {
          throw new ContractRejection(GovernanceErrorCode.TimelockNotElapsed);
        }
        p.status = ProposalStatus.Executed;
        return this.setReturn(undefined);
      }
      default:
        throw new Error(`Unhandled method ${method}`);
    }
  }
}

export interface GovernanceBackedClient {
  client: GovernanceClient;
  address: string;
}

export function clientFor(
  gov: FakeGovernance,
  keypair = Keypair.random(),
): GovernanceBackedClient {
  const client = new GovernanceClient({
    contractId: GOVERNANCE_CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer: keypairSigner(keypair),
    server: gov,
    pollIntervalMs: 1,
  });
  return { client, address: keypair.publicKey() };
}

function toScVal(value: unknown): xdr.ScVal {
  if (value === undefined || value === null) return xdr.ScVal.scvVoid();
  if (value instanceof xdr.ScVal) return value;
  return nativeToScVal(value);
}

function decodeCall(tx: unknown): { method: string; args: unknown[] } {
  const operation = (tx as { operations: { func: xdr.HostFunction }[] }).operations[0];
  const invocation = (operation as { func: xdr.HostFunction }).func.invokeContract();
  return {
    method: invocation.functionName().toString(),
    args: invocation.args().map((arg) => scValToNative(arg)),
  };
}
