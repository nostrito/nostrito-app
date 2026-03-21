use anyhow::Result;
use nostr_sdk::prelude::*;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use std::collections::HashSet;

use crate::storage::db::Database;
use crate::wot::WotGraph;

use super::content::ContentFetch;
use super::discovery::Discovery;
use super::media::MediaDownloader;
use super::pool::RelayPool;
use super::processing;
use super::pruning;
use super::threads::ThreadContext;
use super::types::{EventSource, SyncConfig, SyncPhase, SyncProgress, SyncStats, TierComplete, WOT_CRAWL_FREQUENCY};

/// Relay-centric sync engine with NIP-65 outbox routing.
///
/// Runs a 5-phase sync cycle:
///   1. OwnData — fetch own profile + events
///   2. Discovery — discover relay info for follows
///   3. ContentFetch — relay-centric batched event retrieval
///   4. ThreadContext — fetch missing thread roots
///   5. MediaDownload — download queued media
pub struct SyncEngine {
    graph: Arc<WotGraph>,
    db: Arc<Database>,
    relay_urls: Vec<String>,
    cancel: CancellationToken,
    hex_pubkey: String,
    pub sync_tier: Arc<AtomicU8>,
    pub sync_stats: Arc<RwLock<SyncStats>>,
    app_handle: tauri::AppHandle,
    tracked_media_gb: f64,
    wot_media_gb: f64,
    sync_config: SyncConfig,
    pool: Arc<RelayPool>,
}

impl SyncEngine {
    pub fn new(
        graph: Arc<WotGraph>,
        db: Arc<Database>,
        relay_aliases: Vec<String>,
        hex_pubkey: String,
        sync_tier: Arc<AtomicU8>,
        sync_stats: Arc<RwLock<SyncStats>>,
        app_handle: tauri::AppHandle,
        tracked_media_gb: f64,
        wot_media_gb: f64,
        sync_config: SyncConfig,
        _max_event_age_days: u32,
    ) -> Self {
        let valid_relays: Vec<String> = relay_aliases
            .into_iter()
            .filter(|r| !r.trim().is_empty())
            .collect();
        let final_relays = if valid_relays.is_empty() {
            warn!("SyncEngine: no valid relays, using defaults");
            vec![
                "wss://relay.damus.io".to_string(),
                "wss://relay.primal.net".to_string(),
                "wss://nos.lol".to_string(),
            ]
        } else {
            valid_relays
        };

        info!(
            "SyncEngine: initialized with {} relays: {:?}",
            final_relays.len(),
            final_relays
        );

        Self {
            graph,
            db,
            relay_urls: final_relays,
            cancel: CancellationToken::new(),
            hex_pubkey,
            sync_tier,
            sync_stats,
            app_handle,
            tracked_media_gb,
            wot_media_gb,
            sync_config,
            pool: Arc::new(RelayPool::new()),
        }
    }

    /// Start the sync engine — returns a CancellationToken for stopping.
    pub fn start(self: Arc<Self>) -> CancellationToken {
        let cancel = self.cancel.clone();

        tokio::spawn(async move {
            if let Err(e) = self.run().await {
                error!("SyncEngine error: {}", e);
            }
        });

        cancel
    }

