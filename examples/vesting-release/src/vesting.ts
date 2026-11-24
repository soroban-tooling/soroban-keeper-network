/**
 * Token Vesting & Tranche Release Manager
 *
 * Simulates on-chain vesting schedules, calculates tranche boundaries,
 * and enforces contract refusal rules.
 */

export interface VestingScheduleConfig {
  beneficiary: string;
  token: string;
  totalAmount: bigint;
  startTimestamp: number;
  cliffTimestamp: number;
  numTranches: number;
  trancheIntervalSeconds: number;
}

export interface ReleaseResult {
  tranche: number;
  amountReleased: bigint;
  totalReleasedSoFar: bigint;
  timestamp: number;
}

export class VestingManager {
  private config: VestingScheduleConfig;
  private currentTimestamp: number;
  private releasedAmount: bigint = 0n;
  private lastReleasedTranche: number = 0;
  private releaseHistory: ReleaseResult[] = [];

  constructor(config: VestingScheduleConfig) {
    if (config.totalAmount <= 0n) {
      throw new Error("Total amount must be greater than zero");
    }
    if (config.cliffTimestamp < config.startTimestamp) {
      throw new Error("Cliff timestamp cannot precede start timestamp");
    }
    if (config.numTranches <= 0 || config.trancheIntervalSeconds <= 0) {
      throw new Error("Invalid tranche parameters");
    }

    this.config = config;
    this.currentTimestamp = config.startTimestamp;
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

  public getReleasedAmount(): bigint {
    return this.releasedAmount;
  }

  public calculateReleasable(): {
    releasable: bigint;
    tranchesElapsed: number;
    isBeforeCliff: boolean;
  } {
    if (this.currentTimestamp < this.config.cliffTimestamp) {
      return { releasable: 0n, tranchesElapsed: 0, isBeforeCliff: true };
    }

    const elapsed = this.currentTimestamp - this.config.startTimestamp;
    const tranchesElapsed = Math.min(
      this.config.numTranches,
      Math.floor(elapsed / this.config.trancheIntervalSeconds)
    );

    const totalVested =
      (this.config.totalAmount * BigInt(tranchesElapsed)) /
      BigInt(this.config.numTranches);

    const releasable = totalVested > this.releasedAmount ? totalVested - this.releasedAmount : 0n;

    return { releasable, tranchesElapsed, isBeforeCliff: false };
  }

  /**
   * Keeper triggers release.
   *
   * CONTRACT CRITERION:
   * Releases before their date are strictly REFUSED by the contract, not just the keeper!
   */
  public release(): ReleaseResult {
    // 1. Refusal before cliff
    if (this.currentTimestamp < this.config.cliffTimestamp) {
      const remainingSeconds = this.config.cliffTimestamp - this.currentTimestamp;
      throw new Error(
        `CLIFF_NOT_REACHED: Contract refuses release. Cliff date is ${this.config.cliffTimestamp}, current time is ${this.currentTimestamp} (${remainingSeconds}s remaining)`
      );
    }

    // 2. Refusal if all already vested
    if (this.releasedAmount >= this.config.totalAmount) {
      throw new Error("ALL_VESTED_ALREADY: All tokens in the vesting schedule have already been released");
    }

    // 3. Calculate releasable amount
    const { releasable, tranchesElapsed } = this.calculateReleasable();

    if (releasable <= 0n) {
      throw new Error(
        `TRANCHE_NOT_REACHED: Contract refuses release. No newly matured tranche available at timestamp ${this.currentTimestamp}`
      );
    }

    this.releasedAmount += releasable;
    this.lastReleasedTranche = tranchesElapsed;

    const result: ReleaseResult = {
      tranche: tranchesElapsed,
      amountReleased: releasable,
      totalReleasedSoFar: this.releasedAmount,
      timestamp: this.currentTimestamp,
    };

    this.releaseHistory.push(result);
    return result;
  }

  public getReleaseHistory(): ReleaseResult[] {
    return [...this.releaseHistory];
  }
}
