//! Moving `i128` across the Postgres boundary.
//!
//! The contract denominates every amount in `i128` token units. Postgres has
//! no 128-bit integer type, and `tokio-postgres` has no built-in mapping for
//! `NUMERIC` without pulling in a decimal crate, so amounts cross the boundary
//! as text and are cast in SQL (`$n::text::numeric`).
//!
//! Text is the right carrier here precisely because it is lossless: the value
//! that comes back out of `NUMERIC(39, 0)` is the same integer that went in,
//! with no intermediate float to round it. Since the derived keeper balance is
//! checked against the contract's own `keeper_balance`, an approximate
//! round-trip would turn a real ingestion bug and a representation artifact
//! into the same symptom.

use crate::IndexerError;

/// Render an `i128` for a `$n::text::numeric` bind parameter.
pub fn i128_to_sql(value: i128) -> String {
    value.to_string()
}

/// Parse a `NUMERIC` column that was selected as `::text`.
///
/// `NUMERIC(39, 0)` has scale 0, so Postgres renders it without a decimal
/// point and this is a plain integer parse. A value that does not parse means
/// the column was not the scale-0 numeric this crate creates, which is a
/// schema mismatch worth surfacing rather than silently coercing.
pub fn i128_from_sql(value: &str) -> Result<i128, IndexerError> {
    value
        .parse::<i128>()
        .map_err(|_| IndexerError::Numeric(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_full_i128_range() {
        for v in [
            0i128,
            1,
            -1,
            i128::MAX,
            i128::MIN,
            12_345_678_901_234_567_890,
        ] {
            assert_eq!(i128_from_sql(&i128_to_sql(v)).unwrap(), v);
        }
    }

    #[test]
    fn rejects_a_non_integer_numeric() {
        assert!(i128_from_sql("1.5").is_err());
        assert!(i128_from_sql("").is_err());
    }
}