    /// Main sync loop — runs phases in order, repeating on interval.
    async fn run(&self) -> Result<()> {
        let mut cycle = 0u32;

        loop {
            if self.cancel.is_cancelled() {
                break;
            }

            cycle += 1;
            let cycle_start = std::time::Instant::now();
            info!("SyncEngine: ═══ starting cycle {} ═══", cycle);

            // Phase 1: Own Data
            self.emit_phase(SyncPhase::OwnData).await;
            let phase_start = std::time::Instant::now();
            if let Err(e) = self.phase_own_data().await {
                warn!("Phase 1 error: {}", e);
            }
            info!("SyncEngine: Phase 1 (Own Data) took {:.1}s", phase_start.elapsed().as_secs_f32());

            if self.cancel.is_cancelled() { break; }

            // Phase 2: Discovery
            self.emit_phase(SyncPhase::Discovery).await;
            let phase_start = std::time::Instant::now();
            if let Err(e) = self.phase_discovery().await {
                warn!("Phase 2 error: {}", e);
            }
            info!("SyncEngine: Phase 2 (Discovery) took {:.1}s", phase_start.elapsed().as_secs_f32());

            if self.cancel.is_cancelled() { break; }

            // Phase 3: Content Fetch
            self.emit_phase(SyncPhase::ContentFetch).await;
            let phase_start = std::time::Instant::now();
            if let Err(e) = self.phase_content().await {
                warn!("Phase 3 error: {}", e);
            }
            info!("SyncEngine: Phase 3 (Content Fetch) took {:.1}s", phase_start.elapsed().as_secs_f32());

            if self.cancel.is_cancelled() { break; }

            // Phase 4: Thread Context
            self.emit_phase(SyncPhase::ThreadContext).await;
            let phase_start = std::time::Instant::now();
            if let Err(e) = self.phase_threads().await {
                warn!("Phase 4 error: {}", e);
            }
            info!("SyncEngine: Phase 4 (Thread Context) took {:.1}s", phase_start.elapsed().as_secs_f32());

            if self.cancel.is_cancelled() { break; }

            // Phase 5: Media Download
            self.emit_phase(SyncPhase::MediaDownload).await;
            let phase_start = std::time::Instant::now();
            if let Err(e) = self.phase_media().await {
                warn!("Phase 5 error: {}", e);
            }
            info!("SyncEngine: Phase 5 (Media Download) took {:.1}s", phase_start.elapsed().as_secs_f32());

            // Pruning: run every cycle after all phases
            if let Err(e) = self.run_pruning() {
                warn!("Pruning error: {}", e);
            }

            // WoT crawl: every N cycles
            if cycle % WOT_CRAWL_FREQUENCY == 0 {
                if let Err(e) = self.phase_wot_crawl().await {
                    warn!("WoT crawl error: {}", e);
                }
            }

            // Mark cycle complete
            self.sync_tier.store(0, Ordering::Relaxed);
            self.emit_tier_complete(0).await;

            info!("SyncEngine: ═══ cycle {} complete in {:.1}s ═══", cycle, cycle_start.elapsed().as_secs_f32());

            // Wait for next cycle
            let interval = Duration::from_secs(self.sync_config.cycle_interval_secs as u64);
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = self.cancel.cancelled() => break,
            }
        }

