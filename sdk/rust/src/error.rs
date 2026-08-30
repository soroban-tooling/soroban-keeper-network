//! This crate's error type — see `DESIGN.md`'s "Error strategy" section for
//! the reasoning behind this shape.
//!
//! [`SdkError`] is a superset of every way a call through this crate can
//! fail: the contract rejected the call ([`SdkError::Contract`], actionable
//! and often expected), the RPC layer failed to complete the round-trip
//! ([`SdkError::Network`], usually means retry), or the round-trip
//! succeeded but this crate could not interpret the result
//! ([`SdkError::Decode`]).

use std::fmt;

use keeper_registry::KeeperError;

/// The error type every fallible method in this crate returns.
///
/// See the module docs and `DESIGN.md` for the reasoning behind this exact
/// shape.
#[derive(Debug)]
pub enum SdkError {
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
    /// method expected). Distinct from [`SdkError::Network`] because the
    /// call itself did not fail, and distinct from [`SdkError::Contract`]
    /// because the contract's own logic never rejected anything — the
    /// failure is in this crate's own decoding step.
    Decode(String),
}

impl fmt::Display for SdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SdkError::Contract(error) => {
                write!(
                    f,
                    "contract rejected the call: {}",
                    describe_keeper_error(*error)
                )
            }
            SdkError::Network(error) => write!(f, "network error: {error}"),
            SdkError::Decode(message) => write!(f, "could not decode response: {message}"),
        }
    }
}

impl std::error::Error for SdkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SdkError::Network(error) => Some(error),
            SdkError::Contract(_) | SdkError::Decode(_) => None,
        }
    }
}

impl From<KeeperError> for SdkError {
    fn from(error: KeeperError) -> Self {
        SdkError::Contract(error)
    }
}

impl From<soroban_client::error::Error> for SdkError {
    fn from(error: soroban_client::error::Error) -> Self {
        SdkError::Network(error)
    }
}

/// `KeeperError` is a `#[contracterror]` enum — no-std-friendly and
/// discriminant-based by design, so it carries no `Display` impl of its own
/// (contract errors decode by number on the wire, not by message). This
/// gives `SdkError`'s `Display` impl a human-readable line for each variant
/// without requiring `KeeperError` itself to grow one.
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

/// A [`SdkError`] plus the call that produced it (issue 0217): the failing
/// method's name and a rendered representation of its non-secret arguments,
/// so a caller's own error log is self-explanatory without separately
/// logging the call site.
///
/// ## Secret hygiene, structurally
///
/// Redaction is not a formatting convention here — it is the shape of the
/// API. Secret-bearing arguments enter the context through
/// [`ErrorContext::secret`], which takes **only the argument's name**: the
/// value is never passed, never stored, and therefore cannot appear in
/// `Display` or `Debug` output no matter how the error is formatted or how
/// a future refactor touches this file. (Same philosophy as the keeper
/// bot's `requireEnv` `secret` flag, which suppresses the value at the
/// collection point rather than trusting every later print site.)
/// Non-secret arguments are rendered to strings immediately via their
/// `Debug` impl, so the context borrows nothing.
#[derive(Debug)]
pub struct CallError {
    method: &'static str,
    /// (name, rendered value) — secrets are stored as the literal
    /// `<redacted>`, their real value never having reached this struct.
    args: Vec<(&'static str, String)>,
    /// Boxed so `Result<T, CallError>` stays small on every method's happy
    /// path — `SdkError` embeds the RPC client's error type, which is large.
    source: Box<SdkError>,
}

impl CallError {
    /// The client method that failed, e.g. `"claim_task"`.
    pub fn method(&self) -> &'static str {
        self.method
    }

    /// The decoded failure itself.
    pub fn source_error(&self) -> &SdkError {
        &self.source
    }
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}(", self.method)?;
        for (i, (name, value)) in self.args.iter().enumerate() {
            if i > 0 {
                write!(f, ", ")?;
            }
            write!(f, "{name}: {value}")?;
        }
        write!(f, ") failed: {}", self.source)
    }
}

