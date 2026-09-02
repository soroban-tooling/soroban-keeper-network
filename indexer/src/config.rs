//! Startup configuration, validated before anything connects anywhere.
//!
//! Follows the discipline the keeper bot's `requireEnv` established
//! (`examples/keeper-bot/index.js`): every variable is read once at startup,
//! parsed and validated with a specific failure message, and the process
//! refuses to boot on the first invalid value — a misconfigured indexer must
//! fail at launch with a message naming the variable and the reason, never
//! crash minutes later on first use. Secret-bearing values (the database URL
//! carries a password) are never echoed back in a failure message, matching
//! `requireEnv`'s `secret` flag.

use std::fmt;

/// Everything the service needs, fully validated.
#[derive(Debug, Clone)]
pub struct Config {
    /// Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`.
    pub rpc_url: String,
    /// The keeper-registry contract to filter events on (`C…`, 56 chars).
    pub contract_id: String,
    /// Postgres connection string. Redacted from every error message.
    pub database_url: String,
    /// Ledger to start scanning from on a fresh database — the contract's
    /// deployment ledger; there is nothing to index before it existed.
    pub start_ledger: u32,
    /// Sleep between poll rounds once caught up, in milliseconds.
    pub poll_interval_ms: u64,
}

/// A single named, specific configuration failure.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError {
    pub name: &'static str,
    /// The offending value — `None` when the variable is secret-bearing.
    pub value: Option<String>,
    pub reason: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.value {
            Some(v) => write!(f, "Invalid {}: {} — {}", self.name, v, self.reason),
            None => write!(f, "Invalid {} — {}", self.name, self.reason),
        }
    }
}

fn require(name: &'static str, secret: bool) -> Result<String, ConfigError> {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err(ConfigError {
            name,
            value: None,
            reason: "must be set".into(),
        }),
    }
    .map_err(|mut e| {
        // Nothing to redact on a missing value, but keep the shape uniform.
        if secret {
            e.value = None;
        }
        e
    })
}

