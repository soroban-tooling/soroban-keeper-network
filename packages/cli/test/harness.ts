/**
 * Runs `skn` in-process against the SDK's fake RPC.
 *
 * The fake is imported from packages/sdk-ts's own test support rather than
 * copied, so these tests exercise the same real XDR encode/decode round trip
 * the SDK's suite does. Nothing here touches the network or the real user
 * config directory: every run gets a fresh temporary home and working
 * directory unless the test supplies its own.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";

import { FakeRpc, type FakeRpcOptions } from "../../sdk-ts/test/support/fakeRpc.js";
import { run } from "../src/cli.js";

export { FakeRpc };

/** A valid, deterministic contract ID (the SDK test suite's). */
export const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

export const KEEPER_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
export const KEEPER = KEEPER_KEYPAIR.publicKey();
/** The secret every leak test searches output for. */
export const SECRET = KEEPER_KEYPAIR.secret();

export interface RunOptions {
  env?: Record<string, string | undefined>;
  rpc?: FakeRpc | FakeRpcOptions;
  cwd?: string;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, for assertions that a value appears in neither. */
  output: string;
  rpc: FakeRpc;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skn-test-"));
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const rpc = options.rpc instanceof FakeRpc ? options.rpc : new FakeRpc(options.rpc ?? {});
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: options.env ?? {},
    cwd: options.cwd ?? (await tempDir()),
    homedir: options.home ?? (await tempDir()),
    platform: options.platform ?? process.platform,
    server: rpc,
  });
  return { code, stdout, stderr, output: stdout + stderr, rpc };
}

/** A task as `scValToNative` decodes the contract's `Task` struct. */
export function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: KEEPER,
    task_type: 0,
    calldata: new Uint8Array([1, 2, 3]),
    reward: 5_000_000n,
    deadline: 1_700_000_000n,
    ttl_ledgers: 17_280,
    status: 1,
    claimer: KEEPER,
    claim_ledger: 990,
    lock_ledgers: 100,
    ...overrides,
  };
}

/** `Error(Contract, #code)` as a failed simulation renders it. */
export function contractError(code: number): string {
  return `host invocation failed: Error(Contract, #${code})`;
}
