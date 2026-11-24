//! Prometheus metrics for the indexer's API, ingestion and caches.
//!
//! The endpoint is intentionally dependency-free: the counters are atomics and
//! a couple of small mutex-guarded maps, and rendering produces Prometheus
//! text format directly. That keeps the indexer's dependency surface and its
//! startup time unchanged for a feature that is always on but cheap.
//!
//! Names match `docs/OBSERVABILITY.md`. Label values are bounded on purpose:
//! routes are normalised templates, statuses are classes such as `2xx`, and
//! event types come from the fixed `EventType::as_str` vocabulary. No raw
//! path, address or error string ever becomes a label.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::cache::AggregateCaches;
use crate::progress::IngestionProgress;

/// Histogram boundaries, in seconds. Chosen to span a local indexed read
/// through a slow aggregate and into the multi-second tail.
const BUCKETS: [f64; 11] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Cumulative bucket counts and running sum for one route.
#[derive(Debug, Clone)]
struct Histogram {
    counts: [u64; BUCKETS.len()],
    sum: f64,
    count: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            counts: [0; BUCKETS.len()],
            sum: 0.0,
            count: 0,
        }
    }
}

impl Histogram {
    fn observe(&mut self, seconds: f64) {
        self.count += 1;
        self.sum += seconds;
        for (index, upper) in BUCKETS.iter().enumerate() {
            if seconds <= *upper {
                self.counts[index] += 1;
            }
        }
    }
}

/// Shared metric state. Cloneable over `Arc`, so the API middleware, the
/// ingestion loop and the scrape handler all see the same counters.
#[derive(Debug, Default)]
pub struct Metrics {
    events_by_type: Mutex<HashMap<String, u64>>,
    requests: Mutex<HashMap<(String, String), u64>>,
    durations: Mutex<HashMap<String, Histogram>>,
    rate_limit_rejections: AtomicU64,
    websocket_connections: AtomicI64,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Count one event that was newly stored, by its wire type name.
    pub fn record_event(&self, event_type: &str) {
        *self
            .events_by_type
            .lock()
            .expect("metrics mutex poisoned")
            .entry(event_type.to_string())
            .or_insert(0) += 1;
    }

    /// Count one API response and its processing time.
    ///
    /// `route` is a normalised template and `status` a class such as `2xx`,
    /// so neither can grow with a caller's input.
    pub fn record_request(&self, route: &str, status: u16, duration: Duration) {
        let status_class = status_class(status);
        *self
            .requests
            .lock()
            .expect("metrics mutex poisoned")
            .entry((route.to_string(), status_class.to_string()))
            .or_insert(0) += 1;

        self.durations
            .lock()
            .expect("metrics mutex poisoned")
            .entry(route.to_string())
            .or_default()
            .observe(duration.as_secs_f64());
    }

    /// Count a response the rate limiter rejected.
    pub fn record_rate_limit_rejection(&self) {
        self.rate_limit_rejections.fetch_add(1, Ordering::Relaxed);
    }

