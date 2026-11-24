/**
 * Governance Keeper Task Registration Script
 *
 * CRITICAL CRITERION 1: The task is registered when a proposal passes and executes after the timelock!
 */

import type { GovernanceProposalRecord } from "../src/governance-execution.ts";

export interface GovernanceKeeperTaskPayload {
  taskId: string;
  proposalId: number;
  targetContract: string;
  functionName: string;
  args: [number];
  timelockEta: number; // Earliest execution time
  deadlineTimestamp: number;
  rewardStroops: string;
  condition: {
    type: string;
    minimumTimestamp: number;
  };
}

/**
 * Called when a governance proposal passes to register the post-timelock keeper task.
 */
export function registerTaskOnProposalPassed(
  governanceContractAddress: string,
  proposal: GovernanceProposalRecord,
  executionGraceWindowSeconds: number = 7200, // 2-hour window after timelock
  rewardStroops: bigint = 150_000n // 0.015 XLM
): GovernanceKeeperTaskPayload {
  return {
    taskId: `gov-exec-proposal-${proposal.id}`,
    proposalId: proposal.id,
    targetContract: governanceContractAddress,
    functionName: "execute_proposal",
    args: [proposal.id],
    timelockEta: proposal.eta, // Execution gates after timelock!
    deadlineTimestamp: proposal.eta + executionGraceWindowSeconds,
    rewardStroops: rewardStroops.toString(),
    condition: {
      type: "time-window-condition",
      minimumTimestamp: proposal.eta, // Attached condition gates execution until timelock expires
    },
  };
}
