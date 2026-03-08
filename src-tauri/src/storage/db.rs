//! SQLite storage layer stub.
//!
//! Tables:
//! - events: id, pubkey, created_at, kind, tags (JSON), content, sig
//! - wot: pubkey, trust_distance, discovered_at
//! - settings: key-value config store

use anyhow::Result;

/// Initialize the SQLite database and run migrations.
pub fn init_db(_path: &str) -> Result<()> {
    tracing::info!("DB init stub — not yet implemented");
    // TODO:
    // 1. Open/create SQLite file
    // 2. Create tables if not exists
    // 3. Run any pending migrations
    Ok(())
}

/// Store a Nostr event in the database.
pub fn store_event(_event: &crate::NostrEvent) -> Result<()> {
    // TODO: INSERT OR IGNORE into events table
    Ok(())
}

/// Query events matching a filter.
pub fn query_events(_filter: &crate::FeedFilter) -> Result<Vec<crate::NostrEvent>> {
    // TODO: Build SQL from filter, query, map rows
    Ok(vec![])
}
