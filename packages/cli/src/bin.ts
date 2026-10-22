#!/usr/bin/env node
import { run } from "./index.js";
import { processRuntime } from "./runtime.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

run(process.argv.slice(2), processRuntime(controller.signal)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // run() does not throw; this is a last resort for a bug in the CLI itself.
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
