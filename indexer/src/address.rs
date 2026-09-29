//! One canonical string form for a Stellar/Soroban address, used at both
//! ends of the address's round trip through this indexer: decoding an
//! ingested event's `ScAddress` (`rpc.rs`'s `decode_address`) and turning a
//! caller-supplied address into a query parameter (`store.rs`'s
//! `task_ids_by_owner`/`task_ids_by_keeper`/`keeper_summary`). If those two
//! ends ever disagreed on what string represents "this address", a lookup
//! could silently return nothing for an address that is actually present
//! under a different, equally valid string (issue 0364).
//!
//! A `keeper_registry` `Address` (Soroban's `ScAddress`) is always exactly
//! one of an ed25519 account (`G...`) or a contract (`C...`) — never a
//! *muxed* account (`M...`), which is a classic-transaction concept with no
//! `ScAddress` representation at all (confirmed against `stellar-xdr`'s
//! `ScAddress` definition, which has only `Account`/`Contract` variants).
//! So `decode_address` can never itself produce a muxed string, and every
//! stored `owner_address`/`keeper_address` is already exactly one canonical
//! form for the underlying bytes -- `stellar-strkey`'s encoder is
//! deterministic, and its decoder rejects anything that isn't the exact
//! canonical (uppercase, correctly checksummed) string outright, so there is
//! no second *valid* `G...`/`C...` spelling of the same address to
//! normalize away on that side.
//!
//! The real risk is entirely on the query side: nothing stops a caller
//! pasting an address copied from a wallet or block explorer that displays
//! the **muxed** form of their own `G...` account into a REST path or
//! WebSocket filter -- a muxed string is a completely different string from
//! its underlying account's `G...` string, so an unnormalized `WHERE
//! keeper_address = ?` would silently match nothing, even though the
//! indexer has plenty of rows for that keeper. [`normalize_address`]
//! resolves a muxed address to its underlying account's canonical `G...`
//! form (discarding the embedded id, since `ScAddress` has nowhere to put
//! one) so that lookup succeeds.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AddressNormalizationError {
    #[error("{0:?} is not a valid Stellar account (G...), contract (C...), or muxed account (M...) address")]
    Invalid(String),
}

/// The one function every path that stores or queries an address goes
/// through -- see the module doc comment. Idempotent: normalizing an
/// already-canonical `G.../C...` address returns it unchanged.
pub fn normalize_address(input: &str) -> Result<String, AddressNormalizationError> {
    if let Ok(account) = stellar_strkey::ed25519::PublicKey::from_string(input) {
        return Ok(account.to_string());
    }
    if let Ok(contract) = stellar_strkey::Contract::from_string(input) {
        return Ok(contract.to_string());
    }
    if let Ok(muxed) = stellar_strkey::ed25519::MuxedAccount::from_string(input) {
        // The embedded id has nowhere to go: `ScAddress` (what every event
        // and entry point on this contract actually uses) can only ever
        // name the plain underlying account, never a specific sub-id of it.
        return Ok(stellar_strkey::ed25519::PublicKey(muxed.ed25519).to_string());
    }
    Err(AddressNormalizationError::Invalid(input.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    // The muxed form of ACCOUNT with id 0 -- a real, valid strkey a wallet
    // can legitimately hand a user for the exact same underlying account.
    const MUXED_ID_ZERO: &str =
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
    const CONTRACT: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    #[test]
    fn a_canonical_account_address_round_trips_unchanged() {
        assert_eq!(normalize_address(ACCOUNT), Ok(ACCOUNT.to_string()));
    }

    #[test]
    fn a_canonical_contract_address_round_trips_unchanged() {
        assert_eq!(normalize_address(CONTRACT), Ok(CONTRACT.to_string()));
    }

    #[test]
    fn a_muxed_address_and_its_underlying_account_normalize_to_the_same_stored_identity() {
        // The acceptance criterion this issue asks for directly: two
        // different, both individually valid, encodings of the same
        // underlying address must resolve to one identical normalized form.
        let from_account = normalize_address(ACCOUNT).expect("valid account");
        let from_muxed = normalize_address(MUXED_ID_ZERO).expect("valid muxed account");
        assert_eq!(from_account, from_muxed);
        assert_eq!(from_muxed, ACCOUNT);
    }

    #[test]
    fn garbage_input_is_rejected_rather_than_silently_passed_through() {
        assert_eq!(
            normalize_address("not-an-address"),
            Err(AddressNormalizationError::Invalid(
                "not-an-address".to_string()
            )),
        );
    }

    #[test]
    fn a_lowercased_valid_address_is_rejected_rather_than_silently_accepted() {
        // stellar-strkey's own decoder already rejects this (confirmed
        // directly, not assumed) -- asserted here so a future change to
        // normalize_address's implementation can't accidentally start
        // accepting non-canonical case without this test catching it.
        assert!(normalize_address(&ACCOUNT.to_lowercase()).is_err());
    }

    #[test]
    fn an_empty_string_is_rejected() {
        assert!(normalize_address("").is_err());
    }
}
