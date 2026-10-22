import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import type { RpcServerLike } from "@soroban-keeper-network/sdk";

import { CliError, ExitCode } from "./errors.js";

/** The subset of the standard `WebSocket` constructor the event stream uses, so a test can supply a stand-in. */
export interface WebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface CliIo {
  /** Results: the only thing written to stdout, so it can be piped. */
  stdout(text: string): void;
  /** Diagnostics, fee previews and errors. */
  stderr(text: string): void;
  /** Whether a person can answer a prompt. */
  isTTY: boolean;
  /** Asks a yes/no question; only called when `isTTY` is true. */
  confirm(question: string): Promise<boolean>;
}

/**
 * Everything a command touches outside its own arguments. Production fills
 * this from the process (see `bin.ts`); tests substitute each field, which is
 * how the suite runs end to end without a network, a terminal or a real key.
 */
export interface Runtime {
  env: Record<string, string | undefined>;
  io: CliIo;
  readFile(path: string): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Aborted on SIGINT/SIGTERM, which is how `events watch` ends. */
  signal: AbortSignal;
  /** Pre-built RPC server. Unset in production, where one is built from the RPC URL. */
  server?: RpcServerLike | undefined;
  /** WebSocket implementation. Unset means the runtime's global, if it has one. */
  WebSocketImpl?: WebSocketCtor | undefined;
  /** Delay between transaction-confirmation polls. Unset uses the SDK default. */
  confirmPollIntervalMs?: number | undefined;
  /** Secret values to scrub from any error message. Filled when a key is loaded. */
  secrets: string[];
}

/** The real process-backed {@link CliIo}. */
export function processIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** The real process-backed {@link Runtime}. */
export function processRuntime(signal: AbortSignal): Runtime {
  return {
    env: process.env,
    io: processIo(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        throw new CliError(`Could not read ${path}.`, ExitCode.Usage, "usage");
      }
    },
    now: () => Date.now(),
    // Resolves early on abort, so Ctrl-C ends a poll wait immediately.
    sleep: (ms) =>
      new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      }),
    signal,
    secrets: [],
  };
}
