#![no_std]

//! A typed client for the Reflector price-feed oracle.
//!
//! This crate provides a Soroban contract interface for reading price feeds from the
//! [Reflector oracle network](https://reflector.network/). Reflector is a decentralized
//! oracle protocol that provides on-chain price feeds for Stellar assets and external tokens.
//!
//! # Source of Truth
//!
//! The interface is derived from the deployed Reflector contracts. See:
//! <https://github.com/reflector-network/reflector-contract>
//!
//! # Usage
//!
//! ## Creating a Client
//!
//! ```ignore
//! use keeper_oracle_client::{ReflectorPulseClient, Asset};
//! use soroban_sdk::{Address, Env, Symbol};
//!
//! pub fn fetch_price(env: Env, asset_symbol: &str) -> Option<i128> {
//!     // Reflector contract address on the network
//!     let oracle = Address::from_str(&env, "CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN");
//!     let client = ReflectorPulseClient::new(&env, &oracle);
//!
//!     // Request the price for an asset
//!     let asset = Asset::Other(Symbol::new(&env, asset_symbol));
//!     let price_data = client.lastprice(&asset)?;
//!
//!     // Get decimals for correct scaling
//!     let decimals = client.decimals();
//!     let scaled_price = price_data.price / 10i128.pow(decimals);
//!
//!     Some(scaled_price)
//! }
//! ```
//!
//! ## Checking Staleness
//!
//! Prices include a timestamp so callers can enforce staleness rules:
//!
//! ```ignore
//! use keeper_oracle_client::{ReflectorPulseClient, Asset};
//!
//! pub fn fetch_fresh_price(env: Env, max_age_secs: u64) -> Option<i128> {
//!     let oracle = Address::from_str(&env, "CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN");
//!     let client = ReflectorPulseClient::new(&env, &oracle);
//!
//!     let asset = Asset::Other(Symbol::new(&env, "BTC"));
//!     let price_data = client.lastprice(&asset)?;
//!
//!     let now = env.ledger().timestamp();
//!     if now - price_data.timestamp > max_age_secs {
//!         return None; // Price is too stale
//!     }
//!
//!     Some(price_data.price)
//! }
//! ```

use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol, Vec};

/// A typed client for the Reflector Pulse price-feed oracle.
///
/// Reflector Pulse provides free, uniform 5-minute update intervals for public price feeds.
/// This client wraps the contract interface to provide type-safe access to price data.
///
/// # Source of Truth
///
/// See the deployed contract specifications and interface:
/// <https://github.com/reflector-network/reflector-contract>
///
/// # Staleness
///
/// Prices include a timestamp. It is the caller's responsibility to check the timestamp
/// against the current ledger time and reject stale prices if needed. There is no staleness
/// policy enforced by this client; this remains a decision for the consuming contract.
#[contractclient(name = "ReflectorPulseClient")]
pub trait ReflectorContract {
    /// Returns the base asset in which all prices are quoted (e.g., USD).
    fn base() -> Asset;

    /// Returns the list of all assets available on this oracle.
    fn assets() -> Vec<Asset>;

    /// Returns the number of decimal places used to scale all prices.
    ///
    /// Actual price = reported_price / 10^decimals
    fn decimals() -> u32;

    /// Quotes an asset price at a specific historical timestamp.
    ///
    /// Returns `None` if the timestamp is outside the retention window
    /// or if the asset has no price data.
    fn price(asset: Asset, timestamp: u64) -> Option<PriceData>;

    /// Returns the most recent price record for an asset.
    ///
    /// Returns `None` if the asset has never been quoted on this oracle
    /// or if the asset has expired from the oracle's history.
    fn lastprice(asset: Asset) -> Option<PriceData>;

    /// Returns the last N price records for an asset.
    ///
    /// Returns `None` if the asset has no data.
    fn prices(asset: Asset, records: u32) -> Option<Vec<PriceData>>;

    /// Returns the price feed resolution in seconds (typically 300 for 5-minute intervals).
    fn resolution() -> u32;

    /// Returns the historical data retention period in seconds (typically 86400 for 24 hours).
    ///
    /// Prices older than this period may be removed from contract storage.
    fn history_retention_period() -> Option<u64>;

    /// Returns the timestamp of the most recent price update across all assets.
    fn last_timestamp() -> u64;

    /// Returns the contract version.
    fn version() -> u32;

    /// Returns the contract admin address.
    fn admin() -> Option<Address>;

    /// Extends the TTL (time-to-live) of an asset in the contract's persistent storage.
    ///
    /// Ensures the asset data is not evicted prematurely.
    fn extend_asset_ttl(sponsor: Address, asset: Asset);

    /// Returns the expiration timestamp for an asset's data, or `None` if it has never been set.
    fn expires(asset: Asset) -> Option<u64>;
}

