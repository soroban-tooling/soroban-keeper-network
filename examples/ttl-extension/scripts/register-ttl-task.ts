/**
 * Task Registration Script for Soroban TTL Extension
 *
 * Registers a recurring keeper task on the Keeper Network to keep
 * target dApp storage entries alive before expiration.
 */

import type { TtlExtensionTaskConfig } from "../src/ttl-extension.ts";
import { TtlExtensionManager } from "../src/ttl-extension.ts";

export function buildTtlTaskRegistration(config: TtlExtensionTaskConfig) {
  const cost = TtlExtensionManager.calculateCostModel(
    256, // estimated dApp state bytes
    config.extendToLedgers,
    config.keeperRewardStroops
  );

  return {
    target: config.contractAddress,
    function: "extend_ttl",
    args: [config.thresholdLedgers, config.extendToLedgers],
    reward: config.keeperRewardStroops.toString(),
    deadlineLedgers: config.deadlineLedgers,
    recurrence: {
      intervalLedgers: config.intervalLedgers,
      strategy: "conditional_storage_threshold",
    },
    costEstimate: {
      totalStroops: cost.totalCostStroops.toString(),
      totalXlm: cost.totalCostXlm.toFixed(7),
      percentSavedVsArchival: `${cost.archivalRestorationComparison.percentSaved.toFixed(1)}%`,
    },
  };
}

export function runCliRegistration(contractAddress?: string) {
  const target = contractAddress || "CB62...DAPP_STORAGE_CONTRACT";
  const task = buildTtlTaskRegistration({
    contractAddress: target,
    thresholdLedgers: 500, // extend when < 500 ledgers (~41 minutes)
    extendToLedgers: 10_000, // extend lifetime to 10,000 ledgers (~13.8 hours)
    keeperRewardStroops: 50_000n, // 0.005 XLM reward per keeper run
    deadlineLedgers: 100, // keeper must execute within 100 ledgers
    intervalLedgers: 5_000, // periodic task evaluation window
  });

  return task;
}

if (process.argv[1] && process.argv[1].endsWith("register-ttl-task.ts")) {
  console.log("=== Soroban Keeper Task Registration: TTL Extension ===");
  console.log(JSON.stringify(runCliRegistration(), null, 2));
}
