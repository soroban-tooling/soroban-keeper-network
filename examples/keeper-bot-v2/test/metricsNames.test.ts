import { describe, it } from "vitest";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { MetricsCollector, startMetricsServer } from "../src/metrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const observabilityDoc = fs.readFileSync(path.resolve(here, "../../../docs/OBSERVABILITY.md"), "utf8");

/** Reads the backticked names out of the first cell of a table section. */
function documentedNames(startHeading: string, endHeading: string): Set<string> {
  const start = observabilityDoc.indexOf(startHeading);
  assert.notStrictEqual(start, -1, `${startHeading} missing from docs/OBSERVABILITY.md`);
  const end = observabilityDoc.indexOf(endHeading, start + startHeading.length);
  const section = observabilityDoc.slice(start, end === -1 ? undefined : end);

  const names = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    const match = firstCell.match(/`([^`]+)`/);
    if (match) names.add(match[1]);
  }
  assert.ok(names.size > 0, `no metric names parsed from ${startHeading}`);
  return names;
}

/** Extracts metric family names from a Prometheus text exposition. */
export function exposedNames(exposition: string): Set<string> {
  const names = new Set<string>();
  for (const line of exposition.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    names.add(trimmed.split(/[\s{]/)[0]);
  }
  return names;
}

/** Fails when an exposition contains a name absent from the catalogue. */
export function assertAllDocumented(exposition: string, documented: Set<string>): void {
  const undocumented = [...exposedNames(exposition)].filter((name) => !documented.has(name));
  assert.deepStrictEqual(
    undocumented,
    [],
    `undocumented or renamed metrics: ${undocumented.join(", ")}. Add them to docs/OBSERVABILITY.md.`
  );
}

async function scrape(collector: MetricsCollector): Promise<string> {
  const server = startMetricsServer(collector, 0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${address.port}/metrics`, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
    return body;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function populatedCollector(): MetricsCollector {
  const collector = new MetricsCollector();
  collector.recordEvaluation(10);
  collector.recordClaim("ttl_extension");
  collector.recordExecution("ttl_extension", 150000n);
  collector.recordSkip("ttl_extension", "unprofitable");
  collector.setRoundDuration(1.25);
  collector.setKeeperBalance("GFAKEPUBLICADDRESS", 900000n);
  collector.recordRpcError("timeout");
  return collector;
}

describe("metric names match docs/OBSERVABILITY.md", () => {
  const documented = documentedNames("### Keeper bots", "### Indexer");

  it("exposes only names listed in the keeper bot catalogue", async () => {
    const exposition = await scrape(populatedCollector());
    assertAllDocumented(exposition, documented);
  });

  it("emits the core keeper metric families", async () => {
    const names = exposedNames(await scrape(populatedCollector()));
    const core = [
      "soroban_keeper_tasks_evaluated_total",
      "soroban_keeper_tasks_claimed_total",
      "soroban_keeper_tasks_executed_total",
      "soroban_keeper_tasks_skipped_total",
      "soroban_keeper_net_profit_stroops_total",
      "soroban_keeper_round_duration_seconds",
      "soroban_keeper_balance_stroops",
      "soroban_keeper_rpc_errors_total",
    ];
    for (const name of core) {
      assert.ok(names.has(name), `${name} missing from /metrics`);
    }
  });

  it("fails on a renamed or undocumented metric", () => {
    const renamed = "soroban_keeper_tasks_evaluate_total 3\n";
    assert.throws(() => assertAllDocumented(renamed, documented), /undocumented or renamed metrics/);
  });

  it("keeps the catalogue itself non-empty and uniquely named", () => {
    const fromDoc = documentedNames("### Keeper bots", "### Indexer");
    assert.ok(fromDoc.has("soroban_keeper_tasks_skipped_total"));
    assert.ok(fromDoc.size >= 8);
  });
});
