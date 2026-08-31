/**
 * Node.js secret-key signing example (issue 0260 in the SDK epic).
 *
 * The counterpart to the (not-yet-built) browser-wallet example: this
 * script signs directly with a `Keypair` loaded from an environment
 * variable, for automation contexts (cron jobs, serverless functions, a
 * keeper daemon) where a wallet-extension flow doesn't apply — the same
 * shape `examples/keeper-bot` already uses in production.
 *
 * Run:
 *   cp .env.example .env   # then fill in the real values
 *   npm run build          # from packages/sdk-ts — compiles the SDK itself
 *   npx tsx examples/node-signing/claim-task.ts
 *
 * (Or compile this file with `tsc` directly if you don't have `tsx`
 * installed — it has no other build step of its own.)
 */

import "dotenv/config";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import {
  KeeperRegistryClient,
  decodeKeeperError,
  isKeeperError,
  isNetworkName,
  KeeperErrorCode,
  withRetry,
  type NetworkName,
} from "@soroban-keeper-network/sdk";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and fill in your values.");
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const networkRaw = process.env.NETWORK ?? "testnet";
  if (!isNetworkName(networkRaw)) {
    console.error(
      `NETWORK must be one of testnet/futurenet/mainnet, got "${networkRaw}"`,
    );
    process.exit(1);
  }
  const network: NetworkName = networkRaw;

  const secretKey = requireEnv("KEEPER_SECRET_KEY");
  const contractId = requireEnv("REGISTRY_CONTRACT_ID");
  const taskId = BigInt(requireEnv("TASK_ID"));

  // Signing directly with a Keypair loaded from KEEPER_SECRET_KEY — this is
  // the whole point of this example versus a browser-wallet flow, which
  // signs via an external extension the SDK never sees the secret for.
  const keypair = Keypair.fromSecret(secretKey);

  const client = new KeeperRegistryClient({
    contractId,
    network,
    keypair,
  });

  console.log(`Signer:   ${keypair.publicKey()}`);
  console.log(`Network:  ${network}`);
  console.log(`Registry: ${contractId}`);
  console.log(`Claiming task #${taskId}...`);

  try {
    // withRetry: transient RPC/network errors are worth a retry; a
    // deterministic contract rejection (e.g. the task is already claimed)
    // never is — isPermanentError distinguishes the two so this script
    // doesn't waste fees resubmitting a call that can never succeed.
    await withRetry(
      () =>
        client.invoke("claim_task", [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(taskId, { type: "u64" }),
        ]),
      {
        maxRetries: 3,
        retryBaseMs: 500,
        isPermanentError: (err) => decodeKeeperError(err) !== undefined,
        onRetry: (attempt, delayMs, err) => {
          console.warn(
            `  attempt ${attempt + 1} failed, retrying in ${delayMs}ms: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      },
    );

    console.log(`Task #${taskId} claimed successfully.`);
  } catch (err) {
    // Typed error handling (issue 0166's decoder), not a raw try/catch on
    // an untyped error — a consumer branches on named error codes instead
    // of pattern-matching on message text, which breaks the moment the
    // contract's error message wording changes.
    if (isKeeperError(err, KeeperErrorCode.InvalidTaskStatus)) {
      console.error(
        `Task #${taskId} is not in a claimable state (already claimed, executed, or expired).`,
      );
    } else if (isKeeperError(err, KeeperErrorCode.TaskNotFound)) {
      console.error(`Task #${taskId} does not exist on this contract.`);
    } else if (isKeeperError(err, KeeperErrorCode.ContractPaused)) {
      console.error("The registry is currently paused — try again later.");
    } else {
      const decoded = decodeKeeperError(err);
      if (decoded) {
        console.error(
          `Contract rejected the call: ${decoded.name ?? `unknown error #${decoded.code}`}`,
        );
      } else {
        console.error(
          `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
