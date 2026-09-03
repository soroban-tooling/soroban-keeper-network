//! API key authentication for write-sensitive and high-cost endpoints.
//!
//! Most of this API is public read-only data that is already visible on chain,
//! and authenticating it would add friction to no purpose. The endpoints that
//! *do* need a caller identity are the expensive ones — bulk export, and
//! anything costly enough that "who is doing this" matters when responding to
//! abuse.
//!
//! So keys are **optional and additive**, never a wall:
//!
//! | Caller | Rate limit | Cost-sensitive endpoints |
//! |---|---|---|
//! | No key | default | refused |
//! | Valid key | the key's own, higher limit | allowed |
//! | Invalid or revoked key | — | `401`, immediately |
//!
//! Note the last row is not "falls back to anonymous". A request that presents
//! a key is asserting an identity, and silently serving it as anonymous would
//! hide a revoked key from the caller — they would see a slower service rather
//! than a rejected credential, and would have no reason to notice.
//!
//! # Revocation is checked per request, on purpose
//!
//! The acceptance criterion is that *a revoked key is rejected on the next
//! request, not after some caching delay long enough to matter for abuse
//! response.* Revocation exists precisely for the moment a key is being abused,
//! and a cache TTL is exactly the window an abuser gets to keep going after
//! someone has already decided to stop them.
//!
//! Every request therefore reads the key's current state from the store. That
//! is one indexed lookup on the primary key of a small table, against a local
//! SQLite file — orders of magnitude cheaper than the queries the authenticated
//! endpoints then run, and the cost falls only on requests that present a key.
//! If that ever becomes a real bottleneck, the answer is an invalidation-on-
//! revoke cache, never a TTL.
//!
//! # Keys are stored hashed
//!
//! The store holds a digest, never the key. A database dump — a backup, a
//! leaked read replica, an over-broad support query — must not hand out working
//! credentials, and issuance is the only moment the plaintext exists.
use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

/// Header carrying the key. `Authorization: Bearer …` is also accepted.
pub const API_KEY_HEADER: &str = "x-api-key";

/// Rate limit applied to an unauthenticated caller.
///
/// Owned by 0235's rate limiter; named here so the tiering has something
/// concrete to be relative to before that lands.
pub const DEFAULT_RATE_LIMIT_PER_MINUTE: u32 = 60;

/// What a caller is allowed to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// No key presented. Core read endpoints only, at the default limit.
    Anonymous,
    /// A valid, unrevoked key.
    Authenticated(ApiKeyRecord),
}

impl Caller {
    /// Requests per minute this caller may make.
    pub fn rate_limit_per_minute(&self) -> u32 {
        match self {
            Caller::Anonymous => DEFAULT_RATE_LIMIT_PER_MINUTE,
            Caller::Authenticated(key) => key.rate_limit_per_minute,
        }
    }

    /// May this caller reach cost-sensitive endpoints such as bulk export?
    ///
    /// The point of the key is per-consumer accountability on expensive
    /// operations, so this is what a key actually buys beyond a higher limit.
    pub fn may_access_cost_sensitive(&self) -> bool {
        matches!(self, Caller::Authenticated(_))
    }

    /// A label for logs and abuse response. Never the key itself.
    pub fn identity(&self) -> &str {
        match self {
            Caller::Anonymous => "anonymous",
            Caller::Authenticated(key) => &key.label,
        }
    }
}

/// A key as stored — never including the secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKeyRecord {
    /// Public identifier, safe to log and to quote in a support conversation.
    pub key_id: String,
    /// Human label: which consumer this was issued to.
    pub label: String,
    pub rate_limit_per_minute: u32,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
}

impl ApiKeyRecord {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

/// A freshly issued key. The only moment the plaintext exists.
#[derive(Debug, Clone)]
pub struct IssuedApiKey {
    pub record: ApiKeyRecord,
    /// Give this to the consumer. It is not recoverable afterwards.
    pub secret: String,
}

/// Why a presented key was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("the API key is not recognised")]
    UnknownKey,
    #[error("the API key has been revoked")]
    RevokedKey,
    #[error("this endpoint requires an API key")]
    KeyRequired,
}

impl AuthError {
    pub fn status(&self) -> StatusCode {
        match self {
            AuthError::UnknownKey | AuthError::RevokedKey => StatusCode::UNAUTHORIZED,
            AuthError::KeyRequired => StatusCode::UNAUTHORIZED,
        }
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let code = match self {
            AuthError::UnknownKey => "unknown_api_key",
            AuthError::RevokedKey => "revoked_api_key",
            AuthError::KeyRequired => "api_key_required",
        };
        (
            self.status(),
            axum::Json(crate::api::types::ApiError::new(code, self.to_string())),
        )
            .into_response()
    }
}

