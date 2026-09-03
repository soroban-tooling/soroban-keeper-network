//! Time-to-live cache for the expensive aggregate queries.
//!
//! The leaderboard folds every `task_executed` event in the window on every
//! request. Each individual call is fast enough today, but the cost is
//! proportional to history and the dashboard's traffic is not: a page that
//! twenty people have open refreshes twenty times, and each refresh is a full
//! aggregation over the same rows producing the same answer.
//!
//! # Why a TTL rather than explicit invalidation
//!
//! Explicit invalidation is the more precise design and the wrong one here.
//! The correct key to invalidate on is "any `task_executed` event was
//! ingested", which is exactly the event that arrives continuously while the
//! indexer is caught up — so an invalidate-on-write cache would spend most of
//! its life empty during normal operation, and would be at its emptiest
//! precisely when traffic is highest.
//!
//! It is also easy to get subtly wrong: the leaderboard is parameterised by
//! `since`, so a new event invalidates every window containing it and no
//! other, and a wrong answer here is a wrong answer served silently.
//!
//! A short TTL trades a bounded, *stated* staleness for a cache that is
//! actually warm when it matters. The bound is the guarantee:
//! **no cached response is ever older than the TTL.** At the default of 10
//! seconds a viewer can be looking at numbers up to 10 seconds behind the
//! chain, against a ~5s ledger close — under two ledgers, and less than the
//! time it takes to read the page. The dashboard is not a trading screen.
//!
//! Configurable through `INDEXER_CACHE_TTL_SECS`; `0` disables caching
//! entirely, which is the escape hatch for anyone who needs
//! read-your-own-writes and is willing to pay for it.
//!
//! # What is not cached
//!
//! Point lookups (`/tasks/{id}`, `/owners/{owner}/tasks`) are indexed reads
//! whose cost does not grow with traffic in the same way, and they are the
//! reads most likely to be checked immediately after a write. Caching them
//! would buy little and cost the freshness where it is most noticeable.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Default staleness bound for cached aggregates.
pub const DEFAULT_TTL_SECS: u64 = 10;

/// How many distinct keys one cache retains.
///
/// The leaderboard's key space is bounded in practice (two ranking metrics ×
/// a handful of window/limit combinations the dashboard actually uses), but it
/// is caller-supplied, so it is bounded here too: `since` is an arbitrary
/// integer and an unbounded map keyed on it is a memory-exhaustion lever for
/// anyone who can send requests.
pub const MAX_ENTRIES: usize = 256;

/// Hit and miss counters, for the load test to assert against.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    /// Entries dropped because they were older than the TTL when read.
    pub expirations: u64,
    /// Entries dropped to keep the map under [`MAX_ENTRIES`].
    pub evictions: u64,
}

impl CacheStats {
    /// Fraction of lookups served from cache, or `None` before any lookup.
    pub fn hit_rate(&self) -> Option<f64> {
        let total = self.hits + self.misses;
        (total > 0).then(|| self.hits as f64 / total as f64)
    }
}

struct Entry<V> {
    value: V,
    stored_at: Instant,
}

struct Inner<K, V> {
    entries: HashMap<K, Entry<V>>,
    stats: CacheStats,
}

/// A TTL cache over one query's results.
///
/// Cloning shares the underlying map, so the cache lives in [`ApiState`] and
/// every handler clone reads the same entries.
///
/// [`ApiState`]: crate::api::ApiState
pub struct TtlCache<K, V> {
    inner: Arc<Mutex<Inner<K, V>>>,
    ttl: Duration,
    max_entries: usize,
}

impl<K, V> Clone for TtlCache<K, V> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            ttl: self.ttl,
            max_entries: self.max_entries,
        }
    }
}

impl<K, V> TtlCache<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone,
{
    pub fn new(ttl: Duration) -> Self {
        Self::with_capacity(ttl, MAX_ENTRIES)
    }