/// A quoted asset on the Reflector oracle.
///
/// Assets can be Stellar contracts (for Soroban or Classic assets) or external symbols
/// (for currencies, forex rates, etc.).
///
/// # Source of Truth
///
/// See: <https://github.com/reflector-network/reflector-contract>
#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum Asset {
    /// A Soroban or Stellar Classic asset identified by its contract address.
    ///
    /// Example: The contract address of a USDC token on Soroban.
    Stellar(Address),

    /// An external asset or currency identified by a symbol string.
    ///
    /// Examples: "BTC", "ETH", "EUR", "XLM"
    Other(Symbol),
}

/// A price record from the Reflector oracle.
///
/// Prices are reported as i128 values scaled by 10^decimals, where `decimals` is
/// obtained from the oracle's `decimals()` method.
///
/// The timestamp is a unix timestamp in seconds. Consuming contracts are responsible
/// for checking this timestamp against the current ledger time to enforce staleness rules.
///
/// # Example Calculation
///
/// If `decimals = 7` and `price = 50_000_000_000` (50 billion):
/// - Actual price = 50_000_000_000 / 10^7 = 5_000 (in the base currency)
///
/// # Source of Truth
///
/// See: <https://github.com/reflector-network/reflector-contract>
#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct PriceData {
    /// Asset price in the base asset, scaled by 10^decimals.
    ///
    /// To obtain the unscaled price, divide by 10^decimals.
    pub price: i128,

    /// Unix timestamp (in seconds) when this price was recorded.
    ///
    /// Consuming contracts should compare this against `env.ledger().timestamp()`
    /// to determine if the price is fresh enough for their use case.
    pub timestamp: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedPrice {
    pub value: u128,
    pub observed_at: u64,
}

/// Reads a fresh positive price and normalizes it to exactly 18 decimals.
/// Any provider, conversion, timestamp, or arithmetic failure returns `None`.
pub fn read_normalized(
    env: &Env,
    oracle: &Address,
    asset: &Asset,
    max_age_seconds: u64,
) -> Option<NormalizedPrice> {
    let client = ReflectorPulseClient::new(env, oracle);
    let decimals = match client.try_decimals() {
        Ok(Ok(value)) if value <= 18 => value,
        _ => return None,
    };
    let data = match client.try_lastprice(asset) {
        Ok(Ok(Some(value))) => value,
        _ => return None,
    };
    if data.price <= 0 {
        return None;
    }

    let now = env.ledger().timestamp();
    if data.timestamp > now || now.checked_sub(data.timestamp)? > max_age_seconds {
        return None;
    }

    let multiplier = 10_u128.checked_pow(18_u32.checked_sub(decimals)?)?;
    let value = (data.price as u128).checked_mul(multiplier)?;
    Some(NormalizedPrice {
        value,
        observed_at: data.timestamp,
    })
}

