//! Fuzzing infrastructure for the Keeper Registry contract.
//!
//! This crate provides fuzz targets and utilities for property-based testing
//! of the keeper-registry contract. It is separate from the main workspace
//! to avoid including libfuzzer-sys in normal builds.
//!
//! # Usage
//!
//! Install cargo-fuzz:
//! ```bash
//! cargo install cargo-fuzz
//! ```
//!
//! Run all fuzz targets:
//! ```bash
//! cd fuzz
//! cargo fuzz build
//! cargo fuzz run smoke
//! cargo fuzz run register_task
//! cargo fuzz run execute_task
//! ```
//!
//! # Architecture
//!
//! - `src/support.rs`: Reusable setup functions and helpers
//! - `fuzz_targets/`: Individual fuzz targets
//! - `corpus/`: Discovered inputs that trigger interesting behavior
//! - `artifacts/`: Crash artifacts for debugging

#![no_std]
#![cfg_attr(feature = "libfuzzer-sys", no_main)]

// Re-export support module for fuzz targets
pub mod support;