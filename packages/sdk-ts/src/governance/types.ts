/**
 * Types for the Governance contract (`contracts/governance`).
 */

export type GovernableAction =
  | { type: "SetFeeBps"; newBps: number }
  | { type: "SetMinReward"; minReward: bigint }
  | { type: "SetReputationFloor"; floorBps: number }
  | { type: "Pause" }
  | { type: "Unpause" };

export enum ProposalStatus {
  Pending = 0,
  Active = 1,
  Defeated = 2,
  Succeeded = 3,
  Queued = 4,
  Executed = 5,
  Cancelled = 6,
}

export enum VoteType {
  For = 0,
  Against = 1,
  Abstain = 2,
}

export interface Proposal {
  id: bigint;
  proposer: string;
  action: GovernableAction;
  eta: bigint;
  status: ProposalStatus;
}
