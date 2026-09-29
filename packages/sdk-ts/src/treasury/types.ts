// Typed mirrors of the treasury contract's on-chain types
// (contracts/treasury/src/types.rs and errors.rs). Field names and
// semantics must stay in sync with the contract — see CONVENTIONS.md for
// the numeric/timestamp representation this SDK uses.

/**
 * Mirrors `contracts/treasury/src/types.rs::Recipient`.
 *
 * `sharesBps` is a `u32`, so a plain `number` per the numeric convention.
 */
export interface Recipient {
  address: string;
  sharesBps: number;
}

export interface TreasuryClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}
