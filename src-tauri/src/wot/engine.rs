//! Web of Trust BFS engine stub.
//!
//! Builds a trust graph by crawling kind:3 (contact list) events
//! from a root pubkey outward, up to a configurable max depth.

use anyhow::Result;

/// Crawl the WoT graph starting from root, up to max_depth hops.
pub async fn crawl_wot(_root_pubkey: &str, _max_depth: u32) -> Result<()> {
    tracing::info!("WoT crawl stub — not yet implemented");
    // TODO:
    // 1. Fetch kind:3 for root pubkey from outbound relays
    // 2. Extract followed pubkeys from tags
    // 3. BFS to next depth level
    // 4. Store trust distances in DB
    Ok(())
}

/// Check if a pubkey is within the WoT at any depth.
pub fn is_trusted(_pubkey: &str) -> bool {
    // TODO: Query DB for trust distance
    false
}
