// Lower-level transaction-building primitives for callers who don't hand
// the SDK a private key: a browser dApp driving a wallet-signing flow
// (backlog 0170, issue #259's worked example), or a sponsor wrapping a
// user's transaction in a fee-bump envelope so the user doesn't need XLM
// for fees (backlog 0172, issue #241).
//
// The per-method convenience wrappers (`client.getTask`, and the
// server-side/secret-key methods the rest of this epic adds) are built on
// `ContractInvoker.invoke`, which signs and submits directly — this module
// is the alternative path for when the SDK must never see a signing key.

import { BASE_FEE, nativeToScVal, rpc as SorobanRpc, type Transaction, TransactionBuilder as StellarTransactionBuilder } from "@stellar/stellar-sdk";

import type { KeeperRegistryClient } from "./client";

/**
 * An unsigned transaction plus enough metadata for a caller to drive its
 * own signing flow (a wallet extension, an offline signer, a fee-bump
 * sponsor). `signerAccounts` lists which account(s) must sign — dual-auth
 * admin methods (`transferAdmin`, etc., backlog 0162) need both the current
 * and incoming admin; every other method needs just the source account.
 */
export interface UnsignedTransaction {
  /** Base64 XDR of the unsigned transaction envelope. */
  xdr: string;
  /** Public keys of every account that must sign before submission. */
  signerAccounts: string[];
  networkPassphrase: string;
}

/**
 * Builds an unsigned transaction invoking `method` with `args`, **already
 * simulated and assembled** (the Soroban resource footprint attached) —
 * the returned XDR is ready to hand directly to a wallet's `signTransaction`
 * or a fee-bump sponsor with no further simulation step required or safe to
 * perform. Soroban's resource footprint is part of what gets signed, so it
 * must be attached *before* any signature is collected; simulating again
 * afterward (e.g. inside {@link submitSignedTransaction}) would invalidate
 * a signature already collected over the earlier footprint — that function
 * deliberately does not re-simulate for this reason.
 *
 * `signerAccounts` currently always returns exactly `[sourcePublicKey]` —
 * every method landed so far in this epic (`getTask`, the read/write split
 * in `ContractInvoker`) is single-auth. The dual-auth admin methods
 * (backlog 0162) will need to extend this to return both signers once they
 * land; this shape is deliberately an array (not a single string) so that
 * extension doesn't require a breaking type change here.
 */
export async function buildTransaction(
  client: KeeperRegistryClient,
  sourcePublicKey: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
): Promise<UnsignedTransaction> {
  const tx = await client.invoker.buildAndAssembleTransaction(sourcePublicKey, method, args);
  return {
    xdr: tx.toXDR(),
    signerAccounts: [sourcePublicKey],
    networkPassphrase: client.config.networkPassphrase,
  };
}

/**
 * Wraps an already fully-signed inner transaction (the user's signed
 * `registerTask` call, say) in a fee-bump envelope paid by `sponsorPublicKey`,
 * following Stellar's standard fee-bump transaction structure
 * (`TransactionBuilder.buildFeeBumpTransaction`). The returned envelope
 * still needs `sponsorPublicKey`'s signature before submission — this
 * function only builds it, matching {@link buildTransaction}'s
 * build-then-sign-separately shape.
 *
 * This is the onboarding-UX pattern: a dApp sponsors its users' fees so a
 * brand-new user can submit a transaction before ever holding XLM. The
 * *inner* transaction's source account pays nothing; `sponsorPublicKey`
 * pays the entire fee-bumped fee.
 */
export function buildFeeBumpTransaction(
  client: KeeperRegistryClient,
  sponsorPublicKey: string,
  signedInnerTxXdr: string,
): UnsignedTransaction {
  const innerTx = StellarTransactionBuilder.fromXDR(signedInnerTxXdr, client.config.networkPassphrase) as Transaction;
  const feeBumpTx = StellarTransactionBuilder.buildFeeBumpTransaction(
    sponsorPublicKey,
    BASE_FEE,
    innerTx,
    client.config.networkPassphrase,
  );
  return {
    xdr: feeBumpTx.toXDR(),
    signerAccounts: [sponsorPublicKey],
    networkPassphrase: client.config.networkPassphrase,
  };
}

/** A minimal signer, matching `core/contractInvoker.ts`'s `TransactionSigner`. */
export interface ExternalSigner {
  sign(xdr: string, networkPassphrase: string): Promise<string> | string;
}

/**
 * Submits a transaction XDR that has already been fully signed by every
 * required signer (per {@link UnsignedTransaction.signerAccounts}) — a
 * wallet's signing response, or a sponsor-signed fee-bump envelope from
 * {@link buildFeeBumpTransaction}.
 *
 * Deliberately does **not** re-simulate before submitting: Soroban's
 * resource footprint must be attached (`assembleTransaction`, done by the
 * caller before signing — see {@link buildTransaction}'s doc comment) prior
 * to signing, since the signature covers the whole envelope including that
 * footprint. Re-simulating and re-assembling here, after the signature was
 * collected, would silently invalidate it. The caller is responsible for
 * simulating once, right before the last signature is collected.
 */
export async function submitSignedTransaction<T>(client: KeeperRegistryClient, signedXdr: string): Promise<T> {
  const tx = StellarTransactionBuilder.fromXDR(signedXdr, client.config.networkPassphrase) as Transaction;
  const server = client.invoker.getServer();

  const sendResponse = await server.sendTransaction(tx);
  if (sendResponse.status === "ERROR") {
    throw new Error(`Send failed: ${JSON.stringify(sendResponse.errorResult)}`);
  }

  let getResponse = await server.getTransaction(sendResponse.hash);
  let attempts = 0;
  while (getResponse.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    getResponse = await server.getTransaction(sendResponse.hash);
    attempts++;
  }

  if (getResponse.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction failed with status: ${getResponse.status}`);
  }
  return undefined as T;
}