    /// Track an open WebSocket connection. The returned guard decrements the
    /// gauge when the connection ends, including on an early error path.
    pub fn websocket_connected(&self) -> WebsocketGuard<'_> {
        self.websocket_connections.fetch_add(1, Ordering::Relaxed);
        WebsocketGuard {
            metrics: self,
            counted: true,
        }
    }

    fn websocket_disconnected(&self) {
        self.websocket_connections.fetch_sub(1, Ordering::Relaxed);
    }

    /// Render Prometheus text format. `progress` and `caches` supply the two
    /// gauges that already have an authoritative owner elsewhere.
    pub fn render(&self, progress: &IngestionProgress, caches: &AggregateCaches) -> String {
        let mut out = String::new();

        // Ingestion lag is read at scrape time: the progress handle already
        // keeps the freshest tip and checkpoint without locking.
        let lag = progress.snapshot().lag_ledgers();
        let _ = writeln!(
            out,
            "# HELP soroban_indexer_ingestion_lag_ledgers Head ledger minus last ingested ledger."
        );
        let _ = writeln!(out, "# TYPE soroban_indexer_ingestion_lag_ledgers gauge");
        let _ = writeln!(
            out,
            "soroban_indexer_ingestion_lag_ledgers {}",
            lag.unwrap_or(0)
        );

        let _ = writeln!(
            out,
            "# HELP soroban_indexer_events_ingested_total Events ingested, by event type."
        );
        let _ = writeln!(out, "# TYPE soroban_indexer_events_ingested_total counter");
        let events = self.events_by_type.lock().expect("metrics mutex poisoned");
        let mut event_types: Vec<&String> = events.keys().collect();
        event_types.sort();
        for event_type in event_types {
            let _ = writeln!(
                out,
                "soroban_indexer_events_ingested_total{{event_type=\"{}\"}} {}",
                escape_label(event_type),
                events[event_type]
            );
        }
        drop(events);

        let _ = writeln!(out, "# HELP soroban_indexer_api_requests_total API requests by normalised route and status class.");
        let _ = writeln!(out, "# TYPE soroban_indexer_api_requests_total counter");
        let requests = self.requests.lock().expect("metrics mutex poisoned");
        let mut routes: Vec<(&String, &String)> = requests.keys().map(|(r, s)| (r, s)).collect();
        routes.sort();
        for (route, status) in routes {
            let _ = writeln!(
                out,
                "soroban_indexer_api_requests_total{{route=\"{}\",status=\"{}\"}} {}",
                escape_label(route),
                escape_label(status),
                requests[&(route.clone(), status.clone())]
            );
        }
        drop(requests);

        let _ = writeln!(out, "# HELP soroban_indexer_api_request_duration_seconds API request latency by normalised route.");
        let _ = writeln!(
            out,
            "# TYPE soroban_indexer_api_request_duration_seconds histogram"
        );
        let durations = self.durations.lock().expect("metrics mutex poisoned");
        let mut paths: Vec<&String> = durations.keys().collect();
        paths.sort();
        for path in paths {
            let histogram = &durations[path];
            for (index, upper) in BUCKETS.iter().enumerate() {
                let _ = writeln!(
                    out,
                    "soroban_indexer_api_request_duration_seconds_bucket{{route=\"{}\",le=\"{}\"}} {}",
                    escape_label(path),
                    format_bound(*upper),
                    histogram.counts[index]
                );
            }
            let _ = writeln!(
                out,
                "soroban_indexer_api_request_duration_seconds_bucket{{route=\"{}\",le=\"+Inf\"}} {}",
                escape_label(path),
                histogram.count
            );
            let _ = writeln!(
                out,
                "soroban_indexer_api_request_duration_seconds_sum{{route=\"{}\"}} {}",
                escape_label(path),
                histogram.sum
            );
            let _ = writeln!(
                out,
                "soroban_indexer_api_request_duration_seconds_count{{route=\"{}\"}} {}",
                escape_label(path),
                histogram.count
            );
        }
        drop(durations);

        let stats = caches.leaderboard.stats();
        let ratio = stats.hit_rate().unwrap_or(0.0);
        let _ = writeln!(
            out,
            "# HELP soroban_indexer_cache_hit_ratio Ratio of cache hits to lookups."
        );
        let _ = writeln!(out, "# TYPE soroban_indexer_cache_hit_ratio gauge");
        let _ = writeln!(out, "soroban_indexer_cache_hit_ratio {ratio}");

        let _ = writeln!(out, "# HELP soroban_indexer_rate_limit_rejections_total Requests rejected by the rate limiter.");
        let _ = writeln!(
            out,
            "# TYPE soroban_indexer_rate_limit_rejections_total counter"
        );
        let _ = writeln!(
            out,
            "soroban_indexer_rate_limit_rejections_total {}",
            self.rate_limit_rejections.load(Ordering::Relaxed)
        );

        let connections = self.websocket_connections.load(Ordering::Relaxed).max(0);
        let _ = writeln!(
            out,
            "# HELP soroban_indexer_websocket_connections Currently open WebSocket connections."
        );
        let _ = writeln!(out, "# TYPE soroban_indexer_websocket_connections gauge");
        let _ = writeln!(out, "soroban_indexer_websocket_connections {connections}");

        out
    }
}

/// Decrements the WebSocket gauge on every exit path.
pub struct WebsocketGuard<'a> {
    metrics: &'a Metrics,
    counted: bool,
}

impl Drop for WebsocketGuard<'_> {
    fn drop(&mut self) {
        if self.counted {
            self.metrics.websocket_disconnected();
            self.counted = false;
        }
    }
}

/// Group raw HTTP statuses into bounded classes. A status label of `404` would
/// be harmless, but a class is what the observability catalogue specifies and
/// it keeps a new status code from creating a new time series.
pub fn status_class(status: u16) -> &'static str {
    match status / 100 {
        1 => "1xx",
        2 => "2xx",
        3 => "3xx",
        4 => "4xx",
        5 => "5xx",
        _ => "other",
    }
}

