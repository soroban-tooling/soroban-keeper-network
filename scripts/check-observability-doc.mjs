/**
 * Validates docs/OBSERVABILITY.md against the canonical metric and alert
 * names used by the dashboards and Prometheus rules in ops/.
 *
 * This copy of the catalog lives in the docs PR so the two PRs can merge in
 * either order. Keep it in sync with ops/src/metrics.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(path.join(root, "docs/OBSERVABILITY.md"), "utf8");

const METRICS = [
  "soroban_indexer_ingestion_lag_ledgers",
  "soroban_indexer_events_ingested_total",
  "soroban_indexer_api_requests_total",
  "soroban_indexer_api_request_duration_seconds",
  "soroban_indexer_cache_hit_ratio",
  "soroban_indexer_rate_limit_rejections_total",
  "soroban_indexer_websocket_connections",
  "soroban_keeper_tasks_evaluated_total",
  "soroban_keeper_tasks_claimed_total",
  "soroban_keeper_tasks_claimed_by_type",
  "soroban_keeper_tasks_executed_total",
  "soroban_keeper_tasks_executed_by_type",
  "soroban_keeper_tasks_skipped_total",
  "soroban_keeper_tasks_skipped_by_type",
  "soroban_keeper_net_profit_stroops_total",
  "soroban_keeper_net_profit_stroops_by_type",
  "soroban_keeper_round_duration_seconds",
  "soroban_keeper_balance_stroops",
  "soroban_keeper_rpc_errors_total",
  "soroban_contract_paused",
  "soroban_contract_fees_accrued_stroops",
  "soroban_contract_task_count",
  "soroban_contract_version",
  "soroban_contract_instance_ttl_remaining_seconds",
  "soroban_canary_last_execution_timestamp_seconds",
  "soroban_canary_time_to_execution_seconds",
  "soroban_canary_executions_total",
  "soroban_canary_missed_executions_total",
];

const ALERTS = [
  "IndexerIngestionLag",
  "IndexerIngestFailures",
  "IndexerApiErrorRate",
  "KeeperRpcErrors",
  "KeeperBalanceNotGrowing",
  "KeeperRoundsStalled",
  "CanaryExecutionLate",
];

const LOG_FIELDS = ["timestamp", "level", "component", "event", "message"];

for (const metric of METRICS) {
  assert.ok(text.includes(`\`${metric}\``), `OBSERVABILITY.md is missing metric ${metric}`);
}
for (const alert of ALERTS) {
  assert.ok(text.includes(`\`${alert}\``), `OBSERVABILITY.md is missing alert ${alert}`);
}
for (const field of LOG_FIELDS) {
  assert.ok(text.includes(`\`${field}\``), `OBSERVABILITY.md is missing log field ${field}`);
}
assert.ok(text.includes("docs/runbooks/rpc-outage.md"), "OBSERVABILITY.md must link the RPC outage runbook");
assert.ok(text.includes("docs/runbooks/ops-alerts.md"), "OBSERVABILITY.md must link the ops alert runbook");

console.log(`observability doc: ${METRICS.length} metrics, ${ALERTS.length} alerts, ${LOG_FIELDS.length} required log fields`);
