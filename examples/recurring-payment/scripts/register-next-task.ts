/**
 * Automated Chaining Script: Registers the next period's keeper task after each execution.
 */

import type { PaymentExecutionResult, SubscriptionRecord } from "../src/subscription.ts";

export interface KeeperTaskPayload {
  taskId: string;
  subscriptionId: number;
  period: number;
  targetContract: string;
  functionName: string;
  args: [number];
  dueLedger: number;
  rewardStroops: string;
  deadlineLedgers: number;
  condition: {
    type: string;
    minimumLedger: number;
  };
}

export class TaskChainingAutomator {
  private registeredTasks: KeeperTaskPayload[] = [];
  private targetContract: string;

  constructor(targetContract: string = "CC_SUBSCRIPTION_CONTRACT") {
    this.targetContract = targetContract;
  }

  /**
   * Called by event listener or webhook whenever a `PaymentExecuted` event occurs.
   * Registers the next period's keeper task on the Keeper Registry.
   */
  public onPaymentExecuted(
    payment: PaymentExecutionResult,
    sub: SubscriptionRecord,
    rewardStroops: bigint = 75_000n
  ): KeeperTaskPayload | null {
    // If subscription reached max periods or is cancelled, do not register next task
    if (!sub.active || sub.paidPeriods >= sub.maxPeriods) {
      return null;
    }

    const nextPeriod = payment.periodPaid + 1;
    const dueLedger = payment.nextDueLedger;

    const taskPayload: KeeperTaskPayload = {
      taskId: `sub-${payment.subscriptionId}-period-${nextPeriod}`,
      subscriptionId: payment.subscriptionId,
      period: nextPeriod,
      targetContract: this.targetContract,
      functionName: "execute_payment",
      args: [payment.subscriptionId],
      dueLedger,
      rewardStroops: rewardStroops.toString(),
      deadlineLedgers: dueLedger + 50,
      condition: {
        type: "time-window-or-ledger-boundary",
        minimumLedger: dueLedger,
      },
    };

    this.registeredTasks.push(taskPayload);
    return taskPayload;
  }

  public getRegisteredTasks(): KeeperTaskPayload[] {
    return [...this.registeredTasks];
  }
}
