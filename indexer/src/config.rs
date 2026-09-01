//! Startup configuration.
//!
//! Every value is validated at startup and reported together, following the
//! discipline the keeper-bot's `requireEnv` established: a misconfigured
//! service fails immediately with the full list of what is wrong, rather than
//! crashing on first use somewhere deep in the ingest loop.

use std::fmt::Write as _;

/// Everything the indexer needs to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Soroban RPC endpoint to poll `getEvents` against.
    pub rpc_url: String,
    /// Contract id to filter events on.
    pub contract_id: String,
    /// sqlx connection string for the event store.
    pub database_url: String,
    /// Ledger to begin backfill from on a fresh database.
    ///
    /// The contract's deployment ledger where it is known; on a network where
    /// it is not, any ledger at or before the `initialize` call.
    pub start_ledger: u32,
    /// Address the HTTP/WebSocket API binds to.
    pub bind_address: String,
    /// Seconds between `getEvents` polls once caught up.
    pub poll_interval_secs: u64,
    /// Ledgers requested per `getEvents` page during backfill.
    pub backfill_page_size: u32,
    /// Requests a single client (by API key, else by IP) may make per second
    /// against the REST API or new WebSocket connections, sustained.
    pub rate_limit_per_second: u32,
    /// Extra requests a client may burst above `rate_limit_per_second`
    /// before being throttled, refilling at that same per-second rate.
    pub rate_limit_burst: u32,
}

/// A configuration value that is missing or unusable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    /// Every problem found, so one restart surfaces all of them.
    pub problems: Vec<String>,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "invalid indexer configuration:")?;
        for problem in &self.problems {
            writeln!(f, "  - {problem}")?;
        }
        let mut hint = String::new();
        let _ = write!(
            hint,
            "set these in the environment or a .env file; see indexer/README.md"
        );
        write!(f, "{hint}")
    }
}

impl std::error::Error for ConfigError {}

/// Default seconds between polls once the indexer is caught up.
const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;
/// Default ledgers per page while backfilling.
const DEFAULT_BACKFILL_PAGE_SIZE: u32 = 200;
/// Default API bind address.
const DEFAULT_BIND_ADDRESS: &str = "127.0.0.1:8080";
/// Default sustained requests per second per client — generous enough for
/// normal dashboard polling and keeper-bot usage, bounded against a single
/// client monopolizing capacity. Tune via `INDEXER_RATE_LIMIT_PER_SECOND`
/// once real usage is observed.
const DEFAULT_RATE_LIMIT_PER_SECOND: u32 = 20;
/// Default burst allowance above the sustained rate.
const DEFAULT_RATE_LIMIT_BURST: u32 = 40;

impl Config {
    /// Read and validate configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_source(|key| std::env::var(key).ok())
    }

    /// Read and validate configuration from an arbitrary source.
    ///
    /// Taking the lookup as a closure keeps this testable without mutating
    /// the process environment, which is global state shared by every test in
    /// the binary.
    pub fn from_source(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let mut problems = Vec::new();

        let mut required = |key: &str| -> String {
            match get(key) {
                Some(v) if !v.trim().is_empty() => v.trim().to_string(),
                Some(_) => {
                    problems.push(format!("{key} is set but empty"));
                    String::new()
                }
                None => {
                    problems.push(format!("{key} is not set"));
                    String::new()
                }
            }
        };

        let rpc_url = required("INDEXER_RPC_URL");
        let contract_id = required("INDEXER_CONTRACT_ID");
        let database_url = required("INDEXER_DATABASE_URL");
        let start_ledger_raw = required("INDEXER_START_LEDGER");

        // `required` has already reported an absent value; only report a
        // second problem here when a present value cannot be parsed.
        let start_ledger = if start_ledger_raw.is_empty() {
            0
        } else {
            match start_ledger_raw.parse::<u32>() {
                Ok(v) => v,
                Err(_) => {
                    problems.push(format!(
                        "INDEXER_START_LEDGER must be a ledger sequence number, got {start_ledger_raw:?}"
                    ));
                    0
                }
            }
        };

        if !(rpc_url.is_empty()
            || rpc_url.starts_with("http://")
            || rpc_url.starts_with("https://"))
        {
            problems.push(format!(
                "INDEXER_RPC_URL must be an http(s) URL, got {rpc_url:?}"
            ));
        }

        let bind_address = optional_string(&get, "INDEXER_BIND_ADDRESS", DEFAULT_BIND_ADDRESS);

        let poll_interval_secs = optional_parsed(
            &get,
            "INDEXER_POLL_INTERVAL_SECS",
            DEFAULT_POLL_INTERVAL_SECS,
            &mut problems,
        );

        let backfill_page_size = optional_parsed(
            &get,
            "INDEXER_BACKFILL_PAGE_SIZE",
            DEFAULT_BACKFILL_PAGE_SIZE,
            &mut problems,
        );

        if backfill_page_size == 0 {
            problems.push("INDEXER_BACKFILL_PAGE_SIZE must be greater than zero".to_string());
        }

        let rate_limit_per_second = optional_parsed(
            &get,
            "INDEXER_RATE_LIMIT_PER_SECOND",
            DEFAULT_RATE_LIMIT_PER_SECOND,
            &mut problems,
        );

        let rate_limit_burst = optional_parsed(
            &get,
            "INDEXER_RATE_LIMIT_BURST",
            DEFAULT_RATE_LIMIT_BURST,
            &mut problems,
        );

        if rate_limit_per_second == 0 {
            problems.push("INDEXER_RATE_LIMIT_PER_SECOND must be greater than zero".to_string());
        }

        if problems.is_empty() {
            Ok(Self {
                rpc_url,
                contract_id,
                database_url,
                start_ledger,
                bind_address,
                poll_interval_secs,
                backfill_page_size,
                rate_limit_per_second,
                rate_limit_burst,
            })
        } else {
            Err(ConfigError { problems })
        }
    }
}

