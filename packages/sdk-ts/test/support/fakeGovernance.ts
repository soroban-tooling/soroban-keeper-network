/**
 * In-memory stand-in for the governance contract's state machine, enabling
 * SDK tests to exercise proposal creation, voting, evaluations, queueing,
 * timelock execution, and views against GovernanceClient with realistic encoding.
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
import type { Proposal, ProposalStatus, VoteChoice } from "../../src/governance/types.js";

export const GOVERNANCE_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

class ContractRejection extends Error {
  constructor(readonly code: GovernanceErrorCode) {
    super(`HostError: Error(Contract, #${code})`);
  }
}

interface ProposalState {
  id: bigint;
  proposer: string;
  action: any;
  status: ProposalStatus;
  createdAt: bigint;
  votingEnd: bigint;
  eta: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
}

export class FakeGovernance implements RpcServerLike {
  ledgerSequence = 100_000;
  readonly methods: string[] = [];

  private admin: string | undefined;
  private kprsToken: string | undefined;
  private registry: string | undefined;
  private proposalThreshold = 100_000_0000000n;
  private votingPeriod = 50_400;
  private timelockDelay = 28_800;
  private quorumBps = 400;
  private totalSupply = 100_000_000_0000000n;

  private proposals = new Map<bigint, ProposalState>();
  private proposalCount = 0n;
  private votes = new Map<string, { choice: VoteChoice; weight: bigint }>();
  private voterBalances = new Map<string, bigint>();

  setVoterBalance(account: string, balance: bigint) {
    this.voterBalances.set(account, balance);
  }

  // ── RpcServerLike ─────────────────────────────────────────────────────────

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return { id: "fake", protocolVersion: 22, sequence: this.ledgerSequence };
  }

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "1");
  }

  async simulateTransaction(
    transaction: any,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    try {
      const retval = this.dispatch(transaction);
      const data = new SorobanDataBuilder();
      return {
        id: "sim-id",
        events: [],
        transactionData: data.build(),
        minResourceFee: "100",
        result: {
          auth: [],
          retval,
        },
        cost: { cpuInsns: "100", memBytes: "100" },
      } as unknown as rpc.Api.SimulateTransactionResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: "sim-id",
        events: [],
        error: message,
      } as unknown as rpc.Api.SimulateTransactionResponse;
    }
  }

  async sendTransaction(): Promise<rpc.Api.SendTransactionResponse> {
    return {
      status: "PENDING",
      hash: "0000000000000000000000000000000000000000000000000000000000000001",
      latestLedger: this.ledgerSequence,
      latestLedgerCloseTime: 0,
    };
  }

  async getTransaction(): Promise<rpc.Api.GetTransactionResponse> {
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      latestLedger: this.ledgerSequence,
      latestLedgerCloseTime: 0,
      oldestLedger: 0,
      oldestLedgerCloseTime: 0,
      applicationOrder: 0,
      feeBump: false,
      envelopeXdr: {} as any,
      resultXdr: {} as any,
      resultMetaXdr: {} as any,
      ledger: this.ledgerSequence,
      createdAt: 0,
    };
  }

  async getEvents(): Promise<rpc.Api.GetEventsResponse> {
    return { events: [], latestLedger: this.ledgerSequence };
  }

  private dispatch(transaction: any): xdr.ScVal {
    const op = transaction.operations[0] as any;
    const call = op.func.invokeContract();
    const method = call.functionName().toString();
    const args = call.args();
    this.methods.push(method);

    switch (method) {
      case "initialize": {
        if (this.admin) throw new ContractRejection(GovernanceErrorCode.AlreadyInitialized);
        this.admin = scValToNative(args[0]);
        this.kprsToken = scValToNative(args[1]);
        this.registry = scValToNative(args[2]);
        return xdr.ScVal.scvVoid();
      }
      case "admin":
        if (!this.admin) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        return nativeToScVal(this.admin, { type: "address" });
      case "kprs_token":
        if (!this.kprsToken) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        return nativeToScVal(this.kprsToken, { type: "address" });
      case "registry":
        if (!this.registry) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        return nativeToScVal(this.registry, { type: "address" });
      case "version":
        return nativeToScVal(1, { type: "u32" });
      case "proposal_count":
        return nativeToScVal(this.proposalCount, { type: "u64" });
      case "proposal_threshold":
        return nativeToScVal(this.proposalThreshold, { type: "i128" });
      case "voting_period":
        return nativeToScVal(this.votingPeriod, { type: "u32" });
      case "timelock_delay":
        return nativeToScVal(this.timelockDelay, { type: "u32" });
      case "quorum_bps":
        return nativeToScVal(this.quorumBps, { type: "u32" });
      case "total_token_supply":
        return nativeToScVal(this.totalSupply, { type: "i128" });
      case "quorum_threshold":
        return nativeToScVal((this.totalSupply * BigInt(this.quorumBps)) / 10_000n, { type: "i128" });

      case "create_proposal": {
        if (!this.admin) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const proposer = scValToNative(args[0]);
        const balance = this.voterBalances.get(proposer) ?? 0n;
        if (balance < this.proposalThreshold) {
          throw new ContractRejection(GovernanceErrorCode.InsufficientProposerBalance);
        }
        this.proposalCount += 1n;
        const id = this.proposalCount;
        const action = scValToNative(args[1]);
        const proposal: ProposalState = {
          id,
          proposer,
          action,
          status: "Active",
          createdAt: BigInt(this.ledgerSequence),
          votingEnd: BigInt(this.ledgerSequence + this.votingPeriod),
          eta: 0n,
          votesFor: 0n,
          votesAgainst: 0n,
          votesAbstain: 0n,
        };
        this.proposals.set(id, proposal);
        return nativeToScVal(id, { type: "u64" });
      }

      case "vote": {
        if (!this.admin) throw new ContractRejection(GovernanceErrorCode.NotInitialized);
        const voter = scValToNative(args[0]);
        const id = BigInt(scValToNative(args[1]));
        const choice = scValToNative(args[2]) as VoteChoice;
        const proposal = this.proposals.get(id);
        if (!proposal) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        if (proposal.status !== "Active") throw new ContractRejection(GovernanceErrorCode.VotingEnded);
        const voteKey = `${id}:${voter}`;
        if (this.votes.has(voteKey)) throw new ContractRejection(GovernanceErrorCode.AlreadyVoted);
        const weight = this.voterBalances.get(voter) ?? 0n;
        if (weight <= 0n) throw new ContractRejection(GovernanceErrorCode.InsufficientVotingPower);
        this.votes.set(voteKey, { choice, weight });
        if (choice === 1) proposal.votesFor += weight;
        else if (choice === 0) proposal.votesAgainst += weight;
        else if (choice === 2) proposal.votesAbstain += weight;
        return xdr.ScVal.scvVoid();
      }

      case "evaluate_proposal": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        if (BigInt(this.ledgerSequence) <= proposal.votingEnd) {
          throw new ContractRejection(GovernanceErrorCode.VotingStillActive);
        }
        const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
        const quorum = (this.totalSupply * BigInt(this.quorumBps)) / 10_000n;
        if (totalVotes < quorum || proposal.votesFor <= proposal.votesAgainst) {
          proposal.status = "Defeated";
        } else {
          proposal.status = "Passed";
        }
        return nativeToScVal(proposal.status, { type: "symbol" });
      }

      case "queue_proposal": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        if (proposal.status !== "Passed") throw new ContractRejection(GovernanceErrorCode.ProposalNotQueued);
        proposal.status = "Queued";
        proposal.eta = BigInt(this.ledgerSequence + this.timelockDelay);
        return nativeToScVal(proposal.eta, { type: "u64" });
      }

      case "execute_proposal": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        if (proposal.status !== "Queued") throw new ContractRejection(GovernanceErrorCode.ProposalNotQueued);
        if (BigInt(this.ledgerSequence) < proposal.eta) {
          throw new ContractRejection(GovernanceErrorCode.TimelockNotElapsed);
        }
        proposal.status = "Executed";
        return xdr.ScVal.scvVoid();
      }

      case "get_proposal": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        return nativeToScVal({
          id: proposal.id,
          proposer: proposal.proposer,
          action: proposal.action,
          status: proposal.status,
          created_at: proposal.createdAt,
          voting_end: proposal.votingEnd,
          eta: proposal.eta,
          votes_for: proposal.votesFor,
          votes_against: proposal.votesAgainst,
          votes_abstain: proposal.votesAbstain,
        });
      }

      case "get_tallies": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal) throw new ContractRejection(GovernanceErrorCode.ProposalNotFound);
        return nativeToScVal([proposal.votesFor, proposal.votesAgainst, proposal.votesAbstain]);
      }

      case "has_voted": {
        const id = BigInt(scValToNative(args[0]));
        const voter = scValToNative(args[1]);
        return nativeToScVal(this.votes.has(`${id}:${voter}`), { type: "bool" });
      }

      case "is_executable": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal || proposal.status !== "Queued") return nativeToScVal(false, { type: "bool" });
        return nativeToScVal(BigInt(this.ledgerSequence) >= proposal.eta, { type: "bool" });
      }

      case "get_remaining_delay": {
        const id = BigInt(scValToNative(args[0]));
        const proposal = this.proposals.get(id);
        if (!proposal || proposal.status !== "Queued") {
          throw new ContractRejection(GovernanceErrorCode.ProposalNotQueued);
        }
        const diff = proposal.eta > BigInt(this.ledgerSequence) ? proposal.eta - BigInt(this.ledgerSequence) : 0n;
        return nativeToScVal(diff, { type: "u64" });
      }

      default:
        return xdr.ScVal.scvVoid();
    }
  }
}

export function clientFor(
  fake: FakeGovernance,
  signerKeypair: Keypair,
): { client: GovernanceClient } {
  const client = new GovernanceClient({
    contractId: GOVERNANCE_CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    server: fake,
    signer: keypairSigner(signerKeypair),
  });
  return { client };
}
