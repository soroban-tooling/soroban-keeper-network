/**
 * Oracle-Driven Limit Order Engine with Slippage Protection
 *
 * Implements:
 * 1. Criterion 1: Uses on-chain price-threshold condition gating.
 * 2. Criterion 2: Strictly enforces slippage protection in DEX swap execution.
 */

export interface LimitOrder {
  id: number;
  creator: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint; // Slippage protection boundary
  targetPrice: number; // e.g. 2.50 USD
  conditionAddress: string;
  status: "OPEN" | "FILLED" | "CANCELLED";
}

export interface OracleFeed {
  assetPair: string;
  price: number;
  decimals: number;
  lastUpdatedTimestamp: number;
}

export class OnChainPriceThresholdCondition {
  public contractAddress: string;
  private oracle: OracleFeed;
  private targetPrice: number;
  private directionAbove: boolean;

  constructor(
    contractAddress: string,
    oracle: OracleFeed,
    targetPrice: number,
    directionAbove: boolean = true
  ) {
    this.contractAddress = contractAddress;
    this.oracle = oracle;
    this.targetPrice = targetPrice;
    this.directionAbove = directionAbove;
  }

  public updateOraclePrice(newPrice: number): void {
    this.oracle.price = newPrice;
    this.oracle.lastUpdatedTimestamp = Date.now();
  }

  /**
   * On-chain condition check: returns true only if oracle price meets threshold.
   */
  public check(): boolean {
    if (this.directionAbove) {
      return this.oracle.price >= this.targetPrice;
    } else {
      return this.oracle.price <= this.targetPrice;
    }
  }

  public getStatus() {
    return {
      satisfied: this.check(),
      currentPrice: this.oracle.price,
      targetPrice: this.targetPrice,
      direction: this.directionAbove ? "ABOVE_OR_EQUAL" : "BELOW_OR_EQUAL",
    };
  }
}

export class DexRouter {
  private exchangeRate: number; // tokenOut per tokenIn

  constructor(initialRate: number = 2.5) {
    this.exchangeRate = initialRate;
  }

  public setPoolExchangeRate(rate: number): void {
    this.exchangeRate = rate;
  }

  /**
   * Executes DEX swap with slippage protection.
   * If actual output < minAmountOut, swap reverts!
   */
  public swap(
    amountIn: bigint,
    minAmountOut: bigint
  ): { amountOut: bigint; effectiveRate: number } {
    const rawOut = Number(amountIn) * this.exchangeRate;
    const actualOut = BigInt(Math.floor(rawOut));

    // CRITICAL: Slippage protection guarantee
    if (actualOut < minAmountOut) {
      throw new Error(
        `SLIPPAGE_EXCEEDED: Swap output ${actualOut} is below user minimum ${minAmountOut} (effective rate: ${this.exchangeRate})`
      );
    }

    return {
      amountOut: actualOut,
      effectiveRate: this.exchangeRate,
    };
  }
}

export class LimitOrderManager {
  private orders: Map<number, LimitOrder> = new Map();
  private conditions: Map<string, OnChainPriceThresholdCondition> = new Map();
  private router: DexRouter;
  private nextId = 1;

  constructor(router: DexRouter) {
    this.router = router;
  }

  public registerCondition(condition: OnChainPriceThresholdCondition) {
    this.conditions.set(condition.contractAddress, condition);
  }

  public createOrder(
    creator: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint,
    targetPrice: number,
    conditionAddress: string
  ): LimitOrder {
    const order: LimitOrder = {
      id: this.nextId++,
      creator,
      tokenIn,
      tokenOut,
      amountIn,
      minAmountOut,
      targetPrice,
      conditionAddress,
      status: "OPEN",
    };
    this.orders.set(order.id, order);
    return order;
  }

  public getOrder(id: number): LimitOrder {
    const ord = this.orders.get(id);
    if (!ord) throw new Error(`Order #${id} not found`);
    return ord;
  }

  /**
   * Keeper claims and executes order.
   *
   * 1. Evaluates on-chain condition (NOT off-chain check).
   * 2. Calls router.swap enforcing minAmountOut slippage protection.
   */
  public executeOrder(orderId: number): {
    orderId: number;
    amountIn: bigint;
    amountOut: bigint;
    price: number;
  } {
    const order = this.getOrder(orderId);
    if (order.status !== "OPEN") {
      throw new Error(`Order #${orderId} is not OPEN`);
    }

    // 1. CRITERION 1: Check on-chain condition
    const condition = this.conditions.get(order.conditionAddress);
    if (!condition) {
      throw new Error(`Condition contract ${order.conditionAddress} not registered`);
    }

    const isConditionMet = condition.check();
    if (!isConditionMet) {
      throw new Error(
        `PRICE_CONDITION_NOT_MET: Target price not reached. Condition check returned false.`
      );
    }

    // 2. CRITERION 2: Enforce slippage protection in swap
    const { amountOut, effectiveRate } = this.router.swap(
      order.amountIn,
      order.minAmountOut
    );

    order.status = "FILLED";

    return {
      orderId,
      amountIn: order.amountIn,
      amountOut,
      price: effectiveRate,
    };
  }

  public cancelOrder(orderId: number, caller: string): void {
    const order = this.getOrder(orderId);
    if (order.creator !== caller) {
      throw new Error("Unauthorized to cancel order");
    }
    if (order.status !== "OPEN") {
      throw new Error(`Cannot cancel order in status ${order.status}`);
    }
    order.status = "CANCELLED";
  }
}
