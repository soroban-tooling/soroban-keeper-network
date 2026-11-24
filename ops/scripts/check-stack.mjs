// Preflight for the local observability stack.
// The rule file and dashboards are supplied by the monitoring and alerting
// work, so a clone without them gets an actionable error instead of a
// half provisioned Prometheus or Grafana container.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const opsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? opsDir);

const required = [
  "docker-compose.yml",
  "prometheus/prometheus.yml",
  "prometheus/alerts.yml",
  "grafana/indexer.json",
  "grafana/keeper-bot-v2.json",
];

const missing = required.filter((relative) => !existsSync(join(root, relative)));

if (missing.length > 0) {
  console.error("Observability stack is incomplete. Missing files:");
  for (const file of missing) {
    console.error(`  ${file}`);
  }
  console.error("The alert rules and dashboards come from the monitoring and alerting work.");
  console.error("See docs/OBSERVABILITY.md before running docker compose up.");
  process.exit(1);
}

console.log("Observability stack prerequisites are present.");
