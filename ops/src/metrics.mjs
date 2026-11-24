/**
 * Canonical metric catalog for the Soroban Keeper Network.
 *
 * This is the machine-readable half of docs/OBSERVABILITY.md. Dashboards and
 * alert rules are checked against it by scripts/check-metrics.mjs so a rename
 * cannot silently leave either artifact pointing at a metric nobody exports.
 */

const family = (name, type, help, labels = []) => Object.freeze({ name, type, help, labels });

export const METRIC_CATALOG = Object.freeze({
  indexer: Object.freeze([
    family("soroban_indexer_ingestion_lag_ledgers", "gauge", "Head ledger minus last ingested ledger.", []),
    family("soroban_indexer_events_ingested_total", "counter", "Events ingested, by event type.", ["event_type"]),
    family("soroban_indexer_api_requests_total", "counter", "API requests by normalised route and status class.", ["route", "status"]),
    family("soroban_indexer_api_request_duration_seconds", "histogram", "API request latency by normalised route.", ["route"]),
    family("soroban_indexer_cache_hit_ratio", "gauge", "Ratio of cache hits to lookups.", []),
    family("soroban_indexer_rate_limit_rejections_total", "counter", "Requests rejected by the rate limiter.", []),
    family("soroban_indexer_websocket_connections", "gauge", "Currently open WebSocket connections.", []),
  ]),
  keeper: Object.freeze([
    family("soroban_keeper_tasks_evaluated_total", "counter", "Total candidate tasks evaluated.", []),
    family("soroban_keeper_tasks_claimed_total", "counter", "Total tasks claimed by the keeper.", []),
    family("soroban_keeper_tasks_claimed_by_type", "counter", "Tasks claimed by task type.", ["task_type"]),
    family("soroban_keeper_tasks_executed_total", "counter", "Total tasks successfully executed.", []),
    family("soroban_keeper_tasks_executed_by_type", "counter", "Tasks executed by task type.", ["task_type"]),
    family("soroban_keeper_tasks_skipped_total", "counter", "Total tasks skipped.", ["reason"]),
    family("soroban_keeper_tasks_skipped_by_type", "counter", "Tasks skipped by task type.", ["task_type", "reason"]),
    family("soroban_keeper_net_profit_stroops_total", "counter", "Net profit in stroops earned across executions.", []),
    family("soroban_keeper_net_profit_stroops_by_type", "counter", "Net profit in stroops by task type.", ["task_type"]),
    family("soroban_keeper_round_duration_seconds", "gauge", "Duration of the latest polling round in seconds.", []),
    family("soroban_keeper_balance_stroops", "gauge", "Current on-chain keeper balance in stroops.", ["address"]),
    family("soroban_keeper_rpc_errors_total", "counter", "RPC errors encountered by type.", ["error_type"]),
  ]),
  contract: Object.freeze([
    family("soroban_contract_paused", "gauge", "Whether the registry is paused (1) or not (0).", ["contract_id"]),
    family("soroban_contract_fees_accrued_stroops", "gauge", "Protocol fees awaiting sweep, in stroops.", ["contract_id"]),
    family("soroban_contract_task_count", "gauge", "Number of tasks ever registered.", ["contract_id"]),
    family("soroban_contract_version", "gauge", "Deployed registry contract VERSION.", ["contract_id"]),
    family("soroban_contract_instance_ttl_remaining_seconds", "gauge", "Approximate seconds until the contract instance TTL lapses.", ["contract_id"]),
  ]),
  canary: Object.freeze([
    family("soroban_canary_last_execution_timestamp_seconds", "gauge", "Unix timestamp of the last observed canary execution.", ["task_id"]),
    family("soroban_canary_time_to_execution_seconds", "gauge", "Seconds from canary registration to observed execution.", ["task_id"]),
    family("soroban_canary_executions_total", "counter", "Canary executions observed within the target window.", ["task_id"]),
    family("soroban_canary_missed_executions_total", "counter", "Canary rounds where no execution was observed in time.", ["task_id"]),
  ]),
});

export const ALL_METRICS = Object.freeze(Object.values(METRIC_CATALOG).flat());
export const ALL_METRIC_NAMES = Object.freeze(ALL_METRICS.map((metric) => metric.name));

export function escapeLabelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function formatLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

/** Renders samples in Prometheus text exposition format, one HELP/TYPE per family. */
export function renderPrometheus(samples) {
  const seenFamilies = new Set();
  const lines = [];
  for (const sample of samples) {
    const metric = ALL_METRICS.find((entry) => entry.name === sample.name);
    if (!metric) throw new Error(`Unknown metric family: ${sample.name}`);
    if (!seenFamilies.has(metric.name)) {
      seenFamilies.add(metric.name);
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
    }
    lines.push(`${metric.name}${formatLabels(sample.labels)}${Number(sample.value)}`);
  }
  return `${lines.join("\n")}\n`;
}
