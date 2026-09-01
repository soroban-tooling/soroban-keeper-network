//! Retry policy for transient RPC failures.
//!
//! Mirrors the reasoning in the keeper-bot example's `withRetry` /
//! `isPermanentError` (`examples/keeper-bot/index.js`): retrying a decoded
//! contract error (e.g. `NotTaskClaimer`) wastes a submission attempt that can
//! never succeed, since the transaction already ran and the contract already
//! rejected it. A network timeout or a dropped connection, on the other hand,
//! never reached the contract at all and is worth another attempt.
//!
//! The retry loop wraps only the RPC call itself — never the decoding of a
//! successful response into a contract-level error.

use std::future::Future;
use std::time::Duration;

use rand::Rng;

/// Transport-level failure: the RPC call itself did not complete, so no
/// contract logic ever ran. Every variant here is transient by default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// The RPC call did not complete within the client's timeout.
    Timeout,
    /// The underlying connection was reset or dropped mid-request.
    ConnectionReset,
    /// The RPC node reported its simulation endpoint as temporarily
    /// unavailable (e.g. overloaded, restarting).
    SimulationUnavailable,
    /// Any other transport failure, carrying the node's message.
    Other(String),
}

/// The result of a call that reached the network: either a transport failure
/// before the contract ran, or a contract error decoded from a response the
/// RPC call successfully returned.
///
/// `C` is the caller's decoded contract error type (e.g. `KeeperError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcCallError<C> {
    /// The RPC call itself failed; the contract never ran.
    Transport(TransportError),
    /// The RPC call succeeded and returned a decoded contract error.
    Contract(C),
}

/// Whether a failure is worth retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Retrying may succeed (the contract never ran).
    Transient,
    /// Retrying can never succeed (the contract already rejected the call,
    /// or the failure is otherwise deterministic).
    Permanent,
}

/// Default classification: any [`RpcCallError::Transport`] is transient, any
/// [`RpcCallError::Contract`] is permanent — a decoded `KeeperError` is
/// deterministic given the on-chain state that produced it and will not
/// change by resubmitting the same call.
///
/// Overridable: a future contract error might need special-casing (e.g. a
/// variant that *is* worth retrying because it reflects a race rather than a
/// deterministic rejection), so callers may supply their own classifier to
/// [`RetryPolicy::run`] instead of this one.
pub fn default_classify<C>(err: &RpcCallError<C>) -> ErrorClass {
    match err {
        RpcCallError::Transport(_) => ErrorClass::Transient,
        RpcCallError::Contract(_) => ErrorClass::Permanent,
    }
}

/// A configurable retry policy for RPC calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts made before giving up, including the first one.
    /// `1` means "no retries".
    pub max_attempts: u32,
    /// Base delay for exponential backoff: attempt `n` (0-indexed) waits
    /// `base_delay * 2^n` plus jitter before retrying.
    pub base_delay: Duration,
    /// Random jitter added to every backoff, uniformly sampled from
    /// `jitter_min..=jitter_max`, to avoid many clients retrying in lockstep.
    pub jitter_min: Duration,
    pub jitter_max: Duration,
}

impl Default for RetryPolicy {
    /// 4 total attempts, 200ms base delay, 0-200ms jitter — matches the
    /// keeper-bot example's defaults (`MAX_RETRIES` = 3, `retryBaseMs` =
    /// 200ms full-range jitter).
    fn default() -> Self {
        Self {
            max_attempts: 4,
            base_delay: Duration::from_millis(200),
            jitter_min: Duration::ZERO,
            jitter_max: Duration::from_millis(200),
        }
    }
}

impl RetryPolicy {
    /// A policy that never retries — useful for tests or callers that want
    /// their own retry loop around this crate's RPC calls.
    pub fn no_retry() -> Self {
        Self {
            max_attempts: 1,
            base_delay: Duration::ZERO,
            jitter_min: Duration::ZERO,
            jitter_max: Duration::ZERO,
        }
    }

    fn delay_for(&self, attempt: u32) -> Duration {
        let backoff = self.base_delay.saturating_mul(1u32 << attempt.min(31));
        let jitter = if self.jitter_max > self.jitter_min {
            let range = (self.jitter_max - self.jitter_min).as_nanos().max(1);
            let sampled = rand::thread_rng().gen_range(0..range);
            self.jitter_min + Duration::from_nanos(sampled as u64)
        } else {
            self.jitter_min
        };
        backoff.saturating_add(jitter)
    }