#[cfg(feature = "testutils")]
pub mod mock;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{contract, contractimpl, Env, Symbol};

    #[test]
    fn test_asset_stellar_equality() {
        let env = Env::default();
        let addr1 = Address::generate(&env);
        let addr2 = Address::generate(&env);

        let asset1 = Asset::Stellar(addr1.clone());
        let asset2 = Asset::Stellar(addr1.clone());
        let asset3 = Asset::Stellar(addr2);

        assert_eq!(asset1, asset2);
        assert_ne!(asset1, asset3);
    }

    #[test]
    fn test_asset_other_equality() {
        let env = Env::default();
        let sym1 = Symbol::new(&env, "BTC");
        let sym2 = Symbol::new(&env, "BTC");
        let sym3 = Symbol::new(&env, "ETH");

        let asset1 = Asset::Other(sym1);
        let asset2 = Asset::Other(sym2);
        let asset3 = Asset::Other(sym3);

        assert_eq!(asset1, asset2);
        assert_ne!(asset1, asset3);
    }

    #[test]
    fn test_price_data_structure() {
        let price = PriceData {
            price: 50_000_000_000i128,
            timestamp: 1_700_000_000u64,
        };

        assert_eq!(price.price, 50_000_000_000i128);
        assert_eq!(price.timestamp, 1_700_000_000u64);
    }

    #[test]
    fn test_price_data_equality() {
        let price1 = PriceData {
            price: 12_345_678i128,
            timestamp: 1_000_000u64,
        };
        let price2 = PriceData {
            price: 12_345_678i128,
            timestamp: 1_000_000u64,
        };
        let price3 = PriceData {
            price: 12_345_679i128,
            timestamp: 1_000_000u64,
        };

        assert_eq!(price1, price2);
        assert_ne!(price1, price3);
    }

    #[test]
    fn test_price_scaling_example() {
        // Example: price_decimals = 7, so actual_price = price / 10^7
        let decimals = 7u32;
        let scaled_price = 50_000_000_000i128; // 5000.00000000 in base currency
        let divisor = 10i128.pow(decimals);
        let actual = scaled_price / divisor;
        assert_eq!(actual, 5_000i128);
    }

    // ============================================================================
    // Mock Reflector Contract for End-to-End Testing
    // ============================================================================

    /// A minimal mock Reflector contract that implements the interface for testing.
    #[contract]
    pub struct MockReflector;

    #[contractimpl]
    impl MockReflector {
        pub fn base() -> Asset {
            Asset::Other(Symbol::new(&Env::default(), "USD"))
        }

        pub fn assets() -> Vec<Asset> {
            let env = Env::default();
            Vec::from_array(
                &env,
                [
                    Asset::Other(Symbol::new(&env, "BTC")),
                    Asset::Other(Symbol::new(&env, "ETH")),
                ],
            )
        }

        pub fn decimals() -> u32 {
            7u32
        }

        pub fn price(_asset: Asset, _timestamp: u64) -> Option<PriceData> {
            // Not tested in this suite, but required by interface
            None
        }

        pub fn lastprice(asset: Asset) -> Option<PriceData> {
            // Return a price for BTC, None for others
            let env = Env::default();
            let btc = Asset::Other(Symbol::new(&env, "BTC"));

            if asset == btc {
                Some(PriceData {
                    price: 50_000_000_000i128, // 5000.00000000 USD at 7 decimals
                    timestamp: 1_700_000_000u64,
                })
            } else {
                None
            }
        }

        pub fn prices(_asset: Asset, _records: u32) -> Option<Vec<PriceData>> {
            // Not tested in this suite
            None
        }

        pub fn resolution() -> u32 {
            300u32 // 5 minutes
        }

        pub fn history_retention_period() -> Option<u64> {
            Some(86400u64) // 24 hours
        }

        pub fn last_timestamp() -> u64 {
            1_700_000_000u64
        }

        pub fn version() -> u32 {
            1u32
        }

        pub fn admin() -> Option<Address> {
            None
        }

        pub fn extend_asset_ttl(_sponsor: Address, _asset: Asset) {
            // No-op for mock
        }

        pub fn expires(_asset: Asset) -> Option<u64> {
            None
        }
    }

    // ============================================================================
    // Integration Tests with Mock Reflector
    // ============================================================================

    #[test]
    fn test_mock_reflector_lastprice_returns_some_for_btc() {
        let env = Env::default();
        let oracle_addr = Address::generate(&env);

        // Register the mock contract
        let oracle_id = env.register_contract(&oracle_addr, MockReflector);

        // Create a client pointing to the mock
        let client = ReflectorPulseClient::new(&env, &oracle_addr);

        // Request BTC price
        let btc = Asset::Other(Symbol::new(&env, "BTC"));
        let price_opt = client.lastprice(&btc);

        // Verify it returns Some with correct values
        assert!(price_opt.is_some());
        let price_data = price_opt.unwrap();
        assert_eq!(price_data.price, 50_000_000_000i128);
        assert_eq!(price_data.timestamp, 1_700_000_000u64);
    }

    #[test]
    fn test_mock_reflector_lastprice_returns_none_for_missing_asset() {
        let env = Env::default();
        let oracle_addr = Address::generate(&env);

        // Register the mock contract
        let _oracle_id = env.register_contract(&oracle_addr, MockReflector);

        // Create a client pointing to the mock
        let client = ReflectorPulseClient::new(&env, &oracle_addr);

        // Request a price for ETH (which the mock doesn't return a price for in this test)
        let eth = Asset::Other(Symbol::new(&env, "ETH"));
        let price_opt = client.lastprice(&eth);

        // Verify it returns None (not a panic, not swallowed)
        assert!(price_opt.is_none());
    }

    #[test]
    fn test_mock_reflector_decimals_returns_precision() {
        let env = Env::default();
        let oracle_addr = Address::generate(&env);

        // Register the mock contract
        let _oracle_id = env.register_contract(&oracle_addr, MockReflector);

        // Create a client pointing to the mock
        let client = ReflectorPulseClient::new(&env, &oracle_addr);

        // Get decimals
        let decimals = client.decimals();

        // Verify it returns the expected precision
        assert_eq!(decimals, 7u32);
    }

    #[test]
    fn test_price_and_timestamp_round_trip() {
        let env = Env::default();
        let oracle_addr = Address::generate(&env);

        // Register the mock contract
        let _oracle_id = env.register_contract(&oracle_addr, MockReflector);

        // Create a client pointing to the mock
        let client = ReflectorPulseClient::new(&env, &oracle_addr);

        // Request BTC price
        let btc = Asset::Other(Symbol::new(&env, "BTC"));
        if let Some(price_data) = client.lastprice(&btc) {
            // Both price and timestamp should be available
            let price = price_data.price;
            let timestamp = price_data.timestamp;

            // Verify we can perform calculations
            let decimals = client.decimals();
            let divisor = 10i128.pow(decimals);
            let unscaled_price = price / divisor;

            // 50_000_000_000 / 10^7 = 5_000
            assert_eq!(unscaled_price, 5_000i128);

            // Verify timestamp is usable
            assert!(timestamp > 0);
        } else {
            panic!("Expected price data for BTC");
        }
    }
}
