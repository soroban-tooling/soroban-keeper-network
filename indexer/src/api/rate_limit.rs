//! Per-client rate limiting for the REST API and WebSocket upgrades.
//!
//! Once the REST API and WebSocket feed are public, they are a target for
//! abusive query volume that could degrade service for legitimate consumers
//! or drive up database load and hosting cost. Every request — including a
//! WebSocket upgrade, which opens a long-lived connection — is charged
//! against a per-client token bucket before it reaches a handler.
//!
//! Keys are authenticated before an identity or tier can be selected. Invalid
//! or revoked keys receive 401 immediately and create no bucket. Requests
//! without a key are charged against their transport IP at default limits.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::auth::{self, ApiKeys, Caller};
use super::types::ApiError;

/// Default upper bound on the number of client buckets kept in memory.
pub const DEFAULT_MAX_BUCKETS: usize = 10_000;

/// Default time-to-live for an inactive bucket before it is eligible for eviction.
pub const DEFAULT_BUCKET_TTL: Duration = Duration::from_secs(300);

/// A token bucket for one client.
#[derive(Debug, Clone)]
struct Bucket {
    tokens: f64,
    last_refill: Instant,
    last_seen: Instant,
}

/// Limiter state protected by mutex.
struct LimiterState {
    buckets: HashMap<String, Bucket>,
    last_cleanup: Instant,
}

/// Per-client token buckets, shared across every request.
pub struct RateLimiter {
    pub requests_per_second: f64,
    pub burst: f64,
    pub api_keys: Arc<ApiKeys>,
    pub max_buckets: usize,
    pub bucket_ttl: Duration,
    state: Mutex<LimiterState>,
}

impl RateLimiter {
    pub fn new(requests_per_second: u32, burst: u32, api_keys: Arc<ApiKeys>) -> Self {
        Self::with_bounds(
            requests_per_second,
            burst,
            api_keys,
            DEFAULT_MAX_BUCKETS,
            DEFAULT_BUCKET_TTL,
        )
    }

    pub fn with_bounds(
        requests_per_second: u32,
        burst: u32,
        api_keys: Arc<ApiKeys>,
        max_buckets: usize,
        bucket_ttl: Duration,
    ) -> Self {
        Self {
            requests_per_second: requests_per_second.max(1) as f64,
            burst: burst.max(1) as f64,
            api_keys,
            max_buckets: max_buckets.max(1),
            bucket_ttl,
            state: Mutex::new(LimiterState {
                buckets: HashMap::new(),
                last_cleanup: Instant::now(),
            }),
        }
    }

    /// Charge one request against `client`'s bucket with the given rate and burst.
    /// Returns `true` if allowed, `false` if over limit.
    pub fn allow(&self, client: &str, requests_per_second: f64, burst: f64) -> bool {
        let mut state = self.state.lock().expect("rate limiter mutex poisoned");
        let now = Instant::now();

        // Evict expired buckets periodically or when at capacity
        if now.duration_since(state.last_cleanup) >= Duration::from_secs(30)
            || (!state.buckets.contains_key(client) && state.buckets.len() >= self.max_buckets)
        {
            state
                .buckets
                .retain(|_, b| now.duration_since(b.last_seen) < self.bucket_ttl);
            state.last_cleanup = now;
        }

        // Hard upper bound: if still at capacity, evict the least-recently-seen bucket
        if !state.buckets.contains_key(client) && state.buckets.len() >= self.max_buckets {
            if let Some(oldest_key) = state
                .buckets
                .iter()
                .min_by_key(|(_, b)| b.last_seen)
                .map(|(k, _)| k.clone())
            {
                state.buckets.remove(&oldest_key);
            }
        }

        let bucket = state
            .buckets
            .entry(client.to_string())
            .or_insert_with(|| Bucket {
                tokens: burst,
                last_refill: now,
                last_seen: now,
            });

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * requests_per_second).min(burst);
        bucket.last_refill = now;
        bucket.last_seen = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Convenience for charging with the limiter's default rate and burst.
    pub fn allow_default(&self, client: &str) -> bool {
        self.allow(client, self.requests_per_second, self.burst)
    }

    /// Number of active buckets currently in the limiter.
    pub fn bucket_count(&self) -> usize {
        self.state
            .lock()
            .expect("rate limiter mutex poisoned")
            .buckets
            .len()
    }

    /// Check if the limiter currently holds a bucket for `client`.
    pub fn contains_identity(&self, client: &str) -> bool {
        self.state
            .lock()
            .expect("rate limiter mutex poisoned")
            .buckets
            .contains_key(client)
    }

