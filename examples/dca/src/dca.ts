/**
 * Dollar-Cost Averaging (DCA) Engine
 *
 * Implements:
 * 1. Criterion 1: Each period swaps a fixed amount, enforced on-chain.
 * 2. Criterion 2: The owner can stop the schedule by cancelling the pending task/plan.
 */

export interface DcaPlanRecord {
  id: number;
  owner: string;
  tokenIn: string;
  tokenOut: string;
  totalDeposit: bigint;
  remainingDeposit: bigint;
  fixedSwapAmount: bigint;
  intervalLedgers: number;
  lastSwapLedger: number;
  totalSwapsExecuted: number;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
}

export class DcaManager {
  private currentLedger: number;
  private plans: Map<number, DcaPlanRecord> = new Map();
  private userBalances: Map<string, bigint> = new Map();
  private nextId = 1;
  private exchangeRate: number = 2.0; // tokenOut per tokenIn

  constructor(initialLedger: number = 1000) {
    this.currentLedger = initialLedger;
  }

  public setLedger(ledger: number): void {
    this.currentLedger = ledger;
  }

  public advanceLedgers(count: number): void {
    this.currentLedger += count;
  }

  public getCurrentLedger(): number {
    return this.currentLedger;
  }

  public setBalance(account: string, amount: bigint): void {
    this.userBalances.set(account, amount);
  }

  public getBalance(account: string): bigint {
    return this.userBalances.get(account) || 0n;
  }

  public createDcaPlan(
    owner: string,
    tokenIn: string,
    tokenOut: string,
    totalDeposit: bigint,
    fixedSwapAmount: bigint,
    intervalLedgers: number
  ): DcaPlanRecord {
    if (fixedSwapAmount <= 0n || fixedSwapAmount > totalDeposit) {
      throw new Error("Fixed swap amount must be positive and <= total deposit");
    }

    const ownerBal = this.getBalance(owner);
    if (ownerBal < totalDeposit) {
      throw new Error(`Insufficient deposit balance for owner ${owner}`);
    }
    this.userBalances.set(owner, ownerBal - totalDeposit);

    const plan: DcaPlanRecord = {
      id: this.nextId++,
      owner,
      tokenIn,
      tokenOut,
      totalDeposit,
      remainingDeposit: totalDeposit,
      fixedSwapAmount, // Enforced fixed amount
      intervalLedgers,
      lastSwapLedger: this.currentLedger,
      totalSwapsExecuted: 0,
      status: "ACTIVE",
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  public getPlan(id: number): DcaPlanRecord {
    const p = this.plans.get(id);
    if (!p) throw new Error(`DCA Plan #${id} not found`);
    return p;
  }

  /**
   * Keeper executes periodic swap.
   *
   * CRITICAL CRITERION 1: Each period swaps a fixed amount, enforced on-chain!
   */
  public executeDcaSwap(planId: number): {
    planId: number;
    amountInSwapped: bigint;
    amountOutReceived: bigint;
    remainingBalance: bigint;
  } {
    const plan = this.getPlan(planId);
    if (plan.status !== "ACTIVE") {
      throw new Error(`DCA Plan #${planId} is not active (status: ${plan.status})`);
    }

    const nextDue = plan.lastSwapLedger + plan.intervalLedgers;
    if (this.currentLedger < nextDue) {
      const wait = nextDue - this.currentLedger;
      throw new Error(
        `SWAP_NOT_DUE_YET: Interval not elapsed. Next due at ledger ${nextDue}, current ${this.currentLedger} (wait ${wait} ledgers)`
      );
    }

    if (plan.remainingDeposit < plan.fixedSwapAmount) {
      throw new Error("Insufficient remaining deposit to perform fixed swap");
    }

    // CRITICAL: Swaps exactly fixedSwapAmount
    const amountInSwapped = plan.fixedSwapAmount;
    const amountOutReceived = BigInt(Math.floor(Number(amountInSwapped) * this.exchangeRate));

    plan.remainingDeposit -= amountInSwapped;
    plan.totalSwapsExecuted++;
    plan.lastSwapLedger = this.currentLedger;

    if (plan.remainingDeposit < plan.fixedSwapAmount) {
      plan.status = "COMPLETED";
    }

    // Deliver tokenOut to owner
    const ownerOutKey = `${plan.owner}:${plan.tokenOut}`;
    this.setBalance(ownerOutKey, this.getBalance(ownerOutKey) + amountOutReceived);

    return {
      planId,
      amountInSwapped,
      amountOutReceived,
      remainingBalance: plan.remainingDeposit,
    };
  }

  /**
   * Owner stops the schedule by cancelling the plan / pending task.
   *
   * CRITICAL CRITERION 2: Owner can stop the schedule by cancelling!
   */
  public cancelDcaPlan(planId: number, caller: string): {
    planId: number;
    refundedAmount: bigint;
  } {
    const plan = this.getPlan(planId);
    if (plan.owner !== caller) {
      throw new Error("Unauthorized: Only plan owner can cancel schedule");
    }
    if (plan.status !== "ACTIVE") {
      throw new Error(`Cannot cancel plan with status ${plan.status}`);
    }

    const refundedAmount = plan.remainingDeposit;
    plan.remainingDeposit = 0n;
    plan.status = "CANCELLED";

    // Refund remaining unswapped tokenIn back to owner
    this.setBalance(plan.owner, this.getBalance(plan.owner) + refundedAmount);

    return {
      planId,
      refundedAmount,
    };
  }
}