        self.pool.shutdown().await;
        info!("SyncEngine: stopped");
        Ok(())
    }

    // ── Phase Implementations ────────────────────────────────────

    /// Build a comprehensive relay set for own-data queries by merging:
    /// 1. User's configured relays
    /// 2. NIP-65 read relays
    /// 3. Well-known relays
    fn build_comprehensive_relay_set(&self) -> Vec<String> {
        let mut set: HashSet<String> = HashSet::new();

        // User's configured relays
        for r in &self.relay_urls {
            set.insert(r.clone());
        }

        // NIP-65 read relays
        if let Ok(nip65) = self.db.get_read_relays(&self.hex_pubkey) {
            for (url, _) in nip65 {
                set.insert(url);
            }
        }

        // Well-known relays
        for url in &[
            "wss://relay.damus.io",
            "wss://relay.primal.net",
            "wss://nos.lol",
            "wss://purplepag.es",
            "wss://relay.nostr.band",
        ] {
            set.insert(url.to_string());
        }

        set.into_iter().collect()
    }

    /// Phase 1: Fetch own profile, contact list, and all own events.
    async fn phase_own_data(&self) -> Result<()> {
        {
            let mut ss = self.sync_stats.write().await;
            ss.tier1_fetched = 0;
        }
        let pk = PublicKey::from_hex(&self.hex_pubkey)?;

        // Fetch own metadata + contacts (replaceable events — always get latest)
        let meta_filter = Filter::new()
            .author(pk)
            .kinds(vec![Kind::Metadata, Kind::ContactList, Kind::MuteList, Kind::RelayList])
            .limit(10);

        // Use cursor to avoid re-fetching own events we already have
        let now = chrono::Utc::now().timestamp();
        let since = match self.db.get_user_cursor(&self.hex_pubkey) {
            Ok(Some((last_ts, last_fetched_at))) => {
                // Use whichever is more recent: last event we posted, or last time we checked.
                // If we haven't posted in days but fetched 5 min ago, use the fetch time.
                last_ts.max(last_fetched_at) - super::types::CURSOR_OVERLAP_SECS as i64
            }
            _ => now - (self.sync_config.lookback_days as i64 * 86400),
        };

        // Fetch own events since last cursor
        let events_filter = Filter::new()
            .author(pk)
            .kinds(vec![
                Kind::TextNote,
                Kind::Repost,
                Kind::Reaction,
                Kind::LongFormTextNote,
                Kind::EncryptedDirectMessage,
            ])
            .since(Timestamp::from(since as u64))
            .limit(1000);

        // Fetch DMs addressed to us since last cursor
        let received_dms_filter = Filter::new()
            .pubkey(pk)
            .kind(Kind::EncryptedDirectMessage)
            .since(Timestamp::from(since as u64))
            .limit(500);

        // Mentions of us (kind:1 notes with #p tag pointing to us)
        let mentions_filter = Filter::new()
            .pubkey(pk)
            .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
            .since(Timestamp::from(since as u64))
            .limit(500);

        // Reactions to our notes (kind:7 with #p tag = us)
        let reactions_to_own_filter = Filter::new()
            .pubkey(pk)
            .kind(Kind::Reaction)
            .since(Timestamp::from(since as u64))
            .limit(500);

        // Zaps to our notes (kind:9735 with #p tag = us)
        let zaps_to_own_filter = Filter::new()
            .pubkey(pk)
            .kind(Kind::from(9735))
            .since(Timestamp::from(since as u64))
            .limit(200);

        let comprehensive_relays = self.build_comprehensive_relay_set();

        let events = self.pool.subscribe_and_collect(
            &comprehensive_relays,
            vec![
                meta_filter,
                events_filter,
                received_dms_filter,
                mentions_filter,
                reactions_to_own_filter,
                zaps_to_own_filter,
            ],
            30,
        ).await?;

        let (stored, wot) = processing::process_events(
            &events,
            &self.db,
            &self.graph,
            &self.hex_pubkey,
            EventSource::OwnBackup,
            super::types::MEDIA_PRIORITY_OWNER,
            Some(&self.app_handle),
            "0",
        );

        // Touch own cursor so next cycle uses this as the since bound
        self.db.touch_user_cursor(&self.hex_pubkey).ok();

        {
            let mut ss = self.sync_stats.write().await;
            ss.tier1_fetched += stored as u64;
        }
        self.emit_progress(1, stored as u64, events.len() as u64, "own");
        info!("Phase 1: {} events stored, {} WoT updates (since={}min ago)", stored, wot, (now - since) / 60);

        self.emit_tier_complete(1).await;
        Ok(())
    }

    /// Phase 2: Discover relay information for follows.
    async fn phase_discovery(&self) -> Result<()> {
        let discovery = Discovery::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
            self.app_handle.clone(),
        );

        let stats = discovery.run().await?;
        info!(
            "Phase 2: {} local hints, {} bootstrapped, {} needing refresh",
            stats.local_hints, stats.bootstrap_relays, stats.needing_refresh
        );

        self.emit_tier_complete(2).await;
        Ok(())
    }

    /// Phase 3: Relay-centric content fetch.
    async fn phase_content(&self) -> Result<()> {
        {
            let mut ss = self.sync_stats.write().await;
            ss.tracked_fetched = 0;
            ss.tier2_fetched = 0;
            ss.tier3_fetched = 0;
            ss.follows_count = 0;
        }
        let discovery = Discovery::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
            self.app_handle.clone(),
        );
        let needing_refresh = discovery.pubkeys_needing_relay_refresh()?;

        let content = ContentFetch::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
            self.sync_config.lookback_days,
            self.sync_config.wot_notes_per_cycle,
            Arc::clone(&self.sync_stats),
            self.app_handle.clone(),
        );

        let stats = content.run(&needing_refresh).await?;

        // Clear layer state now that content passes are done
        {
            let mut ss = self.sync_stats.write().await;
            ss.current_layer = String::new();
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = 0;
        }

        self.emit_progress(3, stats.events_stored as u64, 0, "content");
        info!(
            "Phase 3: {} events from {} relays",
            stats.events_stored, stats.relays_queried
        );

        self.emit_tier_complete(3).await;
        Ok(())
    }

    /// Phase 4: Fetch missing thread roots.
    async fn phase_threads(&self) -> Result<()> {
        let threads = ThreadContext::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
            self.app_handle.clone(),
            self.sync_config.thread_retention_days,
        );

        let stats = threads.run(&self.relay_urls).await?;
        if stats.fetched > 0 {
            info!("Phase 4: {} of {} missing roots fetched", stats.fetched, stats.missing);
        }

        Ok(())
    }

    /// Phase 5: Download queued media.
    async fn phase_media(&self) -> Result<()> {
        {
            let mut ss = self.sync_stats.write().await;
            ss.tier4_fetched = 0;
        }
        let media = MediaDownloader::new(
            Arc::clone(&self.db),
            self.hex_pubkey.clone(),
            self.tracked_media_gb,
            self.wot_media_gb,
            self.db.data_dir.clone(),
        );

        let stats = media.run(50).await?;
        if stats.downloaded > 0 {
            info!("Phase 5: {} downloaded, {} skipped", stats.downloaded, stats.skipped);
        }

        {
            let mut ss = self.sync_stats.write().await;
            ss.tier4_fetched += stats.downloaded as u64;
        }

        self.emit_tier_complete(5).await;
        Ok(())
    }

    /// Run tiered pruning.
    fn run_pruning(&self) -> Result<()> {
        let stats = pruning::run_pruning(&self.db, &self.graph, &self.hex_pubkey)?;
        if stats.total() > 0 {
            info!("Pruning: {} events deleted", stats.total());
        }

        // Size-based safety net: read max_storage_mb from config, default to 2 GB
        let max_bytes = self.db.get_config("max_storage_mb")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(2048) * 1024 * 1024;

        match pruning::prune_to_size_limit(&self.db, &self.graph, &self.hex_pubkey, max_bytes) {
            Ok(deleted) if deleted > 0 => {
                info!("[size-prune] Deleted {} additional events to stay under size limit", deleted);
            }
            Err(e) => {
                warn!("[size-prune] failed: {}", e);
            }
            _ => {}
        }

        // Debug-mode storage estimation
        if let Err(e) = crate::storage::estimation::estimate_storage(
            &self.db, &self.graph, &self.hex_pubkey,
        ) {
            debug!("[storage-estimate] failed: {}", e);
        }

        Ok(())
    }

    /// WoT crawl — fetch contact lists for follows-of-follows.
    async fn phase_wot_crawl(&self) -> Result<()> {
        // Make WoT crawl visible to the dashboard (runs after the 5 main phases)
        self.sync_tier.store(6, Ordering::Relaxed);
        {
            let mut ss = self.sync_stats.write().await;
            ss.current_tier = 6;
            ss.current_layer = "2".to_string();
            ss.current_phase = "WoT Crawl".to_string();
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = 0;
        }
        self.app_handle.emit("sync:progress", &SyncProgress {
            tier: 6,
            fetched: 0,
            total: 0,
            relay: "WoT Crawl".to_string(),
        }).ok();

        let follows = self.graph.get_follows(&self.hex_pubkey).unwrap_or_default();

        // Get follows-of-follows that need contact list updates
        let mut fof_to_fetch: Vec<String> = Vec::new();
        for follow in &follows {
            if let Some(fof_list) = self.graph.get_follows(follow) {
                for fof in fof_list {
                    if !follows.contains(&fof) && fof != self.hex_pubkey {
                        fof_to_fetch.push(fof);
                    }
                }
            }
        }

        fof_to_fetch.sort();
        fof_to_fetch.dedup();

        if fof_to_fetch.is_empty() {
            return Ok(());
        }

        // Batch fetch kind:3 for FoFs
        for chunk in fof_to_fetch.chunks(self.sync_config.wot_batch_size as usize) {
            if self.cancel.is_cancelled() { break; }

            let authors: Vec<PublicKey> = chunk
                .iter()
                .filter_map(|pk| PublicKey::from_hex(pk).ok())
                .collect();

            if authors.is_empty() { continue; }

            let filter = Filter::new()
                .authors(authors)
                .kinds(vec![Kind::Metadata, Kind::ContactList])
                .limit(100);

            match self.pool.subscribe_and_collect(&self.relay_urls, vec![filter], 15).await {
                Ok(events) => {
                    let (stored, wot) = processing::process_events(
                        &events,
                        &self.db,
                        &self.graph,
                        &self.hex_pubkey,
                        EventSource::Sync,
                        super::types::MEDIA_PRIORITY_FOF,
                        Some(&self.app_handle),
                        "2",
                    );

                    let mut ss = self.sync_stats.write().await;
                    ss.tier3_fetched += stored as u64;

                    if wot > 0 {
                        info!("WoT crawl: {} stored, {} graph updates", stored, wot);
                    }
                }
                Err(e) => warn!("WoT crawl batch failed: {}", e),
            }

            tokio::time::sleep(Duration::from_secs(
                self.sync_config.batch_pause_secs as u64,
            ))
            .await;
        }

        Ok(())
    }

    // ── Event Emission ───────────────────────────────────────────

    async fn emit_phase(&self, phase: SyncPhase) {
        let layer = match phase {
            SyncPhase::OwnData => "0",
            SyncPhase::Discovery => "",
            SyncPhase::ContentFetch => "",
            SyncPhase::ThreadContext => "thread",
            SyncPhase::MediaDownload => "",
        };

        // Set sync_tier atomically BEFORE updating stats and emitting events,
        // so any IPC call to get_status sees the correct tier immediately.
        self.sync_tier.store(phase as u8, Ordering::Relaxed);

        // Update sync_stats with current phase info and clear stale progress
        {
            let mut ss = self.sync_stats.write().await;
            ss.current_tier = phase as u8;
            ss.current_layer = layer.to_string();
            ss.current_phase = phase.label().to_string();
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = 0;
            ss.pass_relays_done = 0;
            ss.pass_relays_total = 0;
        }
        let progress = SyncProgress {
            tier: phase as u8,
            fetched: 0,
            total: 0,
            relay: phase.label().to_string(),
        };
        self.app_handle.emit("sync:progress", &progress).ok();
    }

    fn emit_progress(&self, tier: u8, fetched: u64, total: u64, relay: &str) {
        let progress = SyncProgress {
            tier,
            fetched,
            total,
            relay: relay.to_string(),
        };
        self.app_handle.emit("sync:progress", &progress).ok();
    }

    async fn emit_tier_complete(&self, tier: u8) {
        if tier == 0 {
            // Cycle complete — mark as idle
            let mut ss = self.sync_stats.write().await;
            ss.current_tier = 0;
            ss.current_layer = String::new();
            ss.current_phase = String::new();
            ss.pass_pubkeys_done = 0;
            ss.pass_pubkeys_total = 0;
        }
        self.app_handle.emit("sync:tier_complete", &TierComplete { tier }).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_phase_ordering() {
        // Verify phase enum values maintain strict ordering
        assert!((SyncPhase::OwnData as u8) < (SyncPhase::Discovery as u8));
        assert!((SyncPhase::Discovery as u8) < (SyncPhase::ContentFetch as u8));
        assert!((SyncPhase::ContentFetch as u8) < (SyncPhase::ThreadContext as u8));
        assert!((SyncPhase::ThreadContext as u8) < (SyncPhase::MediaDownload as u8));
    }
}
