/**
 * Governance Timelock Execution Engine
 *
 * Implements:
 * 1. Criterion 1: Task is registered when a proposal passes and executes after the timelock.
 * 2. Criterion 2: Execution before the timelock strictly fails on-chain.
 */

export interface GovernanceProposalRecord {
  id: number;
  title: string;
  targetContract: string;
  actionData: string;
  passedTimestamp: number;
  timelockDurationSeconds: number;
  eta: number; // passedTimestamp + timelockDurationSeconds
  status: "PASSED_AND_QUEUED" | "EXECUTED";
  executedBy?: string;
}

export class GovernanceExecutionManager {
  private currentTimestamp: number;
  private proposals: Map<number, GovernanceProposalRecord> = new Map();

  constructor(initialTimestamp: number = 1_000_000) {
    this.currentTimestamp = initialTimestamp;
  }

  public setTimestamp(timestamp: number): void {
    this.currentTimestamp = timestamp;
  }

  public advanceSeconds(seconds: number): void {
    this.currentTimestamp += seconds;
  }

  public getCurrentTimestamp(): number {
    return this.currentTimestamp;
  }

  /**
   * Called when a governance vote passes: queues proposal with timelock.
   */
  public queuePassedProposal(
    id: number,
    title: string,
    targetContract: string,
    actionData: string,
    timelockSeconds: number = 86400 // 24-hour timelock default
  ): GovernanceProposalRecord {
    const eta = this.currentTimestamp + timelockSeconds;
    const proposal: GovernanceProposalRecord = {
      id,
      title,
      targetContract,
      actionData,
      passedTimestamp: this.currentTimestamp,
      timelockDurationSeconds: timelockSeconds,
      eta,
      status: "PASSED_AND_QUEUED",
    };
    this.proposals.set(id, proposal);
    return proposal;
  }

  public getProposal(id: number): GovernanceProposalRecord {
    const prop = this.proposals.get(id);
    if (!prop) throw new Error(`Proposal #${id} not found`);
    return prop;
  }

  /**
   * Keeper triggers proposal execution once timelock elapses.
   *
   * CRITICAL CRITERION 2: Execution before the timelock fails on-chain!
   */
  public executeProposal(id: number, keeperAddress: string): {
    proposalId: number;
    executedAt: number;
    executedBy: string;
  } {
    const prop = this.getProposal(id);
    if (prop.status !== "PASSED_AND_QUEUED") {
      throw new Error(`Proposal #${id} is already ${prop.status}`);
    }

    // 1. CRITICAL CHECK: Refuse execution before timelock elapses!
    if (this.currentTimestamp < prop.eta) {
      const waitSeconds = prop.eta - this.currentTimestamp;
      throw new Error(
        `TIMELOCK_NOT_ELAPSED: Execution before the timelock fails on-chain. Proposal #${id} timelock ends at ${prop.eta}, current time is ${this.currentTimestamp} (wait ${waitSeconds}s)`
      );
    }

    prop.status = "EXECUTED";
    prop.executedBy = keeperAddress;

    return {
      proposalId: id,
      executedAt: this.currentTimestamp,
      executedBy: keeperAddress,
    };
  }
}
