use anyhow::Result;
use std::sync::Arc;
use tracing::{debug, info};

use crate::storage::db::Database;
use crate::wot::bfs::get_all_hop_distances;
use crate::wot::WotGraph;

/// Run tiered pruning based on WoT hop distances.
///
/// 1. Compute hop distances from own pubkey
/// 2. Classify all event authors into retention tiers
/// 3. Delete events exceeding tier limits (preserving metadata kinds)
pub fn run_pruning(
    db: &Arc<Database>,
    graph: &Arc<WotGraph>,
    own_pubkey: &str,
) -> Result<PruningStats> {
    let mut stats = PruningStats::default();

    // Compute hop distances (O(V+E) BFS)
    let hop_map = get_all_hop_distances(graph, own_pubkey, 3);

    // Get tracked pubkeys (never pruned)
    let tracked = db.get_tracked_pubkeys()?;
    let tracked_set: std::collections::HashSet<&str> =
        tracked.iter().map(|s| s.as_str()).collect();

    // Classify pubkeys by tier
    let mut follows_pks = Vec::new();
    let mut fof_pks = Vec::new();
    let mut hop3_pks = Vec::new();

    for (pk, hop) in &hop_map {
        let pk_str = pk.as_ref();
        if pk_str == own_pubkey || tracked_set.contains(pk_str) {
            continue; // Never pruned
        }
        match hop {
            1 => follows_pks.push(pk_str.to_string()),
            2 => fof_pks.push(pk_str.to_string()),
            3 => hop3_pks.push(pk_str.to_string()),
            _ => {} // 0 = own (already skipped)
        }
    }

    // Prune each tier
    stats.follows_pruned = prune_tier(db, &follows_pks, "follows")?;
    stats.fof_pruned = prune_tier(db, &fof_pks, "fof")?;
    stats.hop3_pruned = prune_tier(db, &hop3_pks, "hop3")?;

    // "Others" = event authors NOT in hop_map, NOT own, NOT tracked
    let others_pks = find_others(db, own_pubkey, &hop_map, &tracked_set)?;
    stats.others_pruned = prune_tier(db, &others_pks, "others")?;

    let total = stats.follows_pruned + stats.fof_pruned + stats.hop3_pruned + stats.others_pruned;
    if total > 0 {
        info!(
            "Pruning: deleted {} events (follows={}, fof={}, hop3={}, others={})",
            total, stats.follows_pruned, stats.fof_pruned, stats.hop3_pruned, stats.others_pruned
        );
    }

    // Clean up stale enrichment_cache entries (older than 24 hours)
    match db.cleanup_old_enrichment(86400) {
        Ok(cleaned) if cleaned > 0 => {
            debug!("Pruning: cleaned {} stale enrichment_cache entries", cleaned);
        }
        Err(e) => {
            debug!("Pruning: enrichment cleanup error: {}", e);
        }
        _ => {}
    }

    Ok(stats)
}

/// Prune events for a list of pubkeys using the tier's retention config.
fn prune_tier(
    db: &Database,
    pubkeys: &[String],
    tier: &str,
) -> Result<u64> {
    if pubkeys.is_empty() {
        return Ok(0);
    }

    let (min_events, time_window_secs) = match db.get_retention_config(tier)? {
        Some(config) => config,
        None => return Ok(0), // No config for this tier
    };

    let now = chrono::Utc::now().timestamp();
    let cutoff = now - time_window_secs as i64;

    let mut total_deleted = 0u64;

    for pubkey in pubkeys {
        match db.prune_pubkey_events(pubkey, cutoff, min_events) {
            Ok(deleted) => {
                total_deleted += deleted;
                if deleted > 0 {
                    debug!("Pruned {} events from {} (tier={})", deleted, &pubkey[..8.min(pubkey.len())], tier);
                }
            }
            Err(e) => {
                debug!("Prune error for {}: {}", &pubkey[..8.min(pubkey.len())], e);
            }
        }
    }

    Ok(total_deleted)
}

