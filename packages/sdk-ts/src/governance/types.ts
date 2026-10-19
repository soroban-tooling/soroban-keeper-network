/**
 * Governance types for TypeScript SDK (issue #502 / backlog 0374).
 *
 * Models on-chain `contracts/governance/src/lib.rs` definitions:
 * `GovernableAction`, `VoteChoice`, `VoteRecord`, `ProposalStatus`, and `Proposal`.
 */

export enum VoteChoice {
  Against = 0,
  For = 1,
  Abstain = 2,
}

export type ProposalStatus =
  | "Active"
  | "Passed"
  | "Queued"
  | "Executed"
  | "Defeated"
  | "Cancelled";

export type GovernableAction =
  | { type: "SetFeeBps"; bps: number }
  | { type: "SetMinReward"; minReward: bigint | number }
  | { type: "SetReputationFloor"; floorBps: number }
  | { type: "PauseRegistry" }
  | { type: "UnpauseRegistry" }
  | { type: "TransferRegistryAdmin"; newAdmin: string }
  | { type: "AddTreasuryRecipient"; recipient: string; sharesBps: number }
  | { type: "RemoveTreasuryRecipient"; recipient: string }
  | { type: "UpdateTreasuryShares"; recipient: string; newSharesBps: number }
  | { type: "PauseTreasury" }
  | { type: "UnpauseTreasury" }
  | { type: "SetVotingPeriod"; votingPeriod: number }
  | { type: "SetTimelockDelay"; timelockDelay: number }
  | { type: "SetQuorumBps"; quorumBps: number }
  | { type: "SetProposalThreshold"; proposalThreshold: bigint | number }
  | { type: "UpgradeRegistry"; wasmHash: Uint8Array }
  | { type: "UpgradeTreasury"; wasmHash: Uint8Array };

export interface VoteRecord {
  choice: VoteChoice;
  weight: bigint;
}

export interface Proposal {
  id: number | bigint;
  proposer: string;
  action: GovernableAction;
  status: ProposalStatus;
  createdAt: number | bigint;
  votingEnd: number | bigint;
  eta: number | bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
}

export interface GovernanceClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}
