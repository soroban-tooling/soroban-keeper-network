"use strict";

const ESTIMATED_CLAIM_FEE_STROOPS = 10_000n;
const ESTIMATED_EXECUTE_BASE_FEE_STROOPS = 50_000n;

/**
 * Calculates estimated gas fees and projected net profit for a candidate task.
 * Note: Per Issue #412, verifier-specific proof costs are omitted until contract
 * support lands.
 */
function estimateTaskProfitability({
  task,
  minProfitMargin = 0n,
  claimFee = ESTIMATED_CLAIM_FEE_STROOPS,
  executeFee = ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
}) {
  const totalEstimatedFees = BigInt(claimFee) + BigInt(executeFee);
  const reward = BigInt(task.reward !== undefined ? task.reward : 0);
  const netProfit = reward - totalEstimatedFees;
  const minMargin = BigInt(minProfitMargin);
  const profitable = netProfit >= minMargin;

  return {
    profitable,
    estimatedFee: totalEstimatedFees,
    netProfit,
    reason: profitable
      ? undefined
      : `Net profit (${netProfit} stroops) below minimum margin (${minMargin} stroops; reward=${reward}, est_fees=${totalEstimatedFees})`,
  };
}

module.exports = {
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
  estimateTaskProfitability,
};
