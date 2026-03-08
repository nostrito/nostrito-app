//! Outbound sync engine stub.
//!
//! Periodically syncs events from configured outbound relays
//! into the local database. Filters by WoT to avoid spam.

use anyhow::Result;

/// Start the sync loop, pulling events from outbound relays.
pub async fn start_sync(_relays: &[String], _interval_secs: u32) -> Result<()> {
    tracing::info!("Sync engine stub — not yet implemented");
    // TODO:
    // 1. Connect to each outbound relay
    // 2. Subscribe with filters (authors = WoT pubkeys)
    // 3. Store received events in DB
    // 4. Re-run on interval
    Ok(())
}

/// Stop the sync loop.
pub async fn stop_sync() -> Result<()> {
    tracing::info!("Stopping sync stub");
    Ok(())
}
