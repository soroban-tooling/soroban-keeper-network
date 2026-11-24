//! Mechanical coverage check for `docs/ACCESS_CONTROL.md` (issue #735).
//!
//! The document claims to cover *every* public entry point of both production
//! contracts. A hand-maintained claim like that rots the moment someone adds
//! an entry point and forgets the doc. This test closes that gap: it parses the
//! `#[contractimpl]` blocks of the production source at compile time (via
//! `include_str!`), extracts every `pub fn` name, and asserts a one-to-one
//! match with the rows in the corresponding matrix section.
//!
//! `include_str!` is deliberate over `std::fs`: editing a source file
//! recompiles this test, so adding an entry point always re-runs the check.
//! Using the filesystem at runtime would let a stale build mask a new
//! function. Only `#[contractimpl]` blocks are parsed — helper `pub fn`s such
//! as `split_reward` and the test-only reentrant mocks are not ABI entry
//! points and are documented as such in the doc's appendix.

extern crate std;

use std::{
    collections::BTreeSet,
    string::{String, ToString},
    vec::Vec,
};

const REGISTRY_SOURCES: &[&str] = &[
    include_str!("../admin.rs"),
    include_str!("../batch.rs"),
    include_str!("../reputation.rs"),
    include_str!("../staking.rs"),
    include_str!("../task.rs"),
    include_str!("../views.rs"),
];

const TREASURY_SOURCES: &[&str] = &[
    include_str!("../../../treasury/src/admin.rs"),
    include_str!("../../../treasury/src/distribution.rs"),
    include_str!("../../../treasury/src/views.rs"),
];

const MATRIX: &str = include_str!("../../../../docs/ACCESS_CONTROL.md");

/// Names of the `pub fn`s inside every `#[contractimpl] impl ... { ... }`
/// block in `sources`. All these impls are module-level, so the block closes
/// at a `}` in column zero — which is what terminates the scan.
fn entry_points(sources: &[&str]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for source in sources {
        let mut saw_contract_impl = false;
        let mut in_impl = false;
        for line in source.lines() {
            let trimmed = line.trim();
            if trimmed == "#[contractimpl]" {
                saw_contract_impl = true;
                continue;
            }
            if saw_contract_impl && trimmed.starts_with("impl ") {
                in_impl = true;
                saw_contract_impl = false;
                continue;
            }
            if !in_impl {
                continue;
            }
            if line == "}" {
                in_impl = false;
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("pub fn ") {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    found.insert(name);
                }
            }
        }
    }
    found
}

/// Entry-point names documented as rows in one matrix section. Rows begin
/// with `| \`name\` |`; prose, headers and other backticked text are ignored.
fn documented(section: &str) -> BTreeSet<String> {
    section
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("| `")?;
            let name = rest.split('`').next()?;
            (!name.is_empty()).then(|| name.to_string())
        })
        .collect()
}

fn matrix_section(start: &str, end: &str) -> &'static str {
    let from = MATRIX
        .find(start)
        .expect("matrix start marker present")
        + start.len();
    let to = from
        + MATRIX[from..]
            .find(end)
            .expect("matrix end marker present");
    &MATRIX[from..to]
}

fn assert_complete(label: &str, sources: &[&str], section: &str) {
    let actual = entry_points(sources);
    let documented = documented(section);

    assert!(!actual.is_empty(), "{label} source parse found no entry points");
    assert!(
        !documented.is_empty(),
        "{label} matrix section has no rows — markers may have moved"
    );

    let missing: Vec<_> = actual.difference(&documented).collect();
    assert!(
        missing.is_empty(),
        "{label} entry points missing from docs/ACCESS_CONTROL.md: {missing:?}. \
         Add a row to the corresponding matrix."
    );

    let stale: Vec<_> = documented.difference(&actual).collect();
    assert!(
        stale.is_empty(),
        "docs/ACCESS_CONTROL.md documents {label} entry points that no longer exist: {stale:?}. \
         Remove the row or rename it to the current ABI name."
    );

    // A duplicate row would make BTreeSet look complete while the document
    // still has two contradictory rows for one name.
    let row_count = section
        .lines()
        .filter(|line| line.trim().starts_with("| `"))
        .count();
    assert_eq!(
        row_count,
        documented.len(),
        "{label} matrix contains duplicate entry-point rows"
    );
}

#[test]
fn every_registry_entry_point_has_an_access_control_row() {
    assert_complete(
        "registry",
        REGISTRY_SOURCES,
        matrix_section(
            "<!-- BEGIN REGISTRY MATRIX -->",
            "<!-- END REGISTRY MATRIX -->"
        ),
    );
}

#[test]
fn every_treasury_entry_point_has_an_access_control_row() {
    assert_complete(
        "treasury",
        TREASURY_SOURCES,
        matrix_section(
            "<!-- BEGIN TREASURY MATRIX -->",
            "<!-- END TREASURY MATRIX -->"
        ),
    );
}
