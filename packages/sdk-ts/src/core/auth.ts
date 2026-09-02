/**
 * Soroban auth-entry signing, for the one entry point in this contract that
 * needs more than one signature.
 *
 * `transfer_admin` calls `require_auth` on both the outgoing and the incoming
 * admin (see `contracts/keeper-registry/src/lib.rs`), so the transaction
 * envelope's own signature -- which satisfies only the source account -- is not
 * enough. Every other entry point is single-auth and goes through the client's
 * ordinary `invoke`.
 *
 * The matching logic lives here, network-free and given only already-fetched
 * simulation output, so "does every required address have a signer" can be
 * exercised directly in tests without a live RPC server.
 */

import { Address, authorizeEntry, hash, xdr } from "@stellar/stellar-sdk";

import { KeeperSdkError } from "../errors.js";

/**
 * Signs one Soroban authorization entry on behalf of one address.
 *
 * Separate from {@link TransactionSigner} because the two sign different
 * things: a `TransactionSigner` signs a transaction envelope, while this signs
 * the auth-entry preimage. A wallet that exposes only envelope signing cannot
 * satisfy a second required address, which is why this is its own interface
 * rather than a widening of the existing one.
 */
export interface AuthEntrySigner {
  /** `G...` address whose authorization this signer provides. */
  readonly publicKey: string;
  /** Signs the entry's `HashIdPreimage`. */
  signAuthEntry(preimage: xdr.HashIdPreimage): Promise<Buffer> | Buffer;
}

/** Minimal `Keypair` surface, so callers need not import the class type. */
interface KeypairLike {
  publicKey(): string;
  sign(data: Buffer): Buffer;
}

/**
 * Adapts a `Keypair` to an {@link AuthEntrySigner}, mirroring `keypairSigner`
 * for the envelope case.
 */
export function keypairAuthSigner(keypair: KeypairLike): AuthEntrySigner {
  return {
    publicKey: keypair.publicKey(),
    signAuthEntry(preimage) {
      return keypair.sign(hash(preimage.toXDR()));
    },
  };
}

/**
 * Signs whichever of `entries` require an explicit address signature, matching
 * each to a signer by public key.
 *
 * An entry whose credentials are `sorobanCredentialsSourceAccount` is satisfied
 * by the envelope signature the client already applies, so it passes through
 * untouched -- signing it again would be wrong, not merely redundant.
 *
 * Throws if an entry requires an address no signer covers. That is caught here,
 * before submission, because the alternative is a transaction that is valid,
 * costs a fee, and fails `require_auth` for a reason invisible in the result.
 */
export async function signAuthEntries(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  signers: readonly AuthEntrySigner[],
  validUntilLedgerSeq: number,
  networkPassphrase: string,
  method: string,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const signerByAddress = new Map(signers.map((signer) => [signer.publicKey, signer]));

  return Promise.all(
    entries.map(async (entry) => {
      if (
        entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()
      ) {
        return entry;
      }

      const required = Address.fromScAddress(entry.credentials().address().address()).toString();
      const signer = signerByAddress.get(required);
      if (!signer) {
        throw new KeeperSdkError(
          `${method} requires authorization from ${required}, but no signer for that address was supplied.`,
        );
      }

      return authorizeEntry(
        entry,
        async (preimage) => signer.signAuthEntry(preimage),
        validUntilLedgerSeq,
        networkPassphrase,
      );
    }),
  );
}