/// Collapse a request path into a bounded route template.
///
/// Routers put `{param}` templates in extensions, but a fallback is still
/// needed for requests that never reached a route (404s and upgrades). Long
/// path segments and all-numeric or all-hex identifiers are replaced so an
/// arbitrary URL cannot inflate the label set.
pub fn normalize_route(path: &str) -> String {
    let mut segments: Vec<String> = path
        .split('/')
        .map(|segment| {
            if (segment.starts_with('{') && segment.ends_with('}')) || segment.is_empty() {
                return segment.to_string();
            }
            let looks_like_id =
                segment.len() >= 16 && segment.chars().all(|c| c.is_ascii_hexdigit());
            let looks_like_number =
                segment.len() > 3 && segment.chars().all(|c| c.is_ascii_digit());
            if looks_like_id || looks_like_number {
                "{id}".to_string()
            } else if segment.len() > 40 {
                format!("{}_{}", &segment[..40], "...")
            } else {
                segment.to_string()
            }
        })
        .collect();

    let mut route = segments.drain(..).collect::<Vec<_>>().join("/");
    if route.len() > 128 {
        route.truncate(128);
    }
    if route.is_empty() {
        route.push('/');
    }
    route
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn format_bound(bound: f64) -> String {
    if bound.fract() == 0.0 {
        format!("{bound:.1}")
    } else {
        bound.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn render_includes_every_documented_metric_family() {
        let metrics = Metrics::new();
        let caches = AggregateCaches::from_secs(10);
        let rendered = metrics.render(&IngestionProgress::new(), &caches);

        for family in [
            "soroban_indexer_ingestion_lag_ledgers",
            "soroban_indexer_events_ingested_total",
            "soroban_indexer_api_requests_total",
            "soroban_indexer_api_request_duration_seconds",
            "soroban_indexer_cache_hit_ratio",
            "soroban_indexer_rate_limit_rejections_total",
            "soroban_indexer_websocket_connections",
        ] {
            assert!(
                rendered.contains(&format!("# TYPE {family}")),
                "missing {family} in:\n{rendered}"
            );
        }
    }

    #[test]
    fn recorded_values_are_rendered_with_bounded_labels() {
        let metrics = Metrics::new();
        metrics.record_event("task_claimed");
        metrics.record_request("/v1/tasks/{task_id}", 429, Duration::from_millis(12));
        metrics.record_rate_limit_rejection();
        let guard = metrics.websocket_connected();

        let progress = IngestionProgress::new();
        progress.observe_tip(120);
        progress.observe_ingested(110);
        let caches = AggregateCaches::from_secs(10);
        let rendered = metrics.render(&progress, &caches);

        assert!(rendered.contains("soroban_indexer_ingestion_lag_ledgers 10"));
        assert!(rendered
            .contains("soroban_indexer_events_ingested_total{event_type=\"task_claimed\"} 1"));
        assert!(rendered.contains("route=\"/v1/tasks/{task_id}\",status=\"4xx\"} 1"));
        assert!(rendered.contains("soroban_indexer_rate_limit_rejections_total 1"));
        assert!(rendered.contains("soroban_indexer_websocket_connections 1"));
        assert!(rendered.contains(
            "soroban_indexer_api_request_duration_seconds_count{route=\"/v1/tasks/{task_id}\"} 1"
        ));

        drop(guard);
        let rendered = metrics.render(&progress, &caches);
        assert!(rendered.contains("soroban_indexer_websocket_connections 0"));
    }

    #[test]
    fn histogram_buckets_are_cumulative_and_end_at_infinity() {
        let metrics = Metrics::new();
        metrics.record_request("/v1/health", 200, Duration::from_millis(20));
        let rendered = metrics.render(&IngestionProgress::new(), &AggregateCaches::from_secs(10));
        let buckets: Vec<u64> = rendered
            .lines()
            .filter(|line| line.contains("_bucket{route=\"/v1/health\""))
            .map(|line| line.rsplit(' ').next().unwrap().parse().unwrap())
            .collect();

        assert_eq!(buckets.len(), BUCKETS.len() + 1);
        assert!(buckets.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(*buckets.last().unwrap(), 1);
    }

    #[test]
    fn normalize_route_collapses_identifiers_and_keeps_templates() {
        assert_eq!(
            normalize_route("/v1/tasks/{task_id}"),
            "/v1/tasks/{task_id}"
        );
        assert_eq!(
            normalize_route("/v1/tasks/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            "/v1/tasks/{id}"
        );
        assert_eq!(normalize_route("/v1/events?x=1"), "/v1/events?x=1");
    }

    #[test]
    fn labels_are_escaped() {
        assert_eq!(escape_label("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }
}