fn optional_string(get: &impl Fn(&str) -> Option<String>, key: &str, default: &str) -> String {
    match get(key) {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}

fn optional_parsed<T: std::str::FromStr + Copy>(
    get: &impl Fn(&str) -> Option<String>,
    key: &str,
    default: T,
    problems: &mut Vec<String>,
) -> T {
    match get(key) {
        Some(v) if !v.trim().is_empty() => match v.trim().parse::<T>() {
            Ok(parsed) => parsed,
            Err(_) => {
                problems.push(format!("{key} must be a number, got {v:?}"));
                default
            }
        },
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn source(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    fn valid_pairs() -> Vec<(&'static str, &'static str)> {
        vec![
            ("INDEXER_RPC_URL", "https://rpc.example.org"),
            ("INDEXER_CONTRACT_ID", "CCONTRACT"),
            ("INDEXER_DATABASE_URL", "sqlite::memory:"),
            ("INDEXER_START_LEDGER", "1000"),
        ]
    }

    #[test]
    fn accepts_a_complete_configuration_and_applies_defaults() {
        let config = Config::from_source(source(&valid_pairs())).expect("valid config");
        assert_eq!(config.start_ledger, 1000);
        assert_eq!(config.bind_address, DEFAULT_BIND_ADDRESS);
        assert_eq!(config.poll_interval_secs, DEFAULT_POLL_INTERVAL_SECS);
        assert_eq!(config.backfill_page_size, DEFAULT_BACKFILL_PAGE_SIZE);
        assert_eq!(config.rate_limit_per_second, DEFAULT_RATE_LIMIT_PER_SECOND);
        assert_eq!(config.rate_limit_burst, DEFAULT_RATE_LIMIT_BURST);
    }

    #[test]
    fn reports_every_missing_value_at_once() {
        let err = Config::from_source(source(&[])).expect_err("nothing is set");
        // All four required keys, not just the first one encountered.
        assert_eq!(err.problems.len(), 4);
        let rendered = err.to_string();
        for key in [
            "INDEXER_RPC_URL",
            "INDEXER_CONTRACT_ID",
            "INDEXER_DATABASE_URL",
            "INDEXER_START_LEDGER",
        ] {
            assert!(rendered.contains(key), "{rendered} should mention {key}");
        }
    }

    #[test]
    fn rejects_an_empty_value_as_loudly_as_a_missing_one() {
        let mut pairs = valid_pairs();
        pairs[1].1 = "   ";
        let err = Config::from_source(source(&pairs)).expect_err("blank contract id");
        assert!(err
            .to_string()
            .contains("INDEXER_CONTRACT_ID is set but empty"));
    }

    #[test]
    fn rejects_an_unparseable_start_ledger_without_double_reporting() {
        let mut pairs = valid_pairs();
        pairs[3].1 = "genesis";
        let err = Config::from_source(source(&pairs)).expect_err("bad start ledger");
        assert_eq!(err.problems.len(), 1);
        assert!(err.problems[0].contains("INDEXER_START_LEDGER"));
    }

    #[test]
    fn rejects_a_non_http_rpc_url() {
        let mut pairs = valid_pairs();
        pairs[0].1 = "ws://rpc.example.org";
        let err = Config::from_source(source(&pairs)).expect_err("non-http rpc url");
        assert!(err.problems[0].contains("INDEXER_RPC_URL"));
    }

    #[test]
    fn rejects_a_zero_backfill_page_size() {
        let mut pairs = valid_pairs();
        pairs.push(("INDEXER_BACKFILL_PAGE_SIZE", "0"));
        let err = Config::from_source(source(&pairs)).expect_err("zero page size");
        assert!(err.problems[0].contains("INDEXER_BACKFILL_PAGE_SIZE"));
    }
}