    pub fn with_capacity(ttl: Duration, max_entries: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                entries: HashMap::new(),
                stats: CacheStats::default(),
            })),
            ttl,
            max_entries: max_entries.max(1),
        }
    }

    /// True when this cache is a no-op (`ttl == 0`).
    pub fn is_disabled(&self) -> bool {
        self.ttl.is_zero()
    }

    pub fn stats(&self) -> CacheStats {
        self.inner.lock().expect("cache mutex poisoned").stats
    }

    /// Drop every entry. For tests and for an operator-triggered flush.
    pub fn clear(&self) {
        self.inner
            .lock()
            .expect("cache mutex poisoned")
            .entries
            .clear();
    }

    /// Return the cached value for `key`, or compute and store it.
    ///
    /// `compute` runs **outside** the lock. Holding a mutex across an `await`
    /// would serialise every request behind the slowest aggregation and turn a
    /// cache into a queue — the opposite of the point. The cost is that a
    /// simultaneous burst of misses on a cold key can each compute once; that
    /// is the same work the uncached path already does, so it is never worse
    /// than today, and the second one lands in the cache for everyone after.
    pub async fn get_or_insert_with<F, Fut, E>(&self, key: K, compute: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<V, E>>,
    {
        if self.is_disabled() {
            return compute().await;
        }

        if let Some(hit) = self.lookup(&key) {
            return Ok(hit);
        }

        let value = compute().await?;
        self.store(key, value.clone());
        Ok(value)
    }

    fn lookup(&self, key: &K) -> Option<V> {
        let mut inner = self.inner.lock().expect("cache mutex poisoned");
        match inner.entries.get(key) {
            Some(entry) if entry.stored_at.elapsed() < self.ttl => {
                let value = entry.value.clone();
                inner.stats.hits += 1;
                Some(value)
            }
            Some(_) => {
                // Expired: drop it rather than leaving it to be re-checked on
                // every later lookup.
                inner.entries.remove(key);
                inner.stats.expirations += 1;
                inner.stats.misses += 1;
                None
            }
            None => {
                inner.stats.misses += 1;
                None
            }
        }
    }

    fn store(&self, key: K, value: V) {
        let mut inner = self.inner.lock().expect("cache mutex poisoned");

        if inner.entries.len() >= self.max_entries && !inner.entries.contains_key(&key) {
            // Evict everything already past its TTL first — that is free, and
            // usually enough.
            let ttl = self.ttl;
            let before = inner.entries.len();
            inner.entries.retain(|_, e| e.stored_at.elapsed() < ttl);
            inner.stats.evictions += (before - inner.entries.len()) as u64;

            // Still full: drop the oldest entry. Not an LRU — the TTL means
            // nothing lives long enough for recency to be worth tracking, and
            // this path only runs against a key space wider than the dashboard
            // uses.
            if inner.entries.len() >= self.max_entries {
                if let Some(oldest) = inner
                    .entries
                    .iter()
                    .min_by_key(|(_, e)| e.stored_at)
                    .map(|(k, _)| k.clone())
                {
                    inner.entries.remove(&oldest);
                    inner.stats.evictions += 1;
                }
            }
        }

        inner.entries.insert(
            key,
            Entry {
                value,
                stored_at: Instant::now(),
            },
        );
    }
}

/// Cache key for a leaderboard request: the full parameter set, so two
/// requests share an entry only when they would produce the same answer.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LeaderboardKey {
    pub rank_by: crate::queries::leaderboard::RankBy,
    pub since: Option<i64>,
    pub limit: u32,
}

/// Every aggregate cache the API holds, so a handler takes one clone.
#[derive(Clone)]
pub struct AggregateCaches {
    pub leaderboard: TtlCache<LeaderboardKey, crate::queries::leaderboard::Leaderboard>,
}

impl AggregateCaches {
    pub fn new(ttl: Duration) -> Self {
        Self {
            leaderboard: TtlCache::new(ttl),
        }
    }

