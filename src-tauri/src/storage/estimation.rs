use anyhow::Result;
use std::sync::Arc;
use tracing::debug;

use crate::storage::db::Database;
use crate::wot::WotGraph;

/// Average event sizes (bytes) for estimation.
const AVG_EVENT_BYTES: u64 = 450; // weighted average across kinds
/// SQLite overhead factor.
const SQLITE_OVERHEAD: f64 = 1.15;

/// Storage estimation result.
#[derive(Debug, Clone)]
pub struct StorageEstimate {
    pub follows_count: u32,
    pub fof_estimate: u32,
    pub events_per_day: f64,
    pub bytes_per_day: f64,
    pub projected_30d_bytes: f64,
    pub current_db_size: u64,
}

/// Estimate storage growth based on current data patterns.
///
/// Uses the WoT graph to count follows, and the last 24h event rate
/// from the database to project future growth.
pub fn estimate_storage(
    db: &Arc<Database>,
    graph: &Arc<WotGraph>,
    own_pubkey: &str,
) -> Result<StorageEstimate> {
    // Count direct follows from WoT graph
    let follows_count = graph.get_follows(own_pubkey)
        .map(|f| f.len() as u32)
        .unwrap_or(0);

    // Estimate FoF count (rough: follows * avg_follows * dedup_factor)
    let fof_estimate = (follows_count as f64 * 150.0 * 0.3) as u32;

    // Get actual event rate from last 24h
    let events_24h = db.events_last_24h()? as f64;
    let events_per_day = events_24h;

    // Bytes per day = events * avg_size * overhead
    let bytes_per_day = events_per_day * AVG_EVENT_BYTES as f64 * SQLITE_OVERHEAD;

    // 30-day projection
    let projected_30d_bytes = bytes_per_day * 30.0;

    // Current DB size
    let current_db_size = db.db_size_bytes()?;

    let estimate = StorageEstimate {
        follows_count,
        fof_estimate,
        events_per_day,
        bytes_per_day,
        projected_30d_bytes,
        current_db_size,
    };

    debug!(
        "[storage-estimate] follows={} fof=~{} events/day=~{:.0} bytes/day=~{} projected_30d=~{} actual_db={}",
        estimate.follows_count,
        estimate.fof_estimate,
        estimate.events_per_day,
        format_bytes(estimate.bytes_per_day as u64),
        format_bytes(estimate.projected_30d_bytes as u64),
        format_bytes(estimate.current_db_size),
    );

    Ok(estimate)
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{}B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1}GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}
