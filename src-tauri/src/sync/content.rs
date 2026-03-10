use anyhow::Result;
use nostr_sdk::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::storage::db::Database;
use crate::wot::WotGraph;

use super::pool::RelayPool;
use super::processing;
use super::scheduler;
use super::types::{CursorBand, EventSource, BATCH_PAUSE_SECS, CURSOR_OVERLAP_SECS};

/// Phase 3: Content Fetch — relay-centric batched event retrieval.
pub struct ContentFetch {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    pool: Arc<RelayPool>,
    own_pubkey: String,
    lookback_days: u32,
}

impl ContentFetch {
    pub fn new(
        db: Arc<Database>,
        graph: Arc<WotGraph>,
        pool: Arc<RelayPool>,
        own_pubkey: String,
        lookback_days: u32,
    ) -> Self {
        Self { db, graph, pool, own_pubkey, lookback_days }
    }

    /// Run the full content fetch phase.
    pub async fn run(
        &self,
        pubkeys_needing_relay_refresh: &[String],
    ) -> Result<ContentStats> {
        let mut stats = ContentStats::default();

        // Step 3.0: Build routing plan
        let follows = self.graph.get_follows(&self.own_pubkey).unwrap_or_default();
        let tracked = self.db.get_tracked_pubkeys()?;
        let all_pubkeys: Vec<String> = follows
            .iter()
            .chain(tracked.iter())
            .cloned()
            .collect();

        if all_pubkeys.is_empty() {
            return Ok(stats);
        }

        // Build pubkey -> [(relay_url, reliability)] map
        let mut pubkey_relays: HashMap<String, Vec<(String, f64)>> = HashMap::new();
        let mut fallback_pubkeys: Vec<String> = Vec::new();

        for pubkey in &all_pubkeys {
            let write_relays = self.db.get_write_relays(pubkey)?;
            if write_relays.is_empty() {
                fallback_pubkeys.push(pubkey.clone());
                continue;
            }
            let mut relay_scores = Vec::new();
            for (relay_url, _source) in &write_relays {
                let score = self.db.get_relay_reliability(relay_url).unwrap_or(0.5);
                relay_scores.push((relay_url.clone(), score));
            }
            pubkey_relays.insert(pubkey.clone(), relay_scores);
        }

        // Get muted users for exclusion
        let muted: Vec<String> = all_pubkeys
            .iter()
            .filter(|pk| self.db.is_pubkey_muted(pk).unwrap_or(false))
            .cloned()
            .collect();

        let plan = scheduler::build_routing_plan(&pubkey_relays, &muted);
        stats.relays_queried = plan.routes.len() as u32;

        // Step 3.1: Get cursor data for banding
        let cursors = self.db.get_all_cursors()?;
        let now = chrono::Utc::now().timestamp();
        let bands = scheduler::group_by_cursor_band(&cursors, now);

        let refresh_set: std::collections::HashSet<&str> =
            pubkeys_needing_relay_refresh.iter().map(|s| s.as_str()).collect();

        // Step 3.2: Execute relay-by-relay
        for route in &plan.routes {
            let route_stats = self.fetch_from_relay(
                &route.relay_url,
                &route.pubkeys,
                &bands,
                &refresh_set,
                now,
            ).await;

            stats.events_stored += route_stats.0;
            stats.wot_updates += route_stats.1;

            // Polite pause between relays
            tokio::time::sleep(std::time::Duration::from_secs(BATCH_PAUSE_SECS)).await;
        }

        // Step 3.3: Fallback fetch for pubkeys with no known relays
        if !fallback_pubkeys.is_empty() {
            debug!("Content: fallback fetch for {} pubkeys with no relay info", fallback_pubkeys.len());
            // Use configured relays for fallback
            // (this will be wired to the user's configured relay list in the orchestrator)
        }

        info!(
            "Content fetch: {} events stored, {} WoT updates across {} relays",
            stats.events_stored, stats.wot_updates, stats.relays_queried
        );

        Ok(stats)
    }

