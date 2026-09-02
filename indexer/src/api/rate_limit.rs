//! Per-client rate limiting for the REST API and WebSocket upgrades.
//!
//! Once the REST API and WebSocket feed are public, they are a target for
//! abusive query volume that could degrade service for legitimate consumers
//! or drive up database load and hosting cost. Every request — including a
//! WebSocket upgrade, which opens a long-lived connection — is charged
//! against a per-client token bucket before it reaches a handler.
//!
//! Limits are read from [`crate::Config`] rather than hardcoded, since the
//! right threshold will need tuning after real usage is observed.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::types::ApiError;

/// Header a client may send to be rate-limited by a stable identity rather
/// than by IP (e.g. a client behind a shared NAT or corporate proxy).
const API_KEY_HEADER: &str = "x-api-key";

/// A token bucket for one client.
struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

/// Per-client token buckets, shared across every request.
///
/// Cleared lazily: an entry for a client who has not been seen in a while is
/// simply a bucket sitting at full capacity next time they refill, which
/// costs one `HashMap` entry per distinct client seen rather than unbounded
/// growth under any adversarial pattern worth defending against here.
pub struct RateLimiter {
    requests_per_second: f64,
    burst: f64,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new(requests_per_second: u32, burst: u32) -> Self {
        Self {
            requests_per_second: requests_per_second.max(1) as f64,
            burst: burst.max(requests_per_second).max(1) as f64,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Charge one request against `client`'s bucket. Returns `true` if the
    /// request is allowed, `false` if the client is over its limit.
    fn allow(&self, client: &str) -> bool {
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");
        let now = Instant::now();
        let bucket = buckets.entry(client.to_string()).or_insert_with(|| Bucket {
            tokens: self.burst,
            last_refill: now,
        });

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.requests_per_second).min(self.burst);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Identify the client a request is charged against: the `X-API-Key` header
/// when present, otherwise the caller's IP.
fn client_key(headers: &HeaderMap, addr: Option<SocketAddr>) -> String {
    if let Some(key) = headers.get(API_KEY_HEADER).and_then(|v| v.to_str().ok()) {
        if !key.trim().is_empty() {
            return format!("key:{}", key.trim());
        }
    }
    match addr {
        Some(addr) => format!("ip:{}", addr.ip()),
        None => "unknown".to_string(),
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

/// Axum middleware: reject a request over its client's limit with 429 before
/// it reaches the handler. Applies equally to REST calls and WebSocket
/// upgrades, since both are routed through the same middleware stack.
pub async fn enforce(
    State(limiter): State<std::sync::Arc<RateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    request: Request,
    next: Next,
) -> Response {
    let addr = connect_info.map(|ConnectInfo(addr)| addr);
    let key = client_key(request.headers(), addr);
    if limiter.allow(&key) {
        next.run(request).await
    } else {
        rate_limited()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_requests_up_to_the_burst_then_rejects() {
        let limiter = RateLimiter::new(1, 3);
        assert!(limiter.allow("ip:1.2.3.4"));
        assert!(limiter.allow("ip:1.2.3.4"));
        assert!(limiter.allow("ip:1.2.3.4"));
        assert!(
            !limiter.allow("ip:1.2.3.4"),
            "fourth immediate request should be throttled"
        );
    }

    #[test]
    fn refills_over_time() {
        let limiter = RateLimiter::new(100, 1);
        assert!(limiter.allow("ip:1.2.3.4"));
        assert!(!limiter.allow("ip:1.2.3.4"));

        std::thread::sleep(Duration::from_millis(20));
        assert!(
            limiter.allow("ip:1.2.3.4"),
            "should have refilled at least one token after 20ms at 100/s"
        );
    }

    #[test]
    fn clients_are_isolated() {
        let limiter = RateLimiter::new(1, 1);
        assert!(limiter.allow("ip:1.2.3.4"));
        assert!(!limiter.allow("ip:1.2.3.4"));
        assert!(
            limiter.allow("ip:5.6.7.8"),
            "a different client must not be affected by another's usage"
        );
    }

    #[test]
    fn api_key_takes_priority_over_ip() {
        let limiter = RateLimiter::new(1, 1);
        let mut headers = HeaderMap::new();
        headers.insert(API_KEY_HEADER, "abc123".parse().unwrap());
        let addr: SocketAddr = "127.0.0.1:1234".parse().unwrap();

        let key_a = client_key(&headers, Some(addr));
        assert_eq!(key_a, "key:abc123");

        let empty_headers = HeaderMap::new();
        let key_b = client_key(&empty_headers, Some(addr));
        assert_eq!(key_b, "ip:127.0.0.1");
        assert_ne!(key_a, key_b);
    }
}