    /// Explicitly trigger eviction of buckets older than `ttl` (useful for tests).
    pub fn evict_inactive(&self, ttl: Duration) {
        let mut state = self.state.lock().expect("rate limiter mutex poisoned");
        let now = Instant::now();
        state
            .buckets
            .retain(|_, b| now.duration_since(b.last_seen) < ttl);
    }
}

/// A typed 429, distinct from a silent drop or a generic 500.
fn rate_limited() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiError::new(
            "rate_limited",
            "too many requests; slow down and retry after a short delay",
        )),
    )
        .into_response()
}

/// Axum middleware: authenticate presented keys, apply effective tier limits,
/// and reject requests over limit with 429. Invalid or revoked keys are rejected
/// with 401 immediately without creating limiter buckets.
pub async fn enforce(
    State(limiter): State<Arc<RateLimiter>>,
    mut request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let presented = auth::presented_secret(headers);

    let (identity, rps, burst, caller) = if let Some(secret) = presented {
        match limiter.api_keys.verify(&secret).await {
            Ok(Ok(record)) => {
                let key_rps =
                    (record.rate_limit_per_minute as f64 / 60.0).max(limiter.requests_per_second);
                let burst_ratio = (limiter.burst / limiter.requests_per_second).max(1.0);
                let key_burst = (key_rps * burst_ratio).max(limiter.burst);
                let identity = format!("key:{}", record.key_id);
                let caller = Caller::Authenticated(record);
                (identity, key_rps, key_burst, caller)
            }
            Ok(Err(auth_err)) => {
                return auth_err.into_response();
            }
            Err(err) => {
                tracing::error!(error = %err, "internal error verifying api key");
                return auth::AuthError::UnknownKey.into_response();
            }
        }
    } else {
        let addr = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| *addr);
        let identity = match addr {
            Some(addr) => format!("ip:{}", addr.ip()),
            None => "unknown".to_string(),
        };
        (
            identity,
            limiter.requests_per_second,
            limiter.burst,
            Caller::Anonymous,
        )
    };

    if limiter.allow(&identity, rps, burst) {
        request.extensions_mut().insert(caller);
        next.run(request).await
    } else {
        rate_limited()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{router, router_with_limiter, ApiState};
    use crate::cache::AggregateCaches;
    use crate::ingest::Ingestor;
    use crate::progress::IngestionProgress;
    use crate::store::Store;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn test_limiter(rps: u32, burst: u32) -> Arc<RateLimiter> {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let api_keys = Arc::new(ApiKeys::new(store.pool().clone()));
        Arc::new(RateLimiter::new(rps, burst, api_keys))
    }

    async fn test_state() -> ApiState {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let ingestor = Ingestor::new(store);
        ApiState::new(
            ingestor,
            AggregateCaches::new(0),
            IngestionProgress::new(),
            60,
        )
    }

    #[tokio::test]
    async fn allows_requests_up_to_the_burst_then_rejects() {
        let limiter = test_limiter(1, 3).await;
        assert!(limiter.allow_default("ip:1.2.3.4"));
        assert!(limiter.allow_default("ip:1.2.3.4"));
        assert!(limiter.allow_default("ip:1.2.3.4"));
        assert!(
            !limiter.allow_default("ip:1.2.3.4"),
            "fourth immediate request should be throttled"
        );
    }

    #[tokio::test]
    async fn refills_over_time() {
        let limiter = test_limiter(100, 1).await;
        assert!(limiter.allow_default("ip:1.2.3.4"));
        assert!(!limiter.allow_default("ip:1.2.3.4"));

        std::thread::sleep(Duration::from_millis(20));
        assert!(
            limiter.allow_default("ip:1.2.3.4"),
            "should have refilled at least one token after 20ms at 100/s"
        );
    }

    #[tokio::test]
    async fn clients_are_isolated() {
        let limiter = test_limiter(1, 1).await;
        assert!(limiter.allow_default("ip:1.2.3.4"));
        assert!(!limiter.allow_default("ip:1.2.3.4"));
        assert!(
            limiter.allow_default("ip:5.6.7.8"),
            "a different client must not be affected by another's usage"
        );
    }

    #[tokio::test]
    async fn memory_bound_evicts_lru_when_capacity_reached() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let api_keys = Arc::new(ApiKeys::new(store.pool().clone()));
        let limiter = RateLimiter::with_bounds(1, 10, api_keys, 3, Duration::from_secs(300));

        assert!(limiter.allow_default("ip:1.1.1.1"));
        assert!(limiter.allow_default("ip:2.2.2.2"));
        assert!(limiter.allow_default("ip:3.3.3.3"));
        assert_eq!(limiter.bucket_count(), 3);

        // Access 4th client: should evict oldest (1.1.1.1) and stay at bound 3
        assert!(limiter.allow_default("ip:4.4.4.4"));
        assert_eq!(limiter.bucket_count(), 3);
        assert!(!limiter.contains_identity("ip:1.1.1.1"));
        assert!(limiter.contains_identity("ip:4.4.4.4"));

        // Access 5th client: should evict 2.2.2.2 and stay at bound 3
        assert!(limiter.allow_default("ip:5.5.5.5"));
        assert_eq!(limiter.bucket_count(), 3);
        assert!(!limiter.contains_identity("ip:2.2.2.2"));
        assert!(limiter.contains_identity("ip:5.5.5.5"));
    }

    #[tokio::test]
    async fn inactive_buckets_are_evicted_after_ttl() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let api_keys = Arc::new(ApiKeys::new(store.pool().clone()));
        let limiter = RateLimiter::with_bounds(1, 10, api_keys, 100, Duration::from_millis(50));

        assert!(limiter.allow_default("ip:1.1.1.1"));
        assert_eq!(limiter.bucket_count(), 1);

        std::thread::sleep(Duration::from_millis(60));
        limiter.evict_inactive(Duration::from_millis(50));
        assert_eq!(limiter.bucket_count(), 0);
    }

    #[tokio::test]
    async fn router_absent_key_charges_ip_and_allows_public_endpoint() {
        let state = test_state().await;
        let limiter = Arc::new(RateLimiter::new(1, 2, state.api_keys.clone()));
        let app = router_with_limiter(state, limiter.clone());

        let req = Request::builder()
            .uri("/v1/health")
            .body(Body::empty())
            .expect("request");
        let resp = app.clone().oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(limiter.bucket_count(), 1);
        assert!(limiter.contains_identity("unknown"));

        // Second request within burst succeeds
        let req = Request::builder()
            .uri("/v1/health")
            .body(Body::empty())
            .expect("request");
        let resp = app.clone().oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::OK);

        // Third request exceeds burst of 2 -> 429
        let req = Request::builder()
            .uri("/v1/health")
            .body(Body::empty())
            .expect("request");
        let resp = app.oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn router_valid_key_applies_tier_and_stores_key_id_not_secret() {
        let state = test_state().await;
        let issued = state
            .api_keys
            .issue("metrics-service", 600)
            .await
            .expect("issue key");
        let limiter = Arc::new(RateLimiter::new(1, 2, state.api_keys.clone()));
        let app = router_with_limiter(state, limiter.clone());

        let req = Request::builder()
            .uri("/v1/health")
            .header("x-api-key", &issued.secret)
            .body(Body::empty())
            .expect("request");
        let resp = app.oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::OK);

        // Identity stored in limiter is key:<key_id>, NEVER the secret
        let expected_identity = format!("key:{}", issued.record.key_id);
        assert!(limiter.contains_identity(&expected_identity));
        assert!(!limiter.contains_identity(&issued.secret));
        assert!(!limiter.contains_identity(&format!("key:{}", issued.secret)));
    }

    #[tokio::test]
    async fn router_invalid_key_returns_401_and_allocates_zero_buckets() {
        let state = test_state().await;
        let limiter = Arc::new(RateLimiter::new(10, 20, state.api_keys.clone()));
        let app = router_with_limiter(state, limiter.clone());

        let req = Request::builder()
            .uri("/v1/health")
            .header("x-api-key", "ski_invalid_garbage")
            .body(Body::empty())
            .expect("request");
        let resp = app.clone().oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(limiter.bucket_count(), 0);

        // Rotating invalid keys cannot grow limiter memory
        for i in 0..10 {
            let req = Request::builder()
                .uri("/v1/health")
                .header("x-api-key", format!("ski_forged_key_{i}"))
                .body(Body::empty())
                .expect("request");
            let resp = app.clone().oneshot(req).await.expect("response");
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(
            limiter.bucket_count(),
            0,
            "rotating invalid keys must create 0 buckets"
        );
    }

    #[tokio::test]
    async fn router_revoked_key_is_rejected_on_the_very_next_request() {
        let state = test_state().await;
        let issued = state
            .api_keys
            .issue("test-revocation", 600)
            .await
            .expect("issue key");
        let limiter = Arc::new(RateLimiter::new(10, 20, state.api_keys.clone()));
        let app = router_with_limiter(state.clone(), limiter.clone());

        let req = Request::builder()
            .uri("/v1/health")
            .header("x-api-key", &issued.secret)
            .body(Body::empty())
            .expect("request");
        let resp = app.clone().oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::OK);

        // Revoke the key
        assert!(state
            .api_keys
            .revoke(&issued.record.key_id)
            .await
            .expect("revoke"));

        // Next request immediately rejected with 401
        let req = Request::builder()
            .uri("/v1/health")
            .header("x-api-key", &issued.secret)
            .body(Body::empty())
            .expect("request");
        let resp = app.oneshot(req).await.expect("response");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