    /// Fetch events from a single relay for a set of pubkeys.
    async fn fetch_from_relay(
        &self,
        relay_url: &str,
        pubkeys: &[String],
        bands: &HashMap<CursorBand, Vec<String>>,
        refresh_set: &std::collections::HashSet<&str>,
        now: i64,
    ) -> (u32, u32) {
        let mut filters = Vec::new();

        // Build per-band content filters
        for band in [CursorBand::Hot, CursorBand::Warm, CursorBand::Cold] {
            let band_pubkeys: Vec<&String> = pubkeys
                .iter()
                .filter(|pk| {
                    bands
                        .get(&band)
                        .map(|v| v.contains(pk))
                        .unwrap_or(band == CursorBand::Cold) // Default to Cold if no cursor
                })
                .collect();

            if band_pubkeys.is_empty() {
                continue;
            }

            let authors: Vec<PublicKey> = band_pubkeys
                .iter()
                .filter_map(|pk| PublicKey::from_hex(pk.as_str()).ok())
                .collect();

            if authors.is_empty() {
                continue;
            }

            let since = self.compute_since(band, &band_pubkeys, now);

            let content_filter = Filter::new()
                .authors(authors)
                .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
                .since(Timestamp::from(since as u64))
                .limit(200);

            filters.push(content_filter);
        }

        // Metadata filter for pubkeys needing relay refresh
        let meta_pubkeys: Vec<PublicKey> = pubkeys
            .iter()
            .filter(|pk| refresh_set.contains(pk.as_str()))
            .filter_map(|pk| PublicKey::from_hex(pk).ok())
            .collect();

        if !meta_pubkeys.is_empty() {
            let meta_filter = Filter::new()
                .authors(meta_pubkeys)
                .kinds(vec![Kind::Metadata, Kind::ContactList, Kind::RelayList])
                .limit(100);
            filters.push(meta_filter);
        }

        if filters.is_empty() {
            return (0, 0);
        }

        match self.pool.subscribe_and_collect(
            &[relay_url.to_string()],
            filters,
            30,
        ).await {
            Ok(events) => {
                let start = std::time::Instant::now();
                let (stored, wot) = processing::process_events(
                    &events,
                    &self.db,
                    &self.graph,
                    &self.own_pubkey,
                    EventSource::Sync,
                );

                // Update relay stats
                let latency = start.elapsed().as_millis() as u32;
                self.db.record_relay_success(relay_url, stored, latency).ok();

                // Inline thread scan: find e-tag references to events we don't have
                let mut missing_refs: Vec<String> = Vec::new();
                let mut seen_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
                for event in &events {
                    for tag in event.tags.iter() {
                        let slice = tag.as_slice();
                        if slice.len() >= 2 && slice[0] == "e" {
                            let ref_id = slice[1].to_string();
                            if seen_refs.insert(ref_id.clone()) {
                                let exists = self.db.query_events(
                                    Some(&[ref_id.clone()]), None, None, None, None, 1,
                                ).map(|r| !r.is_empty()).unwrap_or(false);
                                if !exists {
                                    missing_refs.push(ref_id);
                                }
                            }
                        }
                    }
                }

                // Fetch missing thread context from the same relay
                let mut thread_stored = 0u32;
                if !missing_refs.is_empty() {
                    let ids: Vec<EventId> = missing_refs.iter()
                        .filter_map(|id| EventId::from_hex(id).ok())
                        .take(100)
                        .collect();
                    if !ids.is_empty() {
                        let thread_filter = Filter::new().ids(ids.clone()).limit(ids.len());
                        if let Ok(thread_events) = self.pool.subscribe_and_collect(
                            &[relay_url.to_string()], vec![thread_filter], 10,
                        ).await {
                            let (ts, _) = processing::process_events(
                                &thread_events, &self.db, &self.graph, &self.own_pubkey, EventSource::ThreadContext,
                            );
                            thread_stored = ts;
                            if ts > 0 {
                                debug!("Content: inline thread fetch from {} → {} events", relay_url, ts);
                            }
                        }
                    }
                }

                debug!(
                    "Content: {} → {} events, {} stored, {} WoT, {} thread",
                    relay_url, events.len(), stored, wot, thread_stored
                );

                (stored + thread_stored, wot)
            }
            Err(e) => {
                warn!("Content: fetch from {} failed: {}", relay_url, e);
                self.db.record_relay_failure(relay_url).ok();
                (0, 0)
            }
        }
    }

    /// Compute the `since` timestamp for a cursor band.
    fn compute_since(&self, band: CursorBand, pubkeys: &[&String], now: i64) -> i64 {
        match band {
            CursorBand::Hot | CursorBand::Warm => {
                // Use the oldest cursor in the band, with overlap
                let mut oldest_cursor = now;
                for pk in pubkeys {
                    if let Ok(Some((last_ts, _))) = self.db.get_user_cursor(pk) {
                        let since = last_ts - CURSOR_OVERLAP_SECS as i64;
                        oldest_cursor = oldest_cursor.min(since);
                    }
                }
                oldest_cursor
            }
            CursorBand::Cold => {
                // Lookback from now
                now - (self.lookback_days as i64 * 86400)
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct ContentStats {
    pub relays_queried: u32,
    pub events_stored: u32,
    pub wot_updates: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_stats_default() {
        let stats = ContentStats::default();
        assert_eq!(stats.relays_queried, 0);
        assert_eq!(stats.events_stored, 0);
        assert_eq!(stats.wot_updates, 0);
    }
}
