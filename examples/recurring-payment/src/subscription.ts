/**
 * Recurring Payment / Subscription Manager
 *
 * Enforces period boundary checks, double payment prevention,
 * and automated keeper task chaining.
 */

export interface SubscriptionRecord {
  id: number;
  subscriber: string;
  merchant: string;
  token: string;
  amount: bigint;
  intervalLedgers: number;
  lastPaymentLedger: number;
  paidPeriods: number;
  maxPeriods: number;
  active: boolean;
}

export interface PaymentExecutionResult {
  subscriptionId: number;
  periodPaid: number;
  amount: bigint;
  executionLedger: number;
  nextDueLedger: number;
}

export class SubscriptionManager {
  private currentLedger: number;
  private subscriptions: Map<number, SubscriptionRecord> = new Map();
  private paymentHistory: PaymentExecutionResult[] = [];
  private nextId = 1;

  constructor(initialLedger: number = 1000) {
    this.currentLedger = initialLedger;
  }

  public createSubscription(
    subscriber: string,
    merchant: string,
    token: string,
    amount: bigint,
    intervalLedgers: number,
    maxPeriods: number
  ): SubscriptionRecord {
    const sub: SubscriptionRecord = {
      id: this.nextId++,
      subscriber,
      merchant,
      token,
      amount,
      intervalLedgers,
      lastPaymentLedger: this.currentLedger,
      paidPeriods: 0,
      maxPeriods,
      active: true,
    };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  public getSubscription(id: number): SubscriptionRecord {
    const sub = this.subscriptions.get(id);
    if (!sub) {
      throw new Error(`Subscription #${id} not found`);
    }
    return sub;
  }

  public advanceLedgers(count: number): void {
    this.currentLedger += count;
  }

  public getCurrentLedger(): number {
    return this.currentLedger;
  }

  /**
   * Keeper calls this entry point to execute a subscription payment.
   *
   * CONTRACT SAFETY CHECK:
   * Refuses double payment if called before lastPaymentLedger + intervalLedgers!
   */
  public executePayment(subscriptionId: number): PaymentExecutionResult {
    const sub = this.getSubscription(subscriptionId);

    if (!sub.active) {
      throw new Error(`Subscription #${subscriptionId} is inactive`);
    }
    if (sub.paidPeriods >= sub.maxPeriods) {
      throw new Error(`Subscription #${subscriptionId} has reached max periods (${sub.maxPeriods})`);
    }

    const nextDue = sub.lastPaymentLedger + sub.intervalLedgers;
    if (this.currentLedger < nextDue) {
      const waitLedgers = nextDue - this.currentLedger;
      throw new Error(
        `DOUBLE_PAYMENT_REFUSED: Payment not due yet for subscription #${subscriptionId}. Next due at ledger ${nextDue}, current ledger ${this.currentLedger} (wait ${waitLedgers} more ledgers)`
      );
    }

    sub.paidPeriods++;
    sub.lastPaymentLedger = this.currentLedger;

    if (sub.paidPeriods >= sub.maxPeriods) {
      sub.active = false;
    }

    const result: PaymentExecutionResult = {
      subscriptionId,
      periodPaid: sub.paidPeriods,
      amount: sub.amount,
      executionLedger: this.currentLedger,
      nextDueLedger: this.currentLedger + sub.intervalLedgers,
    };

    this.paymentHistory.push(result);
    return result;
  }

  public getPaymentHistory() {
    return [...this.paymentHistory];
  }
}