/// Find "others" — event authors not in the WoT hop map, not own, not tracked.
fn find_others(
    db: &Database,
    own_pubkey: &str,
    hop_map: &std::collections::HashMap<Arc<str>, u8>,
    tracked: &std::collections::HashSet<&str>,
) -> Result<Vec<String>> {
    use std::sync::Arc;

    // Get all distinct pubkeys from the events table
    // We'll query for pubkeys that have events but aren't in hop_map
    let all_cursors = db.get_all_cursors()?;

    let others: Vec<String> = all_cursors
        .iter()
        .filter(|(pk, _, _)| {
            pk != own_pubkey
                && !tracked.contains(pk.as_str())
                && !hop_map.contains_key(&Arc::from(pk.as_str()))
        })
        .map(|(pk, _, _)| pk.clone())
        .collect();

    Ok(others)
}

#[derive(Debug, Default)]
pub struct PruningStats {
    pub follows_pruned: u64,
    pub fof_pruned: u64,
    pub hop3_pruned: u64,
    pub others_pruned: u64,
}

impl PruningStats {
    pub fn total(&self) -> u64 {
        self.follows_pruned + self.fof_pruned + self.hop3_pruned + self.others_pruned
    }
}

/// Size-based pruning: if the DB exceeds `max_bytes`, aggressively prune
/// starting from the lowest-priority tier (Others) and working upward.
/// Never touches Follows, Tracked, or Own data.
pub fn prune_to_size_limit(
    db: &Arc<Database>,
    graph: &Arc<WotGraph>,
    own_pubkey: &str,
    max_bytes: u64,
) -> Result<u64> {
    let current_size = db.db_size_bytes()?;
    if current_size <= max_bytes {
        return Ok(0);
    }

    info!(
        "[size-prune] DB size {} exceeds limit {}, starting aggressive pruning",
        current_size, max_bytes
    );

    let hop_map = get_all_hop_distances(graph, own_pubkey, 3);
    let tracked = db.get_tracked_pubkeys()?;
    let tracked_set: std::collections::HashSet<&str> =
        tracked.iter().map(|s| s.as_str()).collect();

    let mut total_deleted = 0u64;

    // Tier priority: Others first, then Hop3, then FoF
    let tiers_to_prune = [
        ("others", None), // None = find_others
        ("hop3", Some(3u8)),
        ("fof", Some(2u8)),
    ];

    for (tier_name, hop_value) in &tiers_to_prune {
        let pubkeys: Vec<String> = if let Some(hop) = hop_value {
            hop_map.iter()
                .filter(|(pk, h)| {
                    **h == *hop
                        && pk.as_ref() != own_pubkey
                        && !tracked_set.contains(pk.as_ref())
                })
                .map(|(pk, _)| pk.to_string())
                .collect()
        } else {
            find_others(db, own_pubkey, &hop_map, &tracked_set)?
        };

        if pubkeys.is_empty() {
            continue;
        }

        // Use half the normal retention for aggressive pruning
        if let Some((min_events, time_window_secs)) = db.get_retention_config(tier_name)? {
            let aggressive_min = (min_events / 2).max(1);
            let aggressive_window = time_window_secs / 2;
            let cutoff = chrono::Utc::now().timestamp() - aggressive_window as i64;

            for pubkey in &pubkeys {
                match db.prune_pubkey_events(pubkey, cutoff, aggressive_min) {
                    Ok(deleted) => total_deleted += deleted,
                    Err(e) => debug!("Size-prune error for {}: {}", &pubkey[..8.min(pubkey.len())], e),
                }
            }
        }

        // Check if we're under the limit now
        let new_size = db.db_size_bytes()?;
        info!(
            "[size-prune] After {} tier: deleted {} events, DB size now {}",
            tier_name, total_deleted, new_size
        );
        if new_size <= max_bytes {
            break;
        }
    }

    Ok(total_deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pruning_stats_default() {
        let stats = PruningStats::default();
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn test_pruning_stats_total() {
        let stats = PruningStats {
            follows_pruned: 10,
            fof_pruned: 20,
            hop3_pruned: 5,
            others_pruned: 30,
        };
        assert_eq!(stats.total(), 65);
    }
}
