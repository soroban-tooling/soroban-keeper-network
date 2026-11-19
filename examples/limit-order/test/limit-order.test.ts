import test from "node:test";
import assert from "node:assert/strict";
import {
  OnChainPriceThresholdCondition,
  DexRouter,
  LimitOrderManager,
} from "../src/limit-order.ts";
import { buildLimitOrderKeeperTask } from "../scripts/register-limit-order-task.ts";

test("Criterion 1: Task uses on-chain price-threshold condition, rejecting off-chain overrides", () => {
  const router = new DexRouter(2.5);
  const manager = new LimitOrderManager(router);

  const oracleFeed = {
    assetPair: "XLM/USDC",
    price: 0.12, // current price = $0.12
    decimals: 7,
    lastUpdatedTimestamp: Date.now(),
  };

  // Deploy on-chain condition: trigger when price >= $0.15
  const condition = new OnChainPriceThresholdCondition(
    "CC_PRICE_THRESHOLD_CONDITION",
    oracleFeed,
    0.15, // target price $0.15
    true  // direction: above or equal
  );
  manager.registerCondition(condition);

  // User creates limit order
  const order = manager.createOrder(
    "GB_TRADER",
    "CA_XLM",
    "CA_USDC",
    10_000_000_000n, // 1,000 XLM
    145_000_000n,    // min 145 USDC (allowing up to ~3.3% slippage from 150)
    0.15,
    condition.contractAddress
  );

  // 1. Current price is $0.12 (< $0.15). On-chain condition check must return false!
  assert.equal(condition.check(), false);

  // Attempting to execute order must fail because the attached condition is not satisfied
  assert.throws(
    () => manager.executeOrder(order.id),
    /PRICE_CONDITION_NOT_MET/,
    "Execution must be rejected when on-chain condition evaluates to false"
  );

  // 2. Oracle updates on-chain price to $0.16 (meets threshold)
  condition.updateOraclePrice(0.16);
  assert.equal(condition.check(), true);

  // Router exchange rate reflects market price ($0.155)
  router.setPoolExchangeRate(0.0155); // 1,000 XLM * 0.0155 = 155 USDC >= 145 USDC

  const fill = manager.executeOrder(order.id);
  assert.equal(fill.orderId, order.id);
  assert.equal(fill.amountOut, 155_000_000n);
  assert.equal(manager.getOrder(order.id).status, "FILLED");
});

test("Criterion 2: Slippage protection is strictly enforced in the swap call", () => {
  const router = new DexRouter(1.0);
  const manager = new LimitOrderManager(router);

  const oracleFeed = {
    assetPair: "XLM/USDC",
    price: 0.20,
    decimals: 7,
    lastUpdatedTimestamp: Date.now(),
  };

  const condition = new OnChainPriceThresholdCondition(
    "CC_CONDITION_SLIPPAGE_TEST",
    oracleFeed,
    0.20,
    true
  );
  manager.registerCondition(condition);

  // User deposits 1,000 XLM and requests MINIMUM 195 USDC (max 2.5% slippage on $200 target)
  const amountIn = 1_000n;
  const minAmountOut = 195n;

  const order = manager.createOrder(
    "GB_ALICE",
    "CA_XLM",
    "CA_USDC",
    amountIn,
    minAmountOut,
    0.20,
    condition.contractAddress
  );

  // Scenario A: Price condition met, but DEX pool liquidity suffers severe slippage (rate = 0.18 -> output = 180 < 195)
  router.setPoolExchangeRate(0.18);

  assert.throws(
    () => manager.executeOrder(order.id),
    /SLIPPAGE_EXCEEDED.*below user minimum 195/,
    "Swap MUST abort when actual output is below minAmountOut"
  );
  assert.equal(manager.getOrder(order.id).status, "OPEN", "Order must remain OPEN on slippage abort");

  // Scenario B: DEX pool recovers or arb trades improve rate to 0.198 (output = 198 >= min 195)
  router.setPoolExchangeRate(0.198);

  const fill = manager.executeOrder(order.id);
  assert.equal(fill.amountOut, 198n);
  assert.equal(manager.getOrder(order.id).status, "FILLED");

  // Verify keeper task generation attaches condition
  const task = buildLimitOrderKeeperTask("CC_LIMIT_ORDER_ROUTER", order);
  assert.equal(task.targetContract, "CC_LIMIT_ORDER_ROUTER");
  assert.equal(task.conditionAddress, condition.contractAddress);
  assert.equal(task.rewardStroops, "100000");
});
