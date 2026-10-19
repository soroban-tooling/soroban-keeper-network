#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { run } from "./cli.js";

// Ask before submitting a transaction only when a person can answer. Scripts
// that cannot answer must pass --yes.
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

const confirm = interactive
  ? async (question: string): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    }
  : undefined;

const result = await run(process.argv.slice(2), { confirm });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
