//! Test suite for the treasury contract.
//!
//! One module per area of behaviour, mirroring
//! `contracts/keeper-registry/src/test/mod.rs`'s layout.

#![cfg(test)]

mod admin;
mod common;
mod conservation;
mod distribution;
mod recipients;
mod reentrancy;
mod views;
