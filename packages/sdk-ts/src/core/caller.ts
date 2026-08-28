/**
 * The seam between the client's shared plumbing and the per-entry-point
 * wrappers in `src/methods/`.
 *
 * Method modules depend on this interface rather than on
 * {@link KeeperRegistryClient} itself, so each one stays a pure function of
 * "given a way to call the contract, here is one typed entry point" -- easy to
 * test in isolation, and free of an import cycle back into the class that
 * assembles them.
 */

import type { xdr } from "@stellar/stellar-sdk";

/**
 * Signs a transaction on behalf of one account.
 *
 * The shape matches the Stellar wallet ecosystem's own convention (Freighter,
 * stellar-wallets-kit): take a base64 envelope XDR, return a signed one. A
 * Node script holding a `Keypair` can adapt with `keypairSigner`.
 */
export interface TransactionSigner {
  /** `G...` address whose signature this signer produces. */
  readonly publicKey: string;
  signTransaction(
    xdrBase64: string,
    options: { networkPassphrase: string },
  ): Promise<string> | string;
}

/** Arguments shared by every state-changing wrapper. */
export interface SignedCallOptions {
  /**
   * Signer for this call, overriding the client's default. Its `publicKey`
   * must match the address the contract requires authorization from.
   */
  signer?: TransactionSigner;
}

/**
 * The contract-calling capability a method wrapper needs.
 *
 * @internal Implemented by {@link KeeperRegistryClient}. Not part of the
 * supported public surface: call the client's typed methods instead.
 */
export interface ContractCaller {
  /** Simulates a read-only entry point and decodes its return value. */
  read<T>(method: string, args?: xdr.ScVal[]): Promise<T>;
  /** Simulates, signs, submits, and confirms a state-changing entry point. */
  invoke<T>(params: {
    method: string;
    args?: xdr.ScVal[];
    source: string;
    signer?: TransactionSigner;
  }): Promise<T>;
  /** Reports a non-fatal diagnostic without failing the call. */
  warn(message: string): void;
}
