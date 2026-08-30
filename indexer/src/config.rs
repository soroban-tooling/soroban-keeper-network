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
        if !rpc_url.starts_with("https://") && !rpc_url.starts_with("http://localhost") {
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
    }
}