fn optional(name: &'static str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Loose strkey shape check for a contract id: `C` + 55 base32 chars. The RPC
/// rejects a well-shaped-but-nonexistent id loudly at the first request, so
/// full checksum validation here would only duplicate that failure later.
fn is_contract_id(s: &str) -> bool {
    s.len() == 56
        && s.starts_with('C')
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
}

impl Config {
    /// Read and validate every variable, reporting the FIRST failure with a
    /// message specific enough to fix without reading source code.
    pub fn from_env() -> Result<Config, ConfigError> {
        let rpc_url = require("INDEXER_RPC_URL", false)?;
        // Plain http is a local-dev convenience only, and the check is on the
        // HOST, not a prefix — "http://localhost.evil.example" is not local.
        let local_http = ["http://localhost:", "http://127.0.0.1:", "http://[::1]:"]
            .iter()
            .any(|p| rpc_url.starts_with(p))
            || rpc_url == "http://localhost";
        if !rpc_url.starts_with("https://") && !local_http {
            return Err(ConfigError {
                name: "INDEXER_RPC_URL",
                value: Some(rpc_url),
                reason: "must be an https:// URL (http:// is allowed for localhost only)".into(),
            });
        }

        let contract_id = require("INDEXER_CONTRACT_ID", false)?;
        if !is_contract_id(&contract_id) {
            return Err(ConfigError {
                name: "INDEXER_CONTRACT_ID",
                value: Some(contract_id),
                reason: "must be a C… contract strkey (56 base32 chars)".into(),
            });
        }

        let database_url = require("DATABASE_URL", true)?;
        if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
            return Err(ConfigError {
                name: "DATABASE_URL",
                value: None, // secret-bearing: never echoed
                reason: "must be a postgres:// connection string".into(),
            });
        }

        let start_ledger = match require("INDEXER_START_LEDGER", false)?.parse::<u32>() {
            Ok(n) if n >= 1 => n,
            other => {
                return Err(ConfigError {
                    name: "INDEXER_START_LEDGER",
                    value: optional("INDEXER_START_LEDGER"),
                    reason: match other {
                        Ok(_) => "must be >= 1".into(),
                        Err(e) => format!("must be a ledger sequence number ({e})"),
                    },
                })
            }
        };

        let poll_interval_ms = match optional("INDEXER_POLL_INTERVAL_MS") {
            None => 10_000,
            Some(raw) => match raw.parse::<u64>() {
                Ok(n) if n >= 1_000 => n,
                Ok(_) => {
                    return Err(ConfigError {
                        name: "INDEXER_POLL_INTERVAL_MS",
                        value: Some(raw),
                        reason: "must be at least 1000 (milliseconds)".into(),
                    })
                }
                Err(e) => {
                    return Err(ConfigError {
                        name: "INDEXER_POLL_INTERVAL_MS",
                        value: Some(raw),
                        reason: format!("must be an integer number of milliseconds ({e})"),
                    })
                }
            },
        };

        Ok(Config {
            rpc_url,
            contract_id,
            database_url,
            start_ledger,
            poll_interval_ms,
        })
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

    // Env-var tests mutate PROCESS-WIDE state while the test harness runs
    // threads in parallel, so every test takes one global lock for its whole
    // set-run-clean cycle. A poisoned lock (a failed test) must not cascade.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_env(vars: &[(&str, &str)], f: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        const ALL: &[&str] = &[
            "INDEXER_RPC_URL",
            "INDEXER_CONTRACT_ID",
            "DATABASE_URL",
            "INDEXER_START_LEDGER",
            "INDEXER_POLL_INTERVAL_MS",
        ];
        for k in ALL {
            std::env::remove_var(k);
        }
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
        f();
        for k in ALL {
            std::env::remove_var(k);
        }
    }

    const VALID: &[(&str, &str)] = &[
        ("INDEXER_RPC_URL", "https://soroban-testnet.stellar.org"),
        (
            "INDEXER_CONTRACT_ID",
            "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        ),
        ("DATABASE_URL", "postgres://user:hunter2@localhost/keeper"),
        ("INDEXER_START_LEDGER", "1000"),
    ];

    #[test]
    fn valid_config_loads_with_defaults() {
        with_env(VALID, || {
            let c = Config::from_env().expect("valid config");
            assert_eq!(c.poll_interval_ms, 10_000);
            assert_eq!(c.start_ledger, 1000);
        });
    }

    #[test]
    fn missing_variable_names_itself() {
        with_env(&VALID[..3], || {
            let e = Config::from_env().unwrap_err();
            assert_eq!(e.name, "INDEXER_START_LEDGER");
            assert_eq!(e.reason, "must be set");
        });
    }

    #[test]
    fn malformed_contract_id_is_specific_and_echoed() {
        let mut vars = VALID.to_vec();
        vars[1] = ("INDEXER_CONTRACT_ID", "GNOTACONTRACT");
        with_env(&vars, || {
            let e = Config::from_env().unwrap_err();
            assert_eq!(e.name, "INDEXER_CONTRACT_ID");
            assert_eq!(e.value.as_deref(), Some("GNOTACONTRACT"));
            assert!(e.reason.contains("strkey"));
        });
    }

    #[test]
    fn database_url_is_never_echoed() {
        let mut vars = VALID.to_vec();
        vars[2] = ("DATABASE_URL", "mysql://user:supersecret@host/db");
        with_env(&vars, || {
            let e = Config::from_env().unwrap_err();
            assert_eq!(e.name, "DATABASE_URL");
            assert_eq!(e.value, None, "secret-bearing value must be redacted");
            let rendered = e.to_string();
            assert!(!rendered.contains("supersecret"));
        });
    }

    #[test]
    fn poll_interval_floor_is_enforced() {
        let mut vars = VALID.to_vec();
        vars.push(("INDEXER_POLL_INTERVAL_MS", "50"));
        with_env(&vars, || {
            let e = Config::from_env().unwrap_err();
            assert_eq!(e.name, "INDEXER_POLL_INTERVAL_MS");
            assert!(e.reason.contains("1000"));
        });
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
