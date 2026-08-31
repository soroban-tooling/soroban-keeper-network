//! This crate's contract/network/decode error type — see `DESIGN.md`'s
//! "Error strategy" section for the reasoning behind this shape.
//!
//! [`KeeperSdkError`] is a superset of every way a call through this crate
//! can fail: the contract rejected the call ([`KeeperSdkError::Contract`],
//! actionable and often expected), the RPC layer failed to complete the
//! round-trip ([`KeeperSdkError::Network`], usually means retry), or the
//! round-trip succeeded but this crate could not interpret the result
//! ([`KeeperSdkError::Decode`]).
//!
//! Named `KeeperSdkError` (rather than the bare `SdkError` this design
//! originally proposed) to coexist with [`crate::methods::SdkError`], which
//! landed in the meantime and already owns that name in this crate — see
//! that type's own docs for the distinction: `methods::SdkError` wraps
//! [`crate::client::ClientError`] plus an `InvalidArgument` case for the
//! six task-lifecycle methods in [`crate::methods`], while this type wraps
//! `KeeperError` (the contract's own `#[contracterror]` enum) directly
//! alongside network/decode failures. Both are valid ways to report
//! failure from this crate; this module does not attempt to unify them.

use std::fmt;

use keeper_registry::KeeperError;

/// A contract/network/decode error type for this crate.
///
/// See the module docs and `DESIGN.md` for the reasoning behind this exact
/// shape, and the module docs for why this type is named `KeeperSdkError`
/// rather than `SdkError`.
#[derive(Debug)]
pub enum KeeperSdkError {
    /// The contract rejected the call. Carries the exact [`KeeperError`]
    /// variant the contract returned, reused directly rather than
    /// redefined under a different name.
    Contract(KeeperError),
    /// The RPC layer failed to complete the round-trip — a connection
    /// failure, a timeout, a malformed JSON-RPC response the client itself
    /// could not parse, and so on. Wraps `soroban-client`'s own error type
    /// verbatim.
    Network(soroban_client::error::Error),
    /// The RPC round-trip succeeded, but this crate could not interpret the
    /// result (e.g. an XDR payload that did not match the shape a client
    /// method expected). Distinct from [`KeeperSdkError::Network`] because
    /// the call itself did not fail, and distinct from
    /// [`KeeperSdkError::Contract`] because the contract's own logic never
    /// rejected anything — the failure is in this crate's own decoding
    /// step.
    Decode(String),
}

impl fmt::Display for KeeperSdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeeperSdkError::Contract(error) => {
                write!(
                    f,
                    "contract rejected the call: {}",
                    describe_keeper_error(*error)
                )
            }
            KeeperSdkError::Network(error) => write!(f, "network error: {error}"),
            KeeperSdkError::Decode(message) => write!(f, "could not decode response: {message}"),
        }
    }
}

impl std::error::Error for KeeperSdkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            KeeperSdkError::Network(error) => Some(error),
            KeeperSdkError::Contract(_) | KeeperSdkError::Decode(_) => None,
        }
    }
}

impl From<KeeperError> for KeeperSdkError {
    fn from(error: KeeperError) -> Self {
        KeeperSdkError::Contract(error)
    }
}

impl From<soroban_client::error::Error> for KeeperSdkError {
    fn from(error: soroban_client::error::Error) -> Self {
        KeeperSdkError::Network(error)
    }
}

