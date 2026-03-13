use anyhow::Result;
use nostr_sdk::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::storage::db::Database;
use crate::wot::WotGraph;

use super::pool::RelayPool;
use super::processing;
use super::scheduler;
use super::types::{CursorBand, EventSource, SyncProgress, SyncStats, CURSOR_OVERLAP_SECS};

/// Phase 3: Content Fetch — batched event retrieval grouped by relay.
pub struct ContentFetch {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    pool: Arc<RelayPool>,
    own_pubkey: String,
    lookback_days: u32,
    /// How many notes to fetch from WoT peers each cycle (0 = disabled).
    wot_notes_per_cycle: u32,
    sync_stats: Arc<RwLock<SyncStats>>,
    app_handle: tauri::AppHandle,
}

impl ContentFetch {
    pub fn new(
        db: Arc<Database>,
        graph: Arc<WotGraph>,
        pool: Arc<RelayPool>,
        own_pubkey: String,
        lookback_days: u32,
        wot_notes_per_cycle: u32,
        sync_stats: Arc<RwLock<SyncStats>>,
        app_handle: tauri::AppHandle,
    ) -> Self {
        Self { db, graph, pool, own_pubkey, lookback_days, wot_notes_per_cycle, sync_stats, app_handle }
    }

    /// Run the full content fetch phase.
    /// Fetches in priority order: tracked accounts first, then follows, then optionally FoF.
    pub async fn run(
        &self,
        pubkeys_needing_relay_refresh: &[String],
    ) -> Result<ContentStats> {
        let mut stats = ContentStats::default();

        let follows = self.graph.get_follows(&self.own_pubkey).unwrap_or_default();
        let tracked = self.db.get_tracked_pubkeys()?;

        let refresh_set: std::collections::HashSet<&str> =
            pubkeys_needing_relay_refresh.iter().map(|s| s.as_str()).collect();
        let cursors = self.db.get_all_cursors()?;
        let now = chrono::Utc::now().timestamp();
        let bands = scheduler::group_by_cursor_band(&cursors, now);

        // Pass 1: Tracked profiles (highest priority after own)
        if !tracked.is_empty() {
            info!("Content: fetching {} tracked profiles first", tracked.len());
            let pass_stats = self.fetch_pubkey_set(
                &tracked, &refresh_set, &bands, now, super::types::MEDIA_PRIORITY_TRACKED, "tracked", "0.5",
            ).await;
            stats.events_stored += pass_stats.0;
            stats.wot_updates += pass_stats.1;
            stats.relays_queried += pass_stats.2;
        }

        // Pass 2: Follows (excluding tracked to avoid double-fetch)
        let tracked_set: std::collections::HashSet<&str> =
            tracked.iter().map(|s| s.as_str()).collect();
        let follows_only: Vec<String> = follows
            .iter()
            .filter(|pk| !tracked_set.contains(pk.as_str()))
            .cloned()
            .collect();

        // Record follows count for dashboard display
        {
            let mut ss = self.sync_stats.write().await;
            ss.follows_count = follows.len() as u64;
        }

        if !follows_only.is_empty() {
            let pass_stats = self.fetch_pubkey_set(
                &follows_only, &refresh_set, &bands, now, super::types::MEDIA_PRIORITY_FOLLOWS, "tier2", "1",
            ).await;
            stats.events_stored += pass_stats.0;
            stats.wot_updates += pass_stats.1;
            stats.relays_queried += pass_stats.2;
        }

        // Pass 3: WoT content — random sample from the broader network
        let follow_set: std::collections::HashSet<&str> =
            follows.iter().map(|s| s.as_str()).collect();

        if self.wot_notes_per_cycle > 0 {
            let wot_peers = self.get_random_wot_peers(&follows, &tracked_set, &follow_set);
            if !wot_peers.is_empty() {
                info!("Content: fetching WoT content from {} random peers (target: {} notes)", wot_peers.len(), self.wot_notes_per_cycle);
                let pass_stats = self.fetch_pubkey_set_with_limit(
                    &wot_peers, &refresh_set, &bands, now,
                    super::types::MEDIA_PRIORITY_FOF, "tier3", "2",
                    self.wot_notes_per_cycle,
                ).await;
                stats.events_stored += pass_stats.0;
                stats.wot_updates += pass_stats.1;
                stats.relays_queried += pass_stats.2;
            }
        }

        info!(
            "Content fetch: {} events stored, {} WoT updates across {} relays",
            stats.events_stored, stats.wot_updates, stats.relays_queried
        );

        Ok(stats)
    }

