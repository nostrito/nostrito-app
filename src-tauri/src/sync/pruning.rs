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
    let hop_map = get_all_hop_distances(graph, own_pubkey, 2);

    // Get tracked pubkeys (never pruned)
    let tracked = db.get_tracked_pubkeys()?;
    let tracked_set: std::collections::HashSet<&str> =
        tracked.iter().map(|s| s.as_str()).collect();

    // Classify pubkeys by tier
    let mut follows_pks = Vec::new();
    let mut fof_pks = Vec::new();

    for (pk, hop) in &hop_map {
        let pk_str = pk.as_ref();
        if pk_str == own_pubkey || tracked_set.contains(pk_str) {
            continue; // Never pruned
        }
        match hop {
            1 => follows_pks.push(pk_str.to_string()),
            2 => fof_pks.push(pk_str.to_string()),
            _ => {} // 0 = own (already skipped)
        }
    }

    // Prune each tier
    stats.follows_pruned = prune_tier(db, &follows_pks, "follows")?;
    stats.fof_pruned = prune_tier(db, &fof_pks, "fof")?;

    // "Others" = event authors NOT in hop_map, NOT own, NOT tracked
    let others_pks = find_others(db, own_pubkey, &hop_map, &tracked_set)?;
    stats.others_pruned = prune_tier(db, &others_pks, "others")?;

    let total = stats.follows_pruned + stats.fof_pruned + stats.others_pruned;
    if total > 0 {
        info!(
            "Pruning: deleted {} events (follows={}, fof={}, others={})",
            total, stats.follows_pruned, stats.fof_pruned, stats.others_pruned
        );
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
    pub others_pruned: u64,
}

impl PruningStats {
    pub fn total(&self) -> u64 {
        self.follows_pruned + self.fof_pruned + self.others_pruned
    }
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
            others_pruned: 30,
        };
        assert_eq!(stats.total(), 60);
    }
}
