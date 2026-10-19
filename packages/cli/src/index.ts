#!/usr/bin/env node
// Entry point for the `skn` binary. All behaviour lives in cli.ts; this file
// only binds it to the real process.

import { homedir } from "node:os";

import { run } from "./cli.js";

const exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  homedir: homedir(),
  platform: process.platform,
});
process.exitCode = exitCode;
