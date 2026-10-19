import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

/** A throwaway directory for one test. Call `cleanup` in `afterEach`. */
export async function scratchDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "skn-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A structurally valid secret seed for tests. It is not a funded or real key. */
export const TEST_SECRET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).secret();

export const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
