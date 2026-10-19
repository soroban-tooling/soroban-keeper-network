#!/usr/bin/env node
import { run } from "./cli.js";

const result = await run(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