    /// Caches built from the configured TTL.
    pub fn from_secs(ttl_secs: u64) -> Self {
        Self::new(Duration::from_secs(ttl_secs))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn cache(ttl_ms: u64) -> TtlCache<u32, String> {
        TtlCache::new(Duration::from_millis(ttl_ms))
    }

    async fn counted<F>(
        c: &TtlCache<u32, String>,
        key: u32,
        calls: &AtomicUsize,
        value: F,
    ) -> String
    where
        F: Fn() -> String,
    {
        c.get_or_insert_with(key, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, std::convert::Infallible>(value())
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_repeated_query_is_computed_once_within_the_ttl() {
        let c = cache(60_000);
        let calls = AtomicUsize::new(0);

        for _ in 0..10 {
            assert_eq!(counted(&c, 1, &calls, || "board".into()).await, "board");
        }

        // The whole point: ten identical requests, one aggregation.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(c.stats().hits, 9);
        assert_eq!(c.stats().misses, 1);
        assert_eq!(c.stats().hit_rate(), Some(0.9));
    }

    #[tokio::test]
    async fn the_value_is_recomputed_once_the_ttl_expires() {
        let c = cache(20);
        let calls = AtomicUsize::new(0);

        assert_eq!(counted(&c, 1, &calls, || "first".into()).await, "first");
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(counted(&c, 1, &calls, || "second".into()).await, "second");

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // No cached response outlives the TTL — that bound is the guarantee.
        assert_eq!(c.stats().expirations, 1);
    }

    #[tokio::test]
    async fn different_parameters_do_not_share_an_entry() {
        let c = cache(60_000);
        let calls = AtomicUsize::new(0);

        counted(&c, 1, &calls, || "one".into()).await;
        counted(&c, 2, &calls, || "two".into()).await;
        assert_eq!(counted(&c, 1, &calls, || "unused".into()).await, "one");
        assert_eq!(counted(&c, 2, &calls, || "unused".into()).await, "two");

        // Serving one window's answer for another is a wrong answer served
        // silently, which is worse than the cost the cache saves.
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_zero_ttl_disables_the_cache_entirely() {
        let c = cache(0);
        let calls = AtomicUsize::new(0);

        counted(&c, 1, &calls, || "x".into()).await;
        counted(&c, 1, &calls, || "x".into()).await;

        assert!(c.is_disabled());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // A disabled cache records nothing rather than reporting misses it
        // never had a chance to serve.
        assert_eq!(c.stats(), CacheStats::default());
    }

    #[tokio::test]
    async fn a_failed_computation_is_not_cached() {
        let c: TtlCache<u32, String> = TtlCache::new(Duration::from_secs(60));

        let err: Result<String, &str> = c.get_or_insert_with(1, || async { Err("boom") }).await;
        assert_eq!(err, Err("boom"));

        // Caching a failure would serve the outage for a full TTL after it
        // ended.
        let ok: Result<String, &str> = c
            .get_or_insert_with(1, || async { Ok("recovered".to_string()) })
            .await;
        assert_eq!(ok.unwrap(), "recovered");
        assert_eq!(c.stats().hits, 0);
    }

    #[tokio::test]
    async fn the_key_space_is_bounded() {
        let c: TtlCache<u32, String> = TtlCache::with_capacity(Duration::from_secs(60), 4);
        let calls = AtomicUsize::new(0);

        // `since` is caller-supplied, so an unbounded map is a
        // memory-exhaustion lever for anyone who can send requests.
        for key in 0..50 {
            counted(&c, key, &calls, || "v".into()).await;
        }

        assert!(c.stats().evictions > 0);
    }

    #[tokio::test]
    async fn the_cache_is_shared_across_clones() {
        let c = cache(60_000);
        let calls = AtomicUsize::new(0);

        counted(&c, 1, &calls, || "shared".into()).await;
        // Handlers hold clones of ApiState; they must share entries, not each
        // keep their own.
        let handler_copy = c.clone();
        assert_eq!(
            counted(&handler_copy, 1, &calls, || "unused".into()).await,
            "shared"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hit_rate_is_absent_before_any_lookup() {
        let c: TtlCache<u32, String> = TtlCache::new(Duration::from_secs(60));
        assert_eq!(c.stats().hit_rate(), None);
    }
}
