import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "check-stack.mjs",
);
const required = [
  "docker-compose.yml",
  "prometheus/prometheus.yml",
  "prometheus/alerts.yml",
  "grafana/indexer.json",
  "grafana/keeper-bot-v2.json",
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "check-stack-"));
  for (const file of required) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n");
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

test("passes when every required file exists", () => {
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /prerequisites are present/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names every missing file and exits non zero", () => {
  const root = fixture();
  try {
    rmSync(join(root, "prometheus/alerts.yml"));
    rmSync(join(root, "grafana/indexer.json"));
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /prometheus\/alerts\.yml/);
    assert.match(result.stderr, /grafana\/indexer\.json/);
    assert.match(result.stderr, /docs\/OBSERVABILITY\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