/// Issue, revoke and verify API keys.
///
/// Issuance and revocation are administrative operations, not self-service in
/// this version — there is deliberately no HTTP route that reaches them.
pub struct ApiKeys {
    pool: SqlitePool,
}

impl ApiKeys {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Issue a key for `label`, returning the plaintext exactly once.
    pub async fn issue(&self, label: &str, rate_limit_per_minute: u32) -> Result<IssuedApiKey> {
        let key_id = random_token(16);
        let secret_part = random_token(32);
        // The transmitted secret carries its own id, so verification is a
        // primary-key lookup rather than a scan-and-compare over every stored
        // key — which would get slower as keys accumulate and would compare
        // against revoked ones too.
        let secret = format!("ski_{key_id}_{secret_part}");
        let now = chrono::Utc::now().timestamp();

        sqlx::query(
            "INSERT INTO api_keys (key_id, label, secret_hash, rate_limit_per_minute, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&key_id)
        .bind(label)
        .bind(hash_secret(&secret))
        .bind(rate_limit_per_minute)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("issuing an api key")?;

        Ok(IssuedApiKey {
            record: ApiKeyRecord {
                key_id,
                label: label.to_string(),
                rate_limit_per_minute,
                created_at: now,
                revoked_at: None,
            },
            secret,
        })
    }

    /// Revoke `key_id`. Takes effect on the caller's next request.
    ///
    /// The row is marked rather than deleted: an abuse investigation needs to
    /// know a key existed, who held it, and when it was withdrawn.
    pub async fn revoke(&self, key_id: &str) -> Result<bool> {
        let now = chrono::Utc::now().timestamp();
        let result = sqlx::query(
            "UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(key_id)
        .execute(&self.pool)
        .await
        .context("revoking an api key")?;

        Ok(result.rows_affected() > 0)
    }

    /// Every issued key, revoked ones included. Administrative use.
    pub async fn list(&self) -> Result<Vec<ApiKeyRecord>> {
        let rows = sqlx::query(
            "SELECT key_id, label, rate_limit_per_minute, created_at, revoked_at
             FROM api_keys ORDER BY created_at",
        )
        .fetch_all(&self.pool)
        .await
        .context("listing api keys")?;

        Ok(rows.into_iter().map(row_to_record).collect())
    }

    /// Verify a presented secret against current state.
    ///
    /// Reads the store every time — see the module note on why there is no
    /// cache here.
    pub async fn verify(&self, secret: &str) -> Result<Result<ApiKeyRecord, AuthError>> {
        let Some(key_id) = key_id_of(secret) else {
            return Ok(Err(AuthError::UnknownKey));
        };

        let row = sqlx::query(
            "SELECT key_id, label, secret_hash, rate_limit_per_minute, created_at, revoked_at
             FROM api_keys WHERE key_id = ?",
        )
        .bind(key_id)
        .fetch_optional(&self.pool)
        .await
        .context("verifying an api key")?;

        let Some(row) = row else {
            return Ok(Err(AuthError::UnknownKey));
        };

        let stored_hash: String = row.get("secret_hash");
        if !constant_time_eq(&hash_secret(secret), &stored_hash) {
            // A well-formed id with the wrong secret is reported as unknown
            // rather than "wrong secret": telling a caller that an id exists
            // narrows the search for anyone probing.
            return Ok(Err(AuthError::UnknownKey));
        }

        let record = row_to_record(row);
        if record.is_revoked() {
            return Ok(Err(AuthError::RevokedKey));
        }

        Ok(Ok(record))
    }

    /// Resolve the caller for a request's headers.
    ///
    /// No header at all is [`Caller::Anonymous`] — that is the ordinary public
    /// case, not a failure. A header that is present but bad is an error,
    /// because the caller asserted an identity and needs to hear that it was
    /// refused.
    pub async fn authenticate(&self, headers: &HeaderMap) -> Result<Result<Caller, AuthError>> {
        let Some(secret) = presented_secret(headers) else {
            return Ok(Ok(Caller::Anonymous));
        };

        Ok(match self.verify(&secret).await? {
            Ok(record) => Ok(Caller::Authenticated(record)),
            Err(error) => Err(error),
        })
    }
}

/// Extract the presented secret from `x-api-key` or `Authorization: Bearer`.
fn presented_secret(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(API_KEY_HEADER).and_then(|v| v.to_str().ok()) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    let rest = authorization.strip_prefix("Bearer ")?.trim();
    (!rest.is_empty()).then(|| rest.to_string())
}

/// The key id embedded in a secret, if it is well formed.
fn key_id_of(secret: &str) -> Option<&str> {
    let rest = secret.strip_prefix("ski_")?;
    let (key_id, secret_part) = rest.split_once('_')?;
    (!key_id.is_empty() && !secret_part.is_empty()).then_some(key_id)
}

/// Hash a secret for storage.
///
/// FNV-1a/64 over a salted input is **not** adequate for this and is a
/// placeholder: it is here so the store never holds plaintext while this crate
/// has no password-hashing dependency, and adding one is a dependency decision
/// that should not ride along inside a feature branch. Before keys are issued
/// to anyone outside the project this must become a proper KDF (argon2 or
/// scrypt) — the migration is straightforward because the column stores an
/// opaque string and keys can be reissued.
fn hash_secret(secret: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    const SALT: &[u8] = b"keeper-indexer/api-key/v1";

    let mut hash = OFFSET;
    for byte in SALT.iter().chain(secret.as_bytes()) {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(PRIME);
    }
    format!("fnv1a64${hash:016x}")
}

/// Compare two digests without an early exit on the first differing byte.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A random lowercase-hex token of `bytes` bytes.
///
/// Seeded from the OS through `getrandom`, which `sqlx` already pulls in, so
/// this needs no new dependency.
fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source is unavailable");
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> ApiKeyRecord {
    ApiKeyRecord {
        key_id: row.get("key_id"),
        label: row.get("label"),
        rate_limit_per_minute: row.get::<i64, _>("rate_limit_per_minute") as u32,
        created_at: row.get("created_at"),
        revoked_at: row.get::<Option<i64>, _>("revoked_at"),
    }
}

/// Require a key, for a cost-sensitive handler.
///
/// Handlers call this rather than checking [`Caller`] themselves, so "this
/// endpoint needs a key" is one decision in one place instead of a condition
/// each new expensive route has to remember to repeat.
pub fn require_key(caller: &Caller) -> Result<&ApiKeyRecord, AuthError> {
    match caller {
        Caller::Authenticated(record) => Ok(record),
        Caller::Anonymous => Err(AuthError::KeyRequired),
    }
}

/// Axum extractor-style helper: resolve the caller from request headers.
pub async fn caller_from(
    State(keys): State<std::sync::Arc<ApiKeys>>,
    headers: HeaderMap,
) -> Result<Caller, AuthError> {
    match keys.authenticate(&headers).await {
        Ok(result) => result,
        // A store failure is not an authorisation decision. Failing closed is
        // the safe reading: serving an authenticated caller as anonymous would
        // silently downgrade them, and serving an unknown key as valid would be
        // worse.
        Err(_) => Err(AuthError::UnknownKey),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    async fn keys() -> ApiKeys {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        ApiKeys::new(store.pool().clone())
    }

    fn headers_with(name: &str, value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
            value.parse().expect("header value"),
        );
        headers
    }

    #[tokio::test]
    async fn no_key_is_anonymous_rather_than_an_error() {
        // The core read endpoints are public; requiring a key would add
        // friction to data already visible on chain.
        let keys = keys().await;
        let caller = keys
            .authenticate(&HeaderMap::new())
            .await
            .expect("store")
            .expect("anonymous is not an error");

        assert_eq!(caller, Caller::Anonymous);
        assert_eq!(
            caller.rate_limit_per_minute(),
            DEFAULT_RATE_LIMIT_PER_MINUTE
        );
        assert!(!caller.may_access_cost_sensitive());
    }

    #[tokio::test]
    async fn a_valid_key_raises_the_limit_and_unlocks_cost_sensitive_endpoints() {
        let keys = keys().await;
        let issued = keys.issue("dashboard", 600).await.expect("issue");

        let caller = keys
            .authenticate(&headers_with(API_KEY_HEADER, &issued.secret))
            .await
            .expect("store")
            .expect("valid key");

        assert_eq!(caller.rate_limit_per_minute(), 600);
        assert!(caller.rate_limit_per_minute() > DEFAULT_RATE_LIMIT_PER_MINUTE);
        assert!(caller.may_access_cost_sensitive());
        assert!(require_key(&caller).is_ok());
        assert_eq!(caller.identity(), "dashboard");
    }

    #[tokio::test]
    async fn a_revoked_key_is_rejected_on_the_very_next_request() {
        // The acceptance criterion. Revocation exists for the moment a key is
        // being abused, and a cache TTL is exactly the window an abuser gets
        // after someone has already decided to stop them.
        let keys = keys().await;
        let issued = keys.issue("leaky-integration", 600).await.expect("issue");
        let headers = headers_with(API_KEY_HEADER, &issued.secret);

        assert!(matches!(
            keys.authenticate(&headers).await.expect("store"),
            Ok(Caller::Authenticated(_))
        ));

        assert!(keys.revoke(&issued.record.key_id).await.expect("revoke"));

        // No sleep, no cache flush, no restart.
        assert_eq!(
            keys.authenticate(&headers).await.expect("store"),
            Err(AuthError::RevokedKey)
        );
    }

    #[tokio::test]
    async fn a_bad_key_is_refused_rather_than_downgraded_to_anonymous() {
        // Serving it as anonymous would hide a revoked credential: the caller
        // would see a slower service and no reason to notice.
        let keys = keys().await;

        assert_eq!(
            keys.authenticate(&headers_with(API_KEY_HEADER, "ski_deadbeef_nonsense"))
                .await
                .expect("store"),
            Err(AuthError::UnknownKey)
        );
        assert_eq!(
            keys.authenticate(&headers_with(API_KEY_HEADER, "not-even-a-key"))
                .await
                .expect("store"),
            Err(AuthError::UnknownKey)
        );
    }

    #[tokio::test]
    async fn a_real_id_with_the_wrong_secret_reads_as_unknown() {
        // Confirming that an id exists would narrow the search for anyone
        // probing.
        let keys = keys().await;
        let issued = keys.issue("dashboard", 600).await.expect("issue");
        let forged = format!("ski_{}_{}", issued.record.key_id, "0".repeat(64));

        assert_eq!(
            keys.authenticate(&headers_with(API_KEY_HEADER, &forged))
                .await
                .expect("store"),
            Err(AuthError::UnknownKey)
        );
    }

    #[tokio::test]
    async fn the_bearer_header_works_too() {
        let keys = keys().await;
        let issued = keys.issue("cli", 300).await.expect("issue");

        let caller = keys
            .authenticate(&headers_with(
                "authorization",
                &format!("Bearer {}", issued.secret),
            ))
            .await
            .expect("store")
            .expect("valid key");

        assert_eq!(caller.rate_limit_per_minute(), 300);
    }

    #[tokio::test]
    async fn the_plaintext_secret_is_never_stored() {
        // A database dump must not hand out working credentials.
        let keys = keys().await;
        let issued = keys.issue("dashboard", 600).await.expect("issue");

        let stored: String = sqlx::query("SELECT secret_hash FROM api_keys WHERE key_id = ?")
            .bind(&issued.record.key_id)
            .fetch_one(&keys.pool)
            .await
            .expect("query")
            .get("secret_hash");

        assert_ne!(stored, issued.secret);
        assert!(!stored.contains(&issued.secret));
    }

    #[tokio::test]
    async fn two_issued_keys_are_distinct() {
        let keys = keys().await;
        let a = keys.issue("one", 100).await.expect("issue");
        let b = keys.issue("two", 100).await.expect("issue");

        assert_ne!(a.secret, b.secret);
        assert_ne!(a.record.key_id, b.record.key_id);
    }

    #[tokio::test]
    async fn revoking_keeps_the_row_for_the_audit_trail() {
        // An abuse investigation needs to know a key existed, who held it, and
        // when it was withdrawn.
        let keys = keys().await;
        let issued = keys.issue("leaky-integration", 600).await.expect("issue");
        keys.revoke(&issued.record.key_id).await.expect("revoke");

        let listed = keys.list().await.expect("list");
        let record = listed
            .iter()
            .find(|record| record.key_id == issued.record.key_id)
            .expect("the revoked key is still listed");

        assert_eq!(record.label, "leaky-integration");
        assert!(record.is_revoked());
    }

    #[tokio::test]
    async fn revoking_twice_is_reported_as_a_no_op() {
        let keys = keys().await;
        let issued = keys.issue("dashboard", 600).await.expect("issue");

        assert!(keys.revoke(&issued.record.key_id).await.expect("first"));
        assert!(!keys.revoke(&issued.record.key_id).await.expect("second"));
        assert!(!keys.revoke("no-such-key").await.expect("missing"));
    }

    #[tokio::test]
    async fn an_anonymous_caller_cannot_reach_a_cost_sensitive_handler() {
        let keys = keys().await;
        let caller = keys
            .authenticate(&HeaderMap::new())
            .await
            .expect("store")
            .expect("anonymous");

        assert_eq!(require_key(&caller), Err(AuthError::KeyRequired));
        assert_eq!(AuthError::KeyRequired.status(), StatusCode::UNAUTHORIZED);
    }
}
