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
use super::types::{CursorBand, EventSource, SyncProgress, SyncStats, BATCH_PAUSE_SECS, CURSOR_OVERLAP_SECS};

/// Phase 3: Content Fetch — relay-centric batched event retrieval.
pub struct ContentFetch {
    db: Arc<Database>,
    graph: Arc<WotGraph>,
    pool: Arc<RelayPool>,
    own_pubkey: String,
    lookback_days: u32,
    fof_content: bool,
    hop3_content: bool,
    fof_max_pubkeys: u32,
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
        fof_content: bool,
        hop3_content: bool,
        fof_max_pubkeys: u32,
        sync_stats: Arc<RwLock<SyncStats>>,
        app_handle: tauri::AppHandle,
    ) -> Self {
        Self { db, graph, pool, own_pubkey, lookback_days, fof_content, hop3_content, fof_max_pubkeys, sync_stats, app_handle }
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
            self.set_layer("0.5").await;
            info!("Content: fetching {} tracked profiles first", tracked.len());
            let pass_stats = self.fetch_pubkey_set(
                &tracked, &refresh_set, &bands, now, super::types::MEDIA_PRIORITY_TRACKED, "tracked",
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

        if !follows_only.is_empty() {
            self.set_layer("1").await;
            let pass_stats = self.fetch_pubkey_set(
                &follows_only, &refresh_set, &bands, now, super::types::MEDIA_PRIORITY_FOLLOWS, "tier2",
            ).await;
            stats.events_stored += pass_stats.0;
            stats.wot_updates += pass_stats.1;
            stats.relays_queried += pass_stats.2;
        }

        // Pass 3: Follows-of-follows
        let follow_set: std::collections::HashSet<&str> =
            follows.iter().map(|s| s.as_str()).collect();
        let mut fof_set: std::collections::HashSet<String> = std::collections::HashSet::new();

        if self.fof_content {
            self.set_layer("2").await;
            let fof = self.get_fof_by_overlap(&follows);
            if !fof.is_empty() {
                let fof_only: Vec<String> = fof
                    .into_iter()
                    .filter(|pk| !tracked_set.contains(pk.as_str()) && !follow_set.contains(pk.as_str()))
                    .collect();
                fof_set = fof_only.iter().cloned().collect();
                if !fof_only.is_empty() {
                    info!("Content: fetching {} FoF pubkeys (by overlap priority)", fof_only.len());
                    let pass_stats = self.fetch_pubkey_set(
                        &fof_only, &refresh_set, &bands, now, super::types::MEDIA_PRIORITY_FOF, "tier3",
                    ).await;
                    stats.events_stored += pass_stats.0;
                    stats.wot_updates += pass_stats.1;
                    stats.relays_queried += pass_stats.2;
                }
            }
        }

        // Pass 4: Hop 3 (lowest priority content fetch)
        if self.hop3_content {
            self.set_layer("3").await;
            let hop3 = self.get_hop3_pubkeys(&follows, &follow_set, &tracked_set, &fof_set);
            if !hop3.is_empty() {
                info!("Content: fetching {} hop-3 pubkeys", hop3.len());
                let pass_stats = self.fetch_pubkey_set(
                    &hop3, &refresh_set, &bands, now, super::types::MEDIA_PRIORITY_HOP3, "tier3",
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

    /// Update the current_layer in sync_stats for frontend display.
    async fn set_layer(&self, layer: &str) {
        let mut ss = self.sync_stats.write().await;
        ss.current_layer = layer.to_string();
    }

    /// Fetch events for a set of pubkeys with routing, banding, and media priority.
    /// Updates sync_stats incrementally after each relay and emits progress.
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
    ) -> (u32, u32, u32) {
        let mut events_stored = 0u32;
        let mut wot_updates = 0u32;

        // Build relay routing
        let mut pubkey_relays: HashMap<String, Vec<(String, f64)>> = HashMap::new();
        let mut fallback_pubkeys: Vec<String> = Vec::new();

        for pubkey in pubkeys {
            let write_relays = match self.db.get_write_relays(pubkey) {
                Ok(r) => r,
                Err(_) => {
                    fallback_pubkeys.push(pubkey.clone());
                    continue;
                }
            };
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

        if !fallback_pubkeys.is_empty() {
            info!(
                "Content: {} of {} pubkeys have no relay info, using default relays as fallback",
                fallback_pubkeys.len(), pubkeys.len()
            );
            // Assign default relays for pubkeys with no NIP-65 data
            for pk in &fallback_pubkeys {
                let defaults: Vec<(String, f64)> = super::types::DEFAULT_RELAYS
                    .iter()
                    .map(|r| (r.to_string(), 0.3))
                    .collect();
                pubkey_relays.insert(pk.clone(), defaults);
            }
        }

        let muted: Vec<String> = pubkeys
            .iter()
            .filter(|pk| self.db.is_pubkey_muted(pk).unwrap_or(false))
            .cloned()
            .collect();

        let plan = scheduler::build_routing_plan(&pubkey_relays, &muted);
        let relays_queried = plan.routes.len() as u32;

        if plan.routes.is_empty() && !pubkeys.is_empty() {
            warn!("Content: routing plan is empty for {} pubkeys — no relays to query", pubkeys.len());
        }

        // Set pass totals so the dashboard can show progress
        let total_pubkeys = pubkeys.len() as u64;
        {
            let mut ss = self.sync_stats.write().await;
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = total_pubkeys;
        }

        let mut covered_pubkeys: std::collections::HashSet<String> = std::collections::HashSet::new();

        for (i, route) in plan.routes.iter().enumerate() {
            // Mark these pubkeys as in-progress BEFORE the fetch so the
            // dashboard shows progress immediately
            for pk in &route.pubkeys {
                covered_pubkeys.insert(pk.clone());
            }
            {
                let mut ss = self.sync_stats.write().await;
                ss.pass_pubkeys_done = covered_pubkeys.len() as u64;
            }

            // Emit progress BEFORE fetch so dashboard shows which relay we're querying
            let short_url = route.relay_url.replace("wss://", "").replace("ws://", "");
            info!(
                "Content[{}]: relay {}/{} {} ({} pubkeys, {}/{} covered)",
                stat_key, i + 1, relays_queried, short_url, route.pubkeys.len(),
                covered_pubkeys.len(), total_pubkeys
            );
            self.app_handle.emit("sync:progress", &SyncProgress {
                tier: 3,
                fetched: events_stored as u64,
                total: relays_queried as u64,
                relay: format!("{} ({}/{})", short_url, i + 1, relays_queried),
            }).ok();

            let relay_start = std::time::Instant::now();
            let route_result = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                self.fetch_from_relay(
                    &route.relay_url,
                    &route.pubkeys,
                    bands,
                    refresh_set,
                    now,
                    media_priority,
                ),
            ).await;

            let route_stats = match route_result {
                Ok(stats) => {
                    info!(
                        "Content[{}]: relay {} done in {:.1}s → {} stored, {} wot",
                        stat_key, short_url, relay_start.elapsed().as_secs_f32(), stats.0, stats.1
                    );
                    stats
                },
                Err(_) => {
                    warn!("Content[{}]: relay {} TIMED OUT after 20s, skipping", stat_key, route.relay_url);
                    (0, 0)
                }
            };

            events_stored += route_stats.0;
            wot_updates += route_stats.1;

            // Update event counters incrementally
            if route_stats.0 > 0 {
                let mut ss = self.sync_stats.write().await;
                match stat_key {
                    "tracked" => ss.tracked_fetched += route_stats.0 as u64,
                    "tier2" => ss.tier2_fetched += route_stats.0 as u64,
                    "tier3" => ss.tier3_fetched += route_stats.0 as u64,
                    _ => {}
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(BATCH_PAUSE_SECS)).await;
        }

        // Clear pass progress
        {
            let mut ss = self.sync_stats.write().await;
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = 0;
        }

        (events_stored, wot_updates, relays_queried)
    }

    /// Fetch events from a single relay for a set of pubkeys.
    async fn fetch_from_relay(
        &self,
        relay_url: &str,
        pubkeys: &[String],
        bands: &HashMap<CursorBand, Vec<String>>,
        refresh_set: &std::collections::HashSet<&str>,
        now: i64,
        media_priority: i32,
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
            debug!("Content: {} — no filters built, skipping", relay_url);
            return (0, 0);
        }

        debug!("Content: {} — subscribing with {} filters", relay_url, filters.len());
        match self.pool.subscribe_and_collect(
            &[relay_url.to_string()],
            filters,
            15,
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
                                &thread_events, &self.db, &self.graph, &self.own_pubkey, EventSource::ThreadContext, super::types::MEDIA_PRIORITY_OTHERS, Some(&self.app_handle),
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

                (stored + thread_stored, wot)
            }
            Err(e) => {
                warn!("Content: fetch from {} FAILED: {}", relay_url, e);
                self.db.record_relay_failure(relay_url).ok();
                (0, 0)
            }
        }
    }

    /// Get follows-of-follows sorted by how many of our follows also follow them.
    /// Returns up to 200 FoF pubkeys, excluding direct follows and self.
    fn get_fof_by_overlap(&self, follows: &[String]) -> Vec<String> {
        let follow_set: std::collections::HashSet<&str> =
            follows.iter().map(|s| s.as_str()).collect();

        // Count how many of our follows also follow each FoF
        let mut overlap_counts: HashMap<String, u32> = HashMap::new();
        for follow in follows {
            if let Some(fof_list) = self.graph.get_follows(follow) {
                for fof in fof_list {
                    if fof != self.own_pubkey && !follow_set.contains(fof.as_str()) {
                        *overlap_counts.entry(fof).or_insert(0) += 1;
                    }
                }
            }
        }

        // Sort by overlap count descending
        let mut fof_ranked: Vec<(String, u32)> = overlap_counts.into_iter().collect();
        fof_ranked.sort_by(|a, b| b.1.cmp(&a.1));

        let limit = if self.fof_max_pubkeys == 0 { fof_ranked.len() } else { self.fof_max_pubkeys as usize };

        // Take top half by overlap, fill the rest randomly from remaining pool
        // This ensures high-overlap accounts are always fetched while rotating through the network
        use rand::seq::SliceRandom;
        let top_half = limit / 2;
        let mut selected: Vec<String> = fof_ranked.iter().take(top_half).map(|(pk, _)| pk.clone()).collect();
        let remaining: Vec<&(String, u32)> = fof_ranked.iter().skip(top_half).collect();
        if !remaining.is_empty() {
            let mut rng = rand::thread_rng();
            let mut pool: Vec<String> = remaining.iter().map(|(pk, _)| pk.clone()).collect();
            pool.shuffle(&mut rng);
            pool.truncate(limit.saturating_sub(selected.len()));
            selected.extend(pool);
        }

        debug!(
            "FoF overlap: total={}, selected={} (limit={}), min_overlap={}",
            fof_ranked.len(),
            selected.len(),
            limit,
            fof_ranked.last().map(|f| f.1).unwrap_or(0)
        );

        selected
    }

    /// Get hop-3 pubkeys: follows of FoF, excluding all closer hops.
    /// Returns up to 100 pubkeys, sorted by overlap with FoF set.
    fn get_hop3_pubkeys(
        &self,
        follows: &[String],
        follow_set: &std::collections::HashSet<&str>,
        tracked_set: &std::collections::HashSet<&str>,
        fof_set: &std::collections::HashSet<String>,
    ) -> Vec<String> {
        let mut overlap_counts: HashMap<String, u32> = HashMap::new();

        // For each FoF, get their follows (which are hop 3 from us)
        for fof_pk in fof_set {
            if let Some(hop3_list) = self.graph.get_follows(fof_pk) {
                for pk in hop3_list {
                    if pk != self.own_pubkey
                        && !follow_set.contains(pk.as_str())
                        && !tracked_set.contains(pk.as_str())
                        && !fof_set.contains(&pk)
                    {
                        *overlap_counts.entry(pk).or_insert(0) += 1;
                    }
                }
            }
        }

        // If FoF set is empty, derive hop3 from follows' follows' follows
        if fof_set.is_empty() {
            for follow in follows {
                if let Some(fof_list) = self.graph.get_follows(follow) {
                    for fof in &fof_list {
                        if let Some(hop3_list) = self.graph.get_follows(fof) {
                            for pk in hop3_list {
                                if pk != self.own_pubkey
                                    && !follow_set.contains(pk.as_str())
                                    && !tracked_set.contains(pk.as_str())
                                {
                                    *overlap_counts.entry(pk).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut ranked: Vec<(String, u32)> = overlap_counts.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        ranked.truncate(100);

        debug!(
            "Hop3: top={}, min_overlap={}",
            ranked.len(),
            ranked.last().map(|f| f.1).unwrap_or(0)
        );

        ranked.into_iter().map(|(pk, _)| pk).collect()
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
                fallback
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
