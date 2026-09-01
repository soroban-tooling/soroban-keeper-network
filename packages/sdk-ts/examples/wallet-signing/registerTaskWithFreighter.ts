/**
 * Worked example: connecting Freighter, building an unsigned `registerTask`
 * transaction via the SDK, requesting the wallet's signature, and
 * submitting the signed result. See backlog 0190 / issue #259.
 *
 * ## Verification status — read before relying on this
 *
 * This example is written against `@stellar/freighter-api`'s documented,
 * published type declarations (`signTransaction`, `getAddress`,
 * `requestAccess`, `isConnected` — all confirmed against the real installed
 * package's `.d.ts` files, not guessed from memory) and this SDK's own
 * `buildTransaction`/`submitSignedTransaction` primitives (`transactionBuilder.ts`,
 * exercised by that module's own unit tests against a real keypair
 * standing in for a wallet).
 *
 * **It has not been run against the real Freighter browser extension** —
 * this environment has no browser, so the acceptance criterion "actually
 * tested against a real wallet extension in a browser, not just reasoned
 * about from the wallet's documented API" is **not met by this commit**.
 * Before this ships: load the extension, connect a funded testnet account,
 * and run through `main()` below end to end, confirming in particular:
 *   - the exact shape Freighter's signing prompt shows the user for a
 *     Soroban contract-invocation transaction (not just a classic payment),
 *   - that `signTransaction`'s returned `signedTxXdr` round-trips through
 *     `submitSignedTransaction` without a re-parse error, and
 *   - the real error shape Freighter returns when a user clicks "Reject"
 *     (assumed here to be `response.error` being present, per the
 *     documented `FreighterApiError` shape — not confirmed against a real
 *     rejection click).
 *
 * ## Usage
 *
 * This file is a library module, not a script — wire `main()` into a
 * button handler in a real dApp. It assumes it runs in a browser (Freighter
 * injects itself onto `window`); it is not meant to run under Node, unlike
 * the secret-key example in `examples/wallet-signing/registerTaskNodeSigning.ts` (issue #191's scope, not built here).
 */

import {
  getAddress,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import { nativeToScVal } from "@stellar/stellar-sdk";

import { KeeperRegistryClient } from "../../src/client";
import { TaskType } from "../../src/types";

/** Thrown when the user declines the signature request in their wallet — a normal, expected outcome a dApp must handle gracefully, not a bug. */
export class WalletSignatureRejectedError extends Error {
  constructor(reason: string) {
    super(`Wallet signature request was rejected or failed: ${reason}`);
    this.name = "WalletSignatureRejectedError";
  }
}

export interface RegisterTaskParams {
  taskType: TaskType;
  calldata: Uint8Array;
  /** Reward in stroops (i128). */
  reward: bigint;
  /** Unix timestamp, seconds. */
  deadline: number;
  ttlLedgers: number;
  lockLedgers: number;
}

/**
 * Connects Freighter (prompting the user if not already authorized),
 * builds an unsigned `register_task` transaction via the SDK, requests
 * Freighter's signature, and submits the signed result.
 *
 * Returns the submitted transaction's task id on success, or throws
 * {@link WalletSignatureRejectedError} if the user declined to sign —
 * callers should catch this specifically to show a calm "signature
 * cancelled" message rather than a generic error state, since declining is
 * a normal, expected outcome, not a failure of the app.
 */
export async function registerTaskWithFreighter(
  client: KeeperRegistryClient,
  params: RegisterTaskParams,
): Promise<void> {
  const connected = await isConnected();
  if (connected.error || !connected.isConnected) {
    throw new Error("Freighter is not installed or not available in this browser.");
  }

  // `getAddress` returns the currently-selected account without a
  // permission prompt if the site was already authorized; `requestAccess`
  // is the one that actually shows Freighter's connect prompt. Try the
  // cheap path first — don't prompt the user again on every call if the
  // site is already connected.
  let address = (await getAddress()).address;
  if (!address) {
    const accessResult = await requestAccess();
    if (accessResult.error || !accessResult.address) {
      throw new WalletSignatureRejectedError(accessResult.error?.message ?? "connection request declined");
    }
    address = accessResult.address;
  }

  const args = [
    nativeToScVal(params.taskType, { type: "u32" }),
    nativeToScVal(params.calldata, { type: "bytes" }),
    nativeToScVal(params.reward, { type: "i128" }),
    nativeToScVal(params.deadline, { type: "u64" }),
    nativeToScVal(params.ttlLedgers, { type: "u32" }),
    nativeToScVal(params.lockLedgers, { type: "u32" }),
  ];

  // `buildTransaction` returns an already-simulated, assembled envelope
  // (resource footprint attached) — see its doc comment. Freighter's
  // `signTransaction` signs whatever XDR it's handed as-is; it does not
  // simulate on the caller's behalf, so the SDK must hand it a
  // fully-assembled envelope, not a bare unsimulated one.
  const unsigned = await client.buildTransaction(address, "register_task", args);

  const signResult = await signTransaction(unsigned.xdr, {
    networkPassphrase: unsigned.networkPassphrase,
    address,
  });

  if (signResult.error || !signResult.signedTxXdr) {
    throw new WalletSignatureRejectedError(signResult.error?.message ?? "no signed transaction returned");
  }

  await client.submitSignedTransaction(signResult.signedTxXdr);
}
