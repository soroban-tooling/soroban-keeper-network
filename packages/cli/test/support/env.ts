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

/** Stellar addresses derived from fixed seeds, so tests can match them exactly. */
export const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
export const KEEPER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();

/** A raw task as the contract returns it, pending and unclaimed. */
export const PENDING_RAW_TASK = {
  owner: OWNER,
  task_type: 0,
  calldata: new Uint8Array([1, 2, 3]),
  reward: 5_000_000n,
  deadline: 4_102_444_800n,
  ttl_ledgers: 17_280,
  status: 0,
  claimer: undefined,
  claim_ledger: undefined,
  lock_ledgers: 100,
};

/** The same task after a keeper claimed it at ledger 500. */
export const CLAIMED_RAW_TASK = {
  ...PENDING_RAW_TASK,
  status: 1,
  claimer: KEEPER,
  claim_ledger: 500,
};