    /// Fetch events for a set of pubkeys **batched by relay** using the routing plan.
    /// Groups pubkeys by their best relay and fetches each batch in a single subscription,
    /// drastically reducing the number of WebSocket connections.
    /// `stat_key` identifies which counter to update: "tracked", "tier2", "tier3".
    /// Returns (events_stored, wot_updates, relays_queried).
    async fn fetch_pubkey_set(
        &self,
        pubkeys: &[String],
        refresh_set: &std::collections::HashSet<&str>,
        bands: &HashMap<CursorBand, Vec<String>>,
        now: i64,
        media_priority: i32,
        stat_key: &str,
        layer: &str,
    ) -> (u32, u32, u32) {
        let mut events_stored = 0u32;
        let mut wot_updates = 0u32;

        let total = pubkeys.len() as u64;

        // Filter out muted pubkeys
        let muted: Vec<String> = pubkeys
            .iter()
            .filter(|pk| self.db.is_pubkey_muted(pk).unwrap_or(false))
            .cloned()
            .collect();

        // Build pubkey → relay map for the routing planner
        let mut pubkey_relays: HashMap<String, Vec<(String, f64)>> = HashMap::new();
        let mut no_relay_pubkeys: Vec<String> = Vec::new();

        for pubkey in pubkeys {
            if muted.contains(pubkey) {
                continue;
            }
            match self.db.get_write_relays(pubkey) {
                Ok(relays) if !relays.is_empty() => {
                    let scored: Vec<(String, f64)> = relays
                        .into_iter()
                        .map(|(url, _)| {
                            let score = self.db.get_relay_reliability(&url).unwrap_or(0.5);
                            (url, score)
                        })
                        .collect();
                    pubkey_relays.insert(pubkey.clone(), scored);
                }
                _ => {
                    no_relay_pubkeys.push(pubkey.clone());
                }
            }
        }

        // Add pubkeys with no relay info to default relays
        for pubkey in &no_relay_pubkeys {
            let defaults: Vec<(String, f64)> = super::types::DEFAULT_RELAYS
                .iter()
                .map(|r| (r.to_string(), 0.5))
                .collect();
            pubkey_relays.insert(pubkey.clone(), defaults);
        }

        // Build the routing plan: groups pubkeys by relay for batched fetching
        let plan = scheduler::build_routing_plan(&pubkey_relays, &muted);

        info!(
            "Content[{}]: {} pubkeys → {} relay batches (was {} individual calls)",
            stat_key, pubkeys.len(), plan.routes.len(), pubkeys.len()
        );

        // Atomically update layer + progress
        {
            let mut ss = self.sync_stats.write().await;
            ss.current_layer = layer.to_string();
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = total;
            ss.pass_relays_done = 0;
            ss.pass_relays_total = plan.routes.len() as u64;
        }

        // Flatten routes into chunks: split large relay batches into groups of
        // MAX_PUBKEYS_PER_SUB to avoid hitting relay filter limits and to keep
        // the event limit meaningful per author.
        const MAX_PUBKEYS_PER_SUB: usize = 30;

        let mut chunks: Vec<(&str, Vec<&[String]>)> = Vec::new();
        let mut total_chunks = 0usize;
        for route in &plan.routes {
            let sub_chunks: Vec<&[String]> = route.pubkeys.chunks(MAX_PUBKEYS_PER_SUB).collect();
            total_chunks += sub_chunks.len();
            chunks.push((&route.relay_url, sub_chunks));
        }

        info!(
            "Content[{}]: {} relay batches → {} sub-chunks (max {} pubkeys each)",
            stat_key, plan.routes.len(), total_chunks, MAX_PUBKEYS_PER_SUB
        );

        // Update relay totals to reflect actual chunks
        {
            let mut ss = self.sync_stats.write().await;
            ss.pass_relays_total = total_chunks as u64;
        }

        let mut pubkeys_done = muted.len() as u64;
        let mut chunk_idx = 0usize;

        for (relay_url, sub_chunks) in &chunks {
            for chunk in sub_chunks {
                let short_url = relay_url.replace("wss://", "").replace("ws://", "");

                // Emit progress
                self.app_handle.emit("sync:progress", &SyncProgress {
                    tier: 3,
                    fetched: events_stored as u64,
                    total,
                    relay: format!("{} ({} profiles, {}/{})", short_url, chunk.len(), chunk_idx + 1, total_chunks),
                }).ok();

                // Scale subscription timeout with batch size:
                // larger batches need more time for relays to stream events
                let sub_timeout = if chunk.len() > 20 { 30u64 } else { 15u64 };
                let fetch_result = self.fetch_from_relay(
                    relay_url,
                    chunk,
                    bands,
                    refresh_set,
                    now,
                    media_priority,
                    layer,
                    sub_timeout,
                ).await;

                let (stored, wot) = match &fetch_result {
                    Ok(stats) => *stats,
                    Err(e) => {
                        warn!(
                            "Content[{}]: failed {} pubkeys via {}: {}",
                            stat_key, chunk.len(), short_url, e
                        );
                        (0, 0)
                    }
                };

                events_stored += stored;
                wot_updates += wot;

                // Only advance cursors if the relay actually responded.
                // On failure, leave cursors untouched so the next cycle
                // retries with the same lookback window.
                if fetch_result.is_ok() {
                    for pubkey in *chunk {
                        self.db.touch_user_cursor(pubkey).ok();
                    }
                }

                pubkeys_done += chunk.len() as u64;
                chunk_idx += 1;

                // Update counters after each chunk
                {
                    let mut ss = self.sync_stats.write().await;
                    ss.pass_pubkeys_done = pubkeys_done;
                    ss.pass_relays_done = chunk_idx as u64;
                    match stat_key {
                        "tracked" => ss.tracked_fetched += stored as u64,
                        "tier2" => ss.tier2_fetched += stored as u64,
                        "tier3" => ss.tier3_fetched += stored as u64,
                        _ => {}
                    }
                }

                if stored > 0 {
                    self.db.record_relay_success(relay_url, stored, 0).ok();
                }
            }
        }

        // Don't clear pass progress here — the next pass or layer transition
        // will overwrite these values. Clearing them causes the dashboard
        // counter to briefly jump to 0 between cycles.

        (events_stored, wot_updates, plan.routes.len() as u32)
    }