/// `KeeperError` is a `#[contracterror]` enum — no-std-friendly and
/// discriminant-based by design, so it carries no `Display` impl of its own
/// (contract errors decode by number on the wire, not by message). This
/// gives `KeeperSdkError`'s `Display` impl a human-readable line for each
/// variant without requiring `KeeperError` itself to grow one.
fn describe_keeper_error(error: KeeperError) -> &'static str {
    match error {
        KeeperError::AlreadyInitialized => "already initialized",
        KeeperError::Unauthorized => "unauthorized",
        KeeperError::ContractPaused => "contract is paused",
        KeeperError::TaskNotFound => "task not found",
        KeeperError::InvalidTaskStatus => "invalid task status for this operation",
        KeeperError::DeadlinePassed => "task deadline has passed",
        KeeperError::DeadlineNotPassed => "task deadline has not passed yet",
        KeeperError::InvalidReward => "invalid reward amount",
        KeeperError::LockPeriodActive => "lock period is still active",
        KeeperError::InvalidFeeBps => "invalid fee (basis points)",
        KeeperError::NotTaskOwner => "caller is not the task owner",
        KeeperError::NotTaskClaimer => "caller is not the task's claimer",
        KeeperError::NoRewardsAvailable => "no rewards available to withdraw",
        KeeperError::ProofTooLarge => "proof exceeds the maximum allowed length",
        KeeperError::NotInitialized => "registry has not been initialized",
        KeeperError::TtlTooShort => "ttl_ledgers does not cover the task's deadline",
        KeeperError::CalldataTooLarge => "calldata exceeds the maximum allowed length",
        KeeperError::InvalidTaskParams => "lock_ledgers or ttl_ledgers is out of bounds",
        KeeperError::ArithmeticOverflow => "arithmetic operation overflowed or underflowed",
        KeeperError::IncompatibleVerifierInterface => {
            "attached verifier reported an incompatible interface version"
        }
        KeeperError::BatchTooLarge => "batch request exceeds the maximum allowed size",
        KeeperError::EmptyBatch => "batch request was empty",
        KeeperError::BatchRewardCeilingExceeded => {
            "sum of batch rewards exceeded the caller-supplied ceiling"
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn keeper_error_variants_are_reachable_through_keeper_sdk_error() {
        let error = KeeperSdkError::from(KeeperError::TaskNotFound);
        match error {
            KeeperSdkError::Contract(KeeperError::TaskNotFound) => {}
            other => panic!("expected KeeperSdkError::Contract(TaskNotFound), got {other:?}"),
        }
    }

    #[test]
    fn keeper_error_propagates_through_question_mark() {
        fn fails() -> Result<(), KeeperError> {
            Err(KeeperError::Unauthorized)
        }

        fn wrapper() -> Result<(), KeeperSdkError> {
            fails()?;
            Ok(())
        }

        match wrapper() {
            Err(KeeperSdkError::Contract(KeeperError::Unauthorized)) => {}
            other => panic!("expected KeeperSdkError::Contract(Unauthorized), got {other:?}"),
        }
    }

    #[test]
    fn network_error_propagates_through_question_mark() {
        fn fails() -> Result<(), soroban_client::error::Error> {
            Err(soroban_client::error::Error::UnexpectedError)
        }

        fn wrapper() -> Result<(), KeeperSdkError> {
            fails()?;
            Ok(())
        }

        match wrapper() {
            Err(KeeperSdkError::Network(soroban_client::error::Error::UnexpectedError)) => {}
            other => panic!("expected KeeperSdkError::Network(UnexpectedError), got {other:?}"),
        }
    }

    #[test]
    fn display_distinguishes_contract_network_and_decode_variants() {
        let contract = KeeperSdkError::Contract(KeeperError::TaskNotFound);
        assert!(contract.to_string().contains("contract rejected the call"));
        assert!(contract.to_string().contains("task not found"));

        let network = KeeperSdkError::Network(soroban_client::error::Error::UnexpectedError);
        assert!(network.to_string().contains("network error"));

        let decode = KeeperSdkError::Decode("unexpected XDR shape".to_string());
        assert!(decode.to_string().contains("could not decode response"));
        assert!(decode.to_string().contains("unexpected XDR shape"));
    }

    #[test]
    fn source_is_populated_for_network_errors_only() {
        use std::error::Error as _;

        let network = KeeperSdkError::Network(soroban_client::error::Error::UnexpectedError);
        assert!(network.source().is_some());

        let contract = KeeperSdkError::Contract(KeeperError::TaskNotFound);
        assert!(contract.source().is_none());

        let decode = KeeperSdkError::Decode("bad shape".to_string());
        assert!(decode.source().is_none());
    }

    #[test]
    fn every_keeper_error_variant_has_a_description() {
        // Exhaustive match — if a new KeeperError variant is ever added
        // without updating describe_keeper_error, this fails to compile
        // rather than silently falling through to a generic message.
        let variants = [
            KeeperError::AlreadyInitialized,
            KeeperError::Unauthorized,
            KeeperError::ContractPaused,
            KeeperError::TaskNotFound,
            KeeperError::InvalidTaskStatus,
            KeeperError::DeadlinePassed,
            KeeperError::DeadlineNotPassed,
            KeeperError::InvalidReward,
            KeeperError::LockPeriodActive,
            KeeperError::InvalidFeeBps,
            KeeperError::NotTaskOwner,
            KeeperError::NotTaskClaimer,
            KeeperError::NoRewardsAvailable,
            KeeperError::ProofTooLarge,
            KeeperError::NotInitialized,
            KeeperError::TtlTooShort,
            KeeperError::CalldataTooLarge,
            KeeperError::InvalidTaskParams,
            KeeperError::ArithmeticOverflow,
            KeeperError::IncompatibleVerifierInterface,
            KeeperError::BatchTooLarge,
            KeeperError::EmptyBatch,
            KeeperError::BatchRewardCeilingExceeded,
        ];
        for variant in variants {
            assert!(!describe_keeper_error(variant).is_empty());
        }
    }

    /// Confirms this crate's error type is usable anywhere a native Rust
    /// error is expected (e.g. `Box<dyn std::error::Error>`), per
    /// DESIGN.md's ergonomics claim.
    #[test]
    fn keeper_sdk_error_is_object_safe_as_a_std_error() {
        fn accepts_any_error(_: Box<dyn std::error::Error>) {}
        accepts_any_error(Box::new(KeeperSdkError::Contract(KeeperError::TaskNotFound)));
    }
}