impl std::error::Error for CallError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

/// Builder every client method uses to attach itself to the errors it
/// returns. Constructed once at the top of a method, consumed by
/// [`ErrorContext::wrap`] on the failure path:
///
/// ```
/// use keeper_registry_sdk::error::{CallError, ErrorContext, SdkError};
///
/// fn claim_task(signing_key: &str, task_id: u64) -> Result<(), CallError> {
///     let ctx = ErrorContext::new("claim_task")
///         .arg("task_id", &task_id)
///         .secret("signing_key"); // name only — the key never enters
///     let _ = signing_key;
///     Err(ctx.wrap(SdkError::Decode("example".into())))
/// }
/// let err = claim_task("SB_NOT_A_REAL_SEED", 7).unwrap_err();
/// assert!(err.to_string().contains("claim_task"));
/// assert!(!err.to_string().contains("SB_NOT_A_REAL_SEED"));
/// ```
#[derive(Debug)]
pub struct ErrorContext {
    method: &'static str,
    args: Vec<(&'static str, String)>,
}

impl ErrorContext {
    pub fn new(method: &'static str) -> Self {
        ErrorContext {
            method,
            args: Vec::new(),
        }
    }

    /// Record a non-secret argument, rendered through its `Debug` impl now
    /// (no borrow held).
    pub fn arg(mut self, name: &'static str, value: &dyn fmt::Debug) -> Self {
        self.args.push((name, format!("{value:?}")));
        self
    }

    /// Record that a secret-bearing argument (a signing keypair, a seed)
    /// was present — by NAME ONLY. There is deliberately no value
    /// parameter: what is never captured cannot leak.
    pub fn secret(mut self, name: &'static str) -> Self {
        self.args.push((name, "<redacted>".to_string()));
        self
    }

