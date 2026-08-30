//! Applying decoded events to the database.
//!
//! Split by the audience each group of events serves rather than by contract
//! module: [`keepers`] answers "what has this keeper done". Each module takes
//! the whole event stream and ignores what it does not own, so adding a group
//! does not require the caller to learn a new routing rule.

pub mod keepers;
