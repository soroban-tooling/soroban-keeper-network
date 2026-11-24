"use strict";

// Every sample task list shipped with this example must pass `--dry-run`, so
// the README's recipes cannot silently rot (an expired deadline, a changed
// bound). Dry run needs no secret key and makes no network calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { StrKey } = require("@stellar/stellar-sdk");

const SCRIPT = path.join(__dirname, "index.js");
// A syntactically valid contract ID; dry run never contacts it.
const REGISTRY = StrKey.encodeContract(Buffer.alloc(32, 1));

function collectSamples() {
  const samples = fs
    .readdirSync(__dirname)
    .filter((f) => /^tasks\.example\.(json|csv)$/.test(f))
    .map((f) => path.join(__dirname, f));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|csv)$/.test(entry.name)) samples.push(full);
    }
  };
  walk(path.join(__dirname, "recipes"));
  return samples;
}

for (const file of collectSamples()) {
  test(`dry run passes: ${path.relative(__dirname, file)}`, () => {
    const res = spawnSync(process.execPath, [SCRIPT, file, "--dry-run"], {
      cwd: __dirname,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NETWORK: "testnet",
        REGISTRY_CONTRACT_ID: REGISTRY,
      },
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Dry run complete/);
  });
}

test("partial-failure resume file is the tail of the full batch", () => {
  const dir = path.join(__dirname, "recipes", "partial-failure");
  const full = JSON.parse(fs.readFileSync(path.join(dir, "batch.json"), "utf8")).tasks;
  const rest = JSON.parse(
    fs.readFileSync(path.join(dir, "batch.remaining.json"), "utf8")
  ).tasks;
  assert.deepEqual(rest, full.slice(full.length - rest.length));
});