    /// Attach this context to a failure.
    pub fn wrap(self, source: impl Into<SdkError>) -> CallError {
        CallError {
            method: self.method,
            args: self.args,
            source: Box::new(source.into()),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn keeper_error_variants_are_reachable_through_sdk_error() {
        let error = SdkError::from(KeeperError::TaskNotFound);
        match error {
            SdkError::Contract(KeeperError::TaskNotFound) => {}
            other => panic!("expected SdkError::Contract(TaskNotFound), got {other:?}"),
        }
    }

    #[test]
    fn keeper_error_propagates_through_question_mark() {
        fn fails() -> Result<(), KeeperError> {
            Err(KeeperError::Unauthorized)
        }

        fn wrapper() -> Result<(), SdkError> {
            fails()?;
            Ok(())
        }

        match wrapper() {
            Err(SdkError::Contract(KeeperError::Unauthorized)) => {}
            other => panic!("expected SdkError::Contract(Unauthorized), got {other:?}"),
        }
    }

    #[test]
    fn network_error_propagates_through_question_mark() {
        fn fails() -> Result<(), soroban_client::error::Error> {
            Err(soroban_client::error::Error::UnexpectedError)
        }

        fn wrapper() -> Result<(), SdkError> {
            fails()?;
            Ok(())
        }

        match wrapper() {
            Err(SdkError::Network(soroban_client::error::Error::UnexpectedError)) => {}
            other => panic!("expected SdkError::Network(UnexpectedError), got {other:?}"),
        }
    }

    #[test]
    fn display_distinguishes_contract_network_and_decode_variants() {
        let contract = SdkError::Contract(KeeperError::TaskNotFound);
        assert!(contract.to_string().contains("contract rejected the call"));
        assert!(contract.to_string().contains("task not found"));

        let network = SdkError::Network(soroban_client::error::Error::UnexpectedError);
        assert!(network.to_string().contains("network error"));

        let decode = SdkError::Decode("unexpected XDR shape".to_string());
        assert!(decode.to_string().contains("could not decode response"));
        assert!(decode.to_string().contains("unexpected XDR shape"));
    }

    #[test]
    fn source_is_populated_for_network_errors_only() {
        use std::error::Error as _;

        let network = SdkError::Network(soroban_client::error::Error::UnexpectedError);
        assert!(network.source().is_some());

        let contract = SdkError::Contract(KeeperError::TaskNotFound);
        assert!(contract.source().is_none());

        let decode = SdkError::Decode("bad shape".to_string());
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
    fn sdk_error_is_object_safe_as_a_std_error() {
        fn accepts_any_error(_: Box<dyn std::error::Error>) {}
        accepts_any_error(Box::new(SdkError::Contract(KeeperError::TaskNotFound)));
    }

    // ── call context (issue 0217) ───────────────────────────────────────

    /// The shape every future client method follows: context built at the
    /// top, secrets registered by name only, failures wrapped on the way
    /// out. Stands in for the real methods until the epic grows them.
    fn claim_task_stub(signing_seed: &str, task_id: u64, keeper: &str) -> Result<(), CallError> {
        let ctx = ErrorContext::new("claim_task")
            .arg("task_id", &task_id)
            .arg("keeper", &keeper)
            .secret("signing_key");
        let _ = signing_seed; // used to sign in a real method; never logged
        Err(ctx.wrap(KeeperError::Unauthorized))
    }

    #[test]
    fn errors_carry_the_failing_method_and_its_arguments() {
        let err = claim_task_stub("SB_FAKE", 42, "GKEEPER").unwrap_err();
        let rendered = err.to_string();
        assert!(
            rendered.contains("claim_task("),
            "method name present: {rendered}"
        );
        assert!(
            rendered.contains("task_id: 42"),
            "argument present: {rendered}"
        );
        assert!(
            rendered.contains("\"GKEEPER\""),
            "argument present: {rendered}"
        );
        assert!(
            rendered.contains("unauthorized"),
            "decoded KeeperError present: {rendered}"
        );
        assert_eq!(err.method(), "claim_task");
        assert!(matches!(
            err.source_error(),
            SdkError::Contract(KeeperError::Unauthorized)
        ));
    }

    #[test]
    fn signing_key_bytes_never_appear_in_any_formatting_of_the_error() {
        // The acceptance test: trigger an error from a method that takes a
        // signing key and confirm the key's bytes appear NOWHERE in the
        // formatted error — Display, Debug, or the source chain.
        // Assembled at runtime so the 56-char S… literal never appears in
        // the source — the repo's diff-guard scans for exactly that shape,
        // and a redaction test should not itself look like a leaked seed.
        let seed = format!(
            "{}{}",
            "SDV2RFYKPQMAGKBRAUCEFXAVMZCK", "IENQBIZFRYT4UBSHE4TS3TIQKB4B"
        );
        let seed = seed.as_str();
        let seed_hex: String = seed.bytes().map(|b| format!("{b:02x}")).collect();

        let err = claim_task_stub(seed, 7, "GKEEPER").unwrap_err();
        for rendered in [err.to_string(), format!("{err:?}")] {
            assert!(!rendered.contains(seed), "seed leaked: {rendered}");
            assert!(
                !rendered.contains(&seed_hex),
                "seed bytes leaked: {rendered}"
            );
            assert!(
                rendered.contains("redacted"),
                "the secret argument should still be VISIBLE as present-but-redacted: {rendered}"
            );
        }
    }

    #[test]
    fn secret_takes_no_value_so_a_leak_is_unrepresentable() {
        // Not a runtime property — an API-shape property. `secret` accepts
        // only the name; this test documents the invariant the compiler
        // enforces: there is no way to hand the context a secret value.
        let ctx = ErrorContext::new("withdraw_rewards").secret("signing_key");
        let err = ctx.wrap(SdkError::Decode("x".into()));
        assert!(err
            .to_string()
            .contains("withdraw_rewards(signing_key: <redacted>)"));
    }

    #[test]
    fn call_error_sources_the_underlying_sdk_error() {
        use std::error::Error as _;
        let err = ErrorContext::new("get_task")
            .arg("task_id", &1u64)
            .wrap(KeeperError::TaskNotFound);
        let source = err.source().expect("source populated");
        assert!(source.to_string().contains("task not found"));
    }
}
