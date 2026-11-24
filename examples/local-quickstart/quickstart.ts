#!/usr/bin/env node

/**
 * One-command CLI entry point for the local network quickstart.
 * Usage: npm start (or node quickstart.ts)
 */

import { QuickstartEngine } from "./src/quickstart-engine.ts";

async function main() {
  const engine = new QuickstartEngine();
  const result = await engine.run();

  for (const logLine of result.logs) {
    console.log(logLine);
  }
}

main().catch((err) => {
  console.error("Quickstart failed:", err);
  process.exit(1);
});
