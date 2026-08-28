//! Test suite for the keeper registry.
//!
//! One module per area of behaviour, mirroring the source layout, so two
//! contributors adding tests in different areas edit different files.

#![cfg(test)]

mod admin;
mod batch;
mod batch_reads;
mod cancel;
mod claim;
mod common;
mod events;
mod expire;
mod fee_accrual;
mod integration;
mod not_initialized;
mod perf;
mod placeholders;
mod property;
mod register;
mod resource_report;
mod reward_split;
mod ttl;
mod withdraw;
