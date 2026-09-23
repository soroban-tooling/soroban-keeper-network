"use strict";

const { estimateTaskProfitability } = require("./profitability.js");

/**
 * Evaluates candidate tasks and prioritizes them in descending order of net profit.
 */
function prioritizeCandidates(tasks, options = {}) {
  const { minProfitMargin = 0n, skipUnprofitable = true } = options;

  const evaluated = tasks.map((task) => {
    const profitInfo = estimateTaskProfitability({
      task,
      minProfitMargin,
    });
    return {
      task,
      profitInfo,
    };
  });

  const filtered = skipUnprofitable
    ? evaluated.filter((item) => item.profitInfo.profitable)
    : evaluated;

  // Sort descending by net profit (highest first)
  filtered.sort((a, b) => {
    if (a.profitInfo.netProfit > b.profitInfo.netProfit) return -1;
    if (a.profitInfo.netProfit < b.profitInfo.netProfit) return 1;
    return 0;
  });

  return filtered;
}

module.exports = {
  prioritizeCandidates,
};