    /// Run `op`, retrying on transient failures per this policy and the given
    /// `classify` function, sleeping via the injected `sleep` closure between
    /// attempts (real wall-clock sleep in production, a no-op or virtual
    /// clock in tests).
    ///
    /// A [`RpcCallError::Contract`] is surfaced on the first attempt whenever
    /// `classify` calls it permanent — never retried.
    pub async fn run<T, C, Classify, SleepFn, SleepFut>(
        &self,
        mut op: impl FnMut() -> std::pin::Pin<Box<dyn Future<Output = Result<T, RpcCallError<C>>> + Send>>,
        classify: Classify,
        sleep: SleepFn,
    ) -> Result<T, RpcCallError<C>>
    where
        Classify: Fn(&RpcCallError<C>) -> ErrorClass,
        SleepFn: Fn(Duration) -> SleepFut,
        SleepFut: Future<Output = ()>,
    {
        let mut attempt = 0;
        loop {
            match op().await {
                Ok(value) => return Ok(value),
                Err(err) => {
                    let is_last = attempt + 1 >= self.max_attempts;
                    if matches!(classify(&err), ErrorClass::Permanent) || is_last {
                        return Err(err);
                    }
                    sleep(self.delay_for(attempt)).await;
                    attempt += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MockKeeperError {
        LockPeriodActive,
        NotTaskClaimer,
    }

    fn instant_sleep(_: Duration) -> impl Future<Output = ()> {
        async {}
    }

    #[tokio::test]
    async fn transient_timeout_is_retried_until_success() {
        let policy = RetryPolicy {
            max_attempts: 3,
            ..RetryPolicy::no_retry()
        };
        let calls = AtomicU32::new(0);

        let result: Result<&str, RpcCallError<MockKeeperError>> = policy
            .run(
                || {
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move {
                        if n == 0 {
                            Err(RpcCallError::Transport(TransportError::Timeout))
                        } else {
                            Ok("submitted")
                        }
                    })
                },
                default_classify,
                instant_sleep,
            )
            .await;

        assert_eq!(result, Ok("submitted"));
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one retry after the timeout");
    }

    #[tokio::test]
    async fn decoded_lock_period_active_is_never_retried() {
        let policy = RetryPolicy {
            max_attempts: 5,
            ..RetryPolicy::no_retry()
        };
        let calls = AtomicU32::new(0);

        let result: Result<&str, RpcCallError<MockKeeperError>> = policy
            .run(
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async {
                        Err(RpcCallError::Contract(MockKeeperError::LockPeriodActive))
                    })
                },
                default_classify,
                instant_sleep,
            )
            .await;

        assert_eq!(
            result,
            Err(RpcCallError::Contract(MockKeeperError::LockPeriodActive))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "no retry on a decoded contract error");
    }

    #[tokio::test]
    async fn connection_reset_exhausts_max_attempts_then_surfaces() {
        let policy = RetryPolicy {
            max_attempts: 3,
            ..RetryPolicy::no_retry()
        };
        let calls = AtomicU32::new(0);

        let result: Result<(), RpcCallError<MockKeeperError>> = policy
            .run(
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Err(RpcCallError::Transport(TransportError::ConnectionReset)) })
                },
                default_classify,
                instant_sleep,
            )
            .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3, "stops at max_attempts");
    }

    #[tokio::test]
    async fn overridden_classifier_can_special_case_a_contract_error() {
        // A future contract error might need special-casing: this classifier
        // treats `NotTaskClaimer` as transient (e.g. because the caller knows
        // claim ownership can race) while everything else keeps the default.
        let policy = RetryPolicy {
            max_attempts: 2,
            ..RetryPolicy::no_retry()
        };
        let calls = AtomicU32::new(0);

        let classify = |err: &RpcCallError<MockKeeperError>| match err {
            RpcCallError::Contract(MockKeeperError::NotTaskClaimer) => ErrorClass::Transient,
            other => default_classify(other),
        };

        let result: Result<&str, RpcCallError<MockKeeperError>> = policy
            .run(
                || {
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move {
                        if n == 0 {
                            Err(RpcCallError::Contract(MockKeeperError::NotTaskClaimer))
                        } else {
                            Ok("submitted")
                        }
                    })
                },
                classify,
                instant_sleep,
            )
            .await;

        assert_eq!(result, Ok("submitted"));
    }
}
