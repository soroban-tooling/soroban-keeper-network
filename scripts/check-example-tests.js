#!/usr/bin/env node
"use strict";

// Fails if any Node example under examples/ lacks a `test` script, so a new
// example cannot be added without a command CI can run. Rust examples under
// rust-sdk/examples/ are reported but not enforced; see docs/CI.md.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const missing = [];

for (const entry of fs.readdirSync(path.join(root, "examples"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(root, "examples", entry.name, "package.json");
  if (!fs.existsSync(pkgPath)) {
    missing.push(`examples/${entry.name}: no package.json`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const test = pkg.scripts && pkg.scripts.test;
  if (!test || /no test specified/.test(test)) {
    missing.push(`examples/${entry.name}: package.json has no "test" script`);
  } else {
    console.log(`ok  examples/${entry.name}: npm test -> ${test}`);
  }
}

const rustDir = path.join(root, "rust-sdk", "examples");
if (fs.existsSync(rustDir)) {
  for (const entry of fs.readdirSync(rustDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      console.log(`note rust-sdk/examples/${entry.name}: Rust example, not covered by this check`);
    }
  }
}

if (missing.length > 0) {
  for (const m of missing) console.error(`::error::${m}`);
  process.exit(1);
}