    /// Fetch events from a single relay for a set of pubkeys.
    /// Returns `Ok((stored, wot_updates))` on success (even if 0 events),
    /// or `Err` if the relay connection/subscription failed.
    async fn fetch_from_relay(
        &self,
        relay_url: &str,
        pubkeys: &[String],
        bands: &HashMap<CursorBand, Vec<String>>,
        refresh_set: &std::collections::HashSet<&str>,
        now: i64,
        media_priority: i32,
        layer: &str,
        subscription_timeout_secs: u64,
    ) -> Result<(u32, u32)> {
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
            let age_mins = (now - since) / 60;

            debug!(
                "Content filter: {:?} band, {} authors, since={}min ago",
                band, band_pubkeys.len(), age_mins
            );

            // Scale limit with batch size so we don't miss content from
            // quieter authors when batching many pubkeys to one relay.
            // At least 200 per author-band, capped at 5000 to avoid overwhelming relays.
            let limit = (authors.len() * 10).max(200).min(5000);

            let content_filter = Filter::new()
                .authors(authors)
                .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
                .since(Timestamp::from(since as u64))
                .limit(limit);

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
            debug!("Content: {} — no filters built, skipping", relay_url);
            return Ok((0, 0));
        }

        debug!("Content: {} — subscribing with {} filters (timeout={}s)", relay_url, filters.len(), subscription_timeout_secs);
        match self.pool.subscribe_and_collect(
            &[relay_url.to_string()],
            filters,
            subscription_timeout_secs,
        ).await {
            Ok(events) => {
                debug!("Content: {} — received {} events, processing...", relay_url, events.len());
                let start = std::time::Instant::now();
                let (stored, wot) = processing::process_events(
                    &events,
                    &self.db,
                    &self.graph,
                    &self.own_pubkey,
                    EventSource::Sync,
                    media_priority,
                    Some(&self.app_handle),
                    layer,
                );

                // Update relay stats
                let latency = start.elapsed().as_millis() as u32;
                debug!("Content: {} — processed {} events in {}ms ({} stored)", relay_url, events.len(), latency, stored);
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
                    debug!("Content: {} — fetching {} missing thread refs", relay_url, missing_refs.len());
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
                                &thread_events, &self.db, &self.graph, &self.own_pubkey, EventSource::ThreadContext, super::types::MEDIA_PRIORITY_OTHERS, Some(&self.app_handle), "thread",
                            );
                            thread_stored = ts;
                            if ts > 0 {
                                debug!("Content: {} — inline thread fetch → {} events", relay_url, ts);
                            }
                        }
                    }
                }

                info!(
                    "Content: {} → {} received, {} stored, {} WoT, {} thread",
                    relay_url, events.len(), stored, wot, thread_stored
                );

                Ok((stored + thread_stored, wot))
            }
            Err(e) => {
                warn!("Content: fetch from {} FAILED: {}", relay_url, e);
                self.db.record_relay_failure(relay_url).ok();
                Err(e)
            }
        }
    }

    /// Get follows-of-follows sorted by how many of our follows also follow them.
    /// Returns up to 200 FoF pubkeys, excluding direct follows and self.
    /// Get a random sample of WoT peers (FoF and beyond), weighted by overlap.
    /// Excludes own pubkey, tracked profiles, and direct follows.
    fn get_random_wot_peers(
        &self,
        follows: &[String],
        tracked_set: &std::collections::HashSet<&str>,
        follow_set: &std::collections::HashSet<&str>,
    ) -> Vec<String> {
        use rand::seq::SliceRandom;

        // Gather all FoF with overlap counts
        let mut overlap_counts: HashMap<String, u32> = HashMap::new();
        for follow in follows {
            if let Some(fof_list) = self.graph.get_follows(follow) {
                for fof in fof_list {
                    if fof != self.own_pubkey
                        && !follow_set.contains(fof.as_str())
                        && !tracked_set.contains(fof.as_str())
                    {
                        *overlap_counts.entry(fof).or_insert(0) += 1;
                    }
                }
            }
        }

        if overlap_counts.is_empty() {
            return Vec::new();
        }

        // Shuffle the full pool — weighted towards higher overlap
        // by repeating high-overlap entries in the pool
        let mut pool: Vec<String> = Vec::new();
        for (pk, count) in &overlap_counts {
            // Weight: sqrt(count) repetitions so high-overlap peers are more likely
            let weight = (*count as f64).sqrt().ceil() as u32;
            for _ in 0..weight {
                pool.push(pk.clone());
            }
        }

        let mut rng = rand::thread_rng();
        pool.shuffle(&mut rng);

        // Deduplicate while preserving shuffled order
        let mut seen = std::collections::HashSet::new();
        let selected: Vec<String> = pool
            .into_iter()
            .filter(|pk| seen.insert(pk.clone()))
            .collect();

        info!(
            "WoT peers: {} unique from {} total FoF",
            selected.len(), overlap_counts.len()
        );

        selected
    }

    /// Like fetch_pubkey_set but stops after collecting `max_notes` new events.
    async fn fetch_pubkey_set_with_limit(
        &self,
        pubkeys: &[String],
        refresh_set: &std::collections::HashSet<&str>,
        bands: &HashMap<CursorBand, Vec<String>>,
        now: i64,
        media_priority: i32,
        _stat_key: &str,
        layer: &str,
        max_notes: u32,
    ) -> (u32, u32, u32) {
        let mut events_stored = 0u32;
        let mut wot_updates = 0u32;

        let total = pubkeys.len() as u64;

        // Filter out muted pubkeys
        let muted: Vec<String> = pubkeys
            .iter()
            .filter(|pk| self.db.is_pubkey_muted(pk).unwrap_or(false))
            .cloned()
            .collect();

        // Build pubkey → relay map
        let mut pubkey_relays: HashMap<String, Vec<(String, f64)>> = HashMap::new();
        for pubkey in pubkeys {
            if muted.contains(pubkey) {
                continue;
            }
            match self.db.get_write_relays(pubkey) {
                Ok(relays) if !relays.is_empty() => {
                    let scored: Vec<(String, f64)> = relays
                        .into_iter()
                        .map(|(url, _)| {
                            let score = self.db.get_relay_reliability(&url).unwrap_or(0.5);
                            (url, score)
                        })
                        .collect();
                    pubkey_relays.insert(pubkey.clone(), scored);
                }
                _ => {
                    let defaults: Vec<(String, f64)> = super::types::DEFAULT_RELAYS
                        .iter()
                        .map(|r| (r.to_string(), 0.5))
                        .collect();
                    pubkey_relays.insert(pubkey.clone(), defaults);
                }
            }
        }

        let plan = scheduler::build_routing_plan(&pubkey_relays, &muted);

        const MAX_PUBKEYS_PER_SUB: usize = 30;

        let mut chunks: Vec<(&str, Vec<&[String]>)> = Vec::new();
        let mut total_chunks = 0usize;
        for route in &plan.routes {
            let sub_chunks: Vec<&[String]> = route.pubkeys.chunks(MAX_PUBKEYS_PER_SUB).collect();
            total_chunks += sub_chunks.len();
            chunks.push((&route.relay_url, sub_chunks));
        }

        {
            let mut ss = self.sync_stats.write().await;
            ss.current_layer = layer.to_string();
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = total;
            ss.pass_relays_done = 0;
            ss.pass_relays_total = total_chunks as u64;
        }

        let mut pubkeys_done = muted.len() as u64;
        let mut chunk_idx = 0usize;

        'outer: for (relay_url, sub_chunks) in &chunks {
            for chunk in sub_chunks {
                // Stop if we've collected enough notes
                if events_stored >= max_notes {
                    info!("WoT content: reached {} notes limit at chunk {}/{}", max_notes, chunk_idx, total_chunks);
                    break 'outer;
                }

                let short_url = relay_url.replace("wss://", "").replace("ws://", "");

                self.app_handle.emit("sync:progress", &SyncProgress {
                    tier: 3,
                    fetched: events_stored as u64,
                    total: max_notes as u64,
                    relay: format!("{} ({}/{}notes)", short_url, events_stored, max_notes),
                }).ok();

                let sub_timeout = if chunk.len() > 20 { 30u64 } else { 15u64 };
                let fetch_result = self.fetch_from_relay(
                    relay_url,
                    chunk,
                    bands,
                    refresh_set,
                    now,
                    media_priority,
                    layer,
                    sub_timeout,
                ).await;

                let (stored, wot) = match &fetch_result {
                    Ok(stats) => *stats,
                    Err(e) => {
                        warn!("WoT content: failed {} pubkeys via {}: {}", chunk.len(), short_url, e);
                        (0, 0)
                    }
                };

                events_stored += stored;
                wot_updates += wot;

                if fetch_result.is_ok() {
                    for pubkey in *chunk {
                        self.db.touch_user_cursor(pubkey).ok();
                    }
                }

                pubkeys_done += chunk.len() as u64;
                chunk_idx += 1;

                {
                    let mut ss = self.sync_stats.write().await;
                    ss.pass_pubkeys_done = pubkeys_done;
                    ss.pass_relays_done = chunk_idx as u64;
                    ss.tier3_fetched += stored as u64;
                }

                if stored > 0 {
                    self.db.record_relay_success(relay_url, stored, 0).ok();
                }
            }
        }

        // Don't clear pass progress here — the next pass or layer transition
        // will overwrite these values. Clearing them causes the dashboard
        // counter to briefly jump to 0 between cycles.

        (events_stored, wot_updates, total_chunks as u32)
    }

    /// Compute the `since` timestamp for a cursor band.
    fn compute_since(&self, band: CursorBand, pubkeys: &[&String], now: i64) -> i64 {
        // Fallback: if no cursors found, look back `lookback_days` instead of snapping to `now`
        let fallback = now - (self.lookback_days as i64 * 86400);
        match band {
            CursorBand::Hot | CursorBand::Warm => {
                // Use the oldest cursor in the band, with overlap
                let mut oldest_cursor: Option<i64> = None;
                for pk in pubkeys {
                    if let Ok(Some((last_ts, _))) = self.db.get_user_cursor(pk) {
                        let since = last_ts - CURSOR_OVERLAP_SECS as i64;
                        oldest_cursor = Some(oldest_cursor.map_or(since, |c: i64| c.min(since)));
                    }
                }
                // If no pubkey had a cursor, fall back to lookback window (not now!)
                oldest_cursor.unwrap_or(fallback)
            }
            CursorBand::Cold => {
                // If we've fetched this user before, use last_fetched_at with overlap
                // instead of the full lookback window. This makes subsequent syncs
                // much faster when there are no new events.
                let mut best_fetched_at: Option<i64> = None;
                for pk in pubkeys {
                    if let Ok(Some((_last_ts, last_fetched_at))) = self.db.get_user_cursor(pk) {
                        if last_fetched_at > 0 {
                            let since = last_fetched_at - CURSOR_OVERLAP_SECS as i64;
                            best_fetched_at = Some(best_fetched_at.map_or(since, |c: i64| c.min(since)));
                        }
                    }
                }
                best_fetched_at.unwrap_or(fallback)
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
