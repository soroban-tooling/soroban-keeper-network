//! Writes `indexer/openapi.yaml` from the live API types.
//!
//! The document is generated rather than hand-maintained, so it cannot
//! describe a shape the handlers no longer return. `openapi_is_current`
//! in the API module fails if the committed file falls behind, which is what
//! makes regenerating it a required step rather than a remembered one.
//!
//! ```bash
//! cargo run -p keeper-indexer --bin generate-openapi
//! ```

use anyhow::{Context, Result};
use keeper_indexer::api::openapi_yaml;

fn main() -> Result<()> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/openapi.yaml");
    let yaml = openapi_yaml().context("rendering the OpenAPI document")?;
    std::fs::write(path, yaml).with_context(|| format!("writing {path}"))?;
    println!("wrote {path}");
    Ok(())
}
