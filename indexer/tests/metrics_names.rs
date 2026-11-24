//! Checks the indexer's exported metric names against the canonical catalogue
//! in docs/OBSERVABILITY.md.
//!
//! `cargo test` always validates the catalogue itself (non-empty, uniquely
//! named, containing the core families). When `INDEXER_METRICS_URL` points at a
//! running indexer, the test also scrapes `/metrics` and requires an exact
//! match, so a renamed or undocumented metric fails the check.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

const DOC_RELATIVE: &str = "docs/OBSERVABILITY.md";
const SECTION_START: &str = "### Indexer (`soroban_indexer_`)";
const SECTION_END: &str = "## Structured log fields";

fn doc_text() -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("indexer crate has a parent directory")
        .to_path_buf();
    fs::read_to_string(root.join(DOC_RELATIVE))
        .unwrap_or_else(|err| panic!("cannot read {DOC_RELATIVE}: {err}"))
}

fn section<'a>(doc: &'a str, start: &str, end: &str) -> &'a str {
    let from = doc
        .find(start)
        .unwrap_or_else(|| panic!("{start} missing from {DOC_RELATIVE}"));
    let rest = &doc[from + start.len()..];
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("{end} missing from {DOC_RELATIVE}"));
    &rest[..to]
}

/// First-cell backticked values from the Indexer metric table.
fn documented_indexer_metrics(doc: &str) -> BTreeSet<String> {
    let table = section(doc, SECTION_START, SECTION_END);
    let mut names = BTreeSet::new();
    for line in table.lines() {
        let line = line.trim();
        if !line.starts_with('|') {
            continue;
        }
        let first_cell = line.split('|').nth(1).unwrap_or("").trim();
        if let Some(inner) = first_cell
            .strip_prefix('`')
            .and_then(|s| s.split('`').next())
        {
            if !inner.is_empty() {
                names.insert(inner.to_string());
            }
        }
    }
    assert!(
        names.len() >= 7,
        "expected at least 7 indexer metrics documented, found {}",
        names.len()
    );
    names
}

/// Metric family names from a Prometheus text exposition.
fn exposed_names(body: &str) -> BTreeSet<String> {
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            line.split(|c: char| c.is_whitespace() || c == '{')
                .next()
                .unwrap_or("")
                .to_string()
        })
        .filter(|name| !name.is_empty())
        .collect()
}

#[test]
fn catalogue_is_complete_and_uniquely_named() {
    let doc = doc_text();
    let names = documented_indexer_metrics(&doc);
    for required in [
        "soroban_indexer_ingestion_lag_ledgers",
        "soroban_indexer_events_ingested_total",
        "soroban_indexer_api_requests_total",
        "soroban_indexer_api_request_duration_seconds",
        "soroban_indexer_cache_hit_ratio",
        "soroban_indexer_rate_limit_rejections_total",
        "soroban_indexer_websocket_connections",
    ] {
        assert!(
            names.contains(required),
            "{required} missing from the indexer catalogue in {DOC_RELATIVE}"
        );
    }
    // BTreeSet deduplicates, so a duplicate row would reduce the count.
    let row_count = section(&doc, SECTION_START, SECTION_END)
        .lines()
        .filter(|line| line.trim_start().starts_with('|'))
        .count();
    assert!(
        row_count >= names.len() + 2,
        "the indexer table has fewer rows than expected (header + separator + names)"
    );
}

#[test]
fn exposed_names_are_parsed_without_labels() {
    let exposition = concat!(
        "# HELP soroban_indexer_api_requests_total API requests.\n",
        "# TYPE soroban_indexer_api_requests_total counter\n",
        "soroban_indexer_api_requests_total{route=\"/v1/tasks/:id\",status=\"200\"} 4\n",
        "soroban_indexer_ingestion_lag_ledgers 12\n",
    );
    let names = exposed_names(exposition);
    assert!(names.contains("soroban_indexer_api_requests_total"));
    assert!(names.contains("soroban_indexer_ingestion_lag_ledgers"));
    assert_eq!(names.len(), 2);
}

#[tokio::test]
async fn scraped_endpoint_matches_catalogue() {
    let Ok(url) = std::env::var("INDEXER_METRICS_URL") else {
        eprintln!("skipping live scrape: set INDEXER_METRICS_URL to check a running indexer");
        return;
    };

    let response = reqwest::get(&url)
        .await
        .unwrap_or_else(|err| panic!("cannot scrape {url}: {err}"));
    assert!(
        response.status().is_success(),
        "scraping {url} returned {}",
        response.status()
    );
    let body = response
        .text()
        .await
        .unwrap_or_else(|err| panic!("cannot read scrape body from {url}: {err}"));

    let exposed = exposed_names(&body);
    let documented = documented_indexer_metrics(&doc_text());

    let undocumented: Vec<_> = exposed.difference(&documented).cloned().collect();
    assert!(
        undocumented.is_empty(),
        "renamed or undocumented metrics exposed: {:?}",
        undocumented
    );

    let missing: Vec<_> = documented.difference(&exposed).cloned().collect();
    assert!(
        missing.is_empty(),
        "documented metrics missing from the endpoint: {:?}",
        missing
    );
}
