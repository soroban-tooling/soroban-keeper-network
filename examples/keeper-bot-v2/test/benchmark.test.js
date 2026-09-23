"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  generateCandidateTasks,
  runV1Simulation,
  runV2Simulation,
} = require("../benchmark/benchmark.js");

describe("Benchmark harness verification (Issue #413)", () => {
  it("generates deterministic candidate load", () => {
    const tasks1 = generateCandidateTasks(10);
    const tasks2 = generateCandidateTasks(10);
    assert.strictEqual(tasks1.length, 10);
    assert.strictEqual(tasks2.length, 10);
    assert.strictEqual(tasks1[0].reward, tasks2[0].reward);
    assert.strictEqual(tasks1[9].taskId, tasks2[9].taskId);
  });

  it("demonstrates round latency improvement of v2 over v1 under identical conditions", async () => {
    const candidates = generateCandidateTasks(10);
    const contested = new Set(["2", "5", "8"]);

    const v1Res = await runV1Simulation(candidates, contested);
    const v2Res = await runV2Simulation(candidates, contested, 4);

    // v2 with concurrency should complete in significantly less time than sequential v1
    assert.ok(
      v2Res.durationMs < v1Res.durationMs,
      `Expected v2 latency (${v2Res.durationMs}ms) to be less than v1 (${v1Res.durationMs}ms)`
    );

    // v1 treats contested as errors; v2 treats them as success-with-skip
    assert.strictEqual(v1Res.errorsCount, contested.size);
    assert.strictEqual(v2Res.errorsCount, 0);
    assert.strictEqual(v2Res.lostRacesHandled, contested.size);
  });

  it("verifies benchmark REPORT.md exists and contains committed evaluation", () => {
    const reportPath = path.join(__dirname, "../benchmark/REPORT.md");
    assert.ok(fs.existsSync(reportPath), "REPORT.md must exist in benchmark directory");
    const content = fs.readFileSync(reportPath, "utf8");
    assert.ok(content.includes("# Keeper Bot v1 vs v2 Benchmark Report"));
    assert.ok(content.includes("Round Latency"));
    assert.ok(content.includes("Competition Resiliency"));
  });
});
