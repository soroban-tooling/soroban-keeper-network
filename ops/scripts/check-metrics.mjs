/**
 * Cross-checks the canonical catalog against the shipped artifacts.
 *
 * Run from anywhere: node ops/scripts/check-metrics.mjs
 * Exits non-zero with a readable message when a dashboard or alert rule has
 * drifted from the documented metric names.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ALL_METRIC_NAMES, METRIC_CATALOG } from "../src/metrics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const dashboards = {
  indexer: JSON.parse(read("grafana/indexer.json")),
  keeper: JSON.parse(read("grafana/keeper-bot-v2.json")),
};
const alertText = read("prometheus/alerts.yml");

for (const [component, dashboard] of Object.entries(dashboards)) {
  const variableNames = (dashboard.templating?.list ?? []).map((item) => item.name);
  assert.ok(variableNames.includes("DS_PROMETHEUS"), `${component} dashboard is missing the DS_PROMETHEUS datasource variable`);
  assert.ok((dashboard.panels ?? []).length > 0, `${component} dashboard has no panels`);
}

const serialized = Object.fromEntries(
  Object.entries(dashboards).map(([component, dashboard]) => [component, JSON.stringify(dashboard)]),
);

for (const [component, metrics] of Object.entries(METRIC_CATALOG)) {
  const dashboardKey = component === "indexer" ? "indexer" : "keeper";
  for (const metric of metrics) {
    assert.ok(
      serialized[dashboardKey].includes(metric.name),
      `${metric.name} (${component}) is missing from ops/grafana/${dashboardKey}.json`,
    );
  }
}

const alertBlocks = [...alertText.matchAll(/^\s*- alert: (\S+)\s*$/gm)];
assert.ok(alertBlocks.length > 0, "no alerts found in ops/prometheus/alerts.yml");

const names = new Set();
for (let index = 0; index < alertBlocks.length; index += 1) {
  const name = alertBlocks[index][1];
  assert.ok(!names.has(name), `duplicate alert name: ${name}`);
  names.add(name);

  const blockStart = alertBlocks[index].index;
  const blockEnd = index + 1 < alertBlocks.length ? alertBlocks[index + 1].index : alertText.length;
  const block = alertText.slice(blockStart, blockEnd);

  const expr = block.match(/^\s*expr:\s*(.+)$/m)?.[1];
  assert.ok(expr, `alert ${name} has no expr`);

  const runbook = block.match(/^\s*runbook_url:\s*(\S+)\s*$/m)?.[1];
  assert.ok(runbook, `alert ${name} has no runbook_url annotation`);
  assert.ok(runbook.startsWith("https://github.com/soroban-tooling/soroban-keeper-network/blob/main/docs/runbooks/"), `alert ${name} links to an unexpected runbook: ${runbook}`);

  const referenced = [...expr.matchAll(/soroban_[a-z0-9_]+/g)].map((match) => match[0]);
  assert.ok(referenced.length > 0, `alert ${name} does not reference a documented metric`);
  for (const metric of referenced) {
    assert.ok(ALL_METRIC_NAMES.includes(metric), `alert ${name} references undocumented metric ${metric}`);
  }
}

console.log(`metric catalog: ${ALL_METRIC_NAMES.length} families across ${Object.keys(METRIC_CATALOG).length} components`);
console.log(`dashboards: 2 valid, all catalog metrics represented`);
console.log(`alerts: ${names.size} with unique names, runbook links and documented metrics`);
