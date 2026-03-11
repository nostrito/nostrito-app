use anyhow::Result;
use nostr_sdk::prelude::*;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

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
    storage_media_gb: f64,
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
        storage_media_gb: f64,
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
            storage_media_gb,
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
            info!("SyncEngine: starting cycle {}", cycle);

            // Phase 1: Own Data
            self.emit_phase(SyncPhase::OwnData);
            if let Err(e) = self.phase_own_data().await {
                warn!("Phase 1 error: {}", e);
            }

            if self.cancel.is_cancelled() { break; }

            // Phase 2: Discovery
            self.emit_phase(SyncPhase::Discovery);
            if let Err(e) = self.phase_discovery().await {
                warn!("Phase 2 error: {}", e);
            }

            if self.cancel.is_cancelled() { break; }

            // Phase 3: Content Fetch
            self.emit_phase(SyncPhase::ContentFetch);
            if let Err(e) = self.phase_content().await {
                warn!("Phase 3 error: {}", e);
            }

            if self.cancel.is_cancelled() { break; }

            // Phase 4: Thread Context
            self.emit_phase(SyncPhase::ThreadContext);
            if let Err(e) = self.phase_threads().await {
                warn!("Phase 4 error: {}", e);
            }

            if self.cancel.is_cancelled() { break; }

            // Phase 5: Media Download
            self.emit_phase(SyncPhase::MediaDownload);
            if let Err(e) = self.phase_media().await {
                warn!("Phase 5 error: {}", e);
            }

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
            self.emit_tier_complete(0);

            info!("SyncEngine: cycle {} complete", cycle);

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

    /// Phase 1: Fetch own profile, contact list, and all own events.
    async fn phase_own_data(&self) -> Result<()> {
        self.sync_tier.store(1, Ordering::Relaxed);

        let pk = PublicKey::from_hex(&self.hex_pubkey)?;

        // Connect to configured relays
        self.pool.ensure_connected_many(&self.relay_urls).await;

        // Fetch own metadata + contacts
        let meta_filter = Filter::new()
            .author(pk)
            .kinds(vec![Kind::Metadata, Kind::ContactList, Kind::MuteList, Kind::RelayList])
            .limit(10);

        // Fetch all own events
        let events_filter = Filter::new()
            .author(pk)
            .kinds(vec![
                Kind::TextNote,
                Kind::Repost,
                Kind::Reaction,
                Kind::LongFormTextNote,
            ])
            .limit(1000);

        let events = self.pool.subscribe_and_collect(
            &self.relay_urls,
            vec![meta_filter, events_filter],
            30,
        ).await?;

        let (stored, wot) = processing::process_events(
            &events,
            &self.db,
            &self.graph,
            &self.hex_pubkey,
            EventSource::Sync,
        );

        self.emit_progress(1, stored as u64, events.len() as u64, "own");
        info!("Phase 1: {} events stored, {} WoT updates", stored, wot);

        self.emit_tier_complete(1);
        Ok(())
    }

    /// Phase 2: Discover relay information for follows.
    async fn phase_discovery(&self) -> Result<()> {
        self.sync_tier.store(2, Ordering::Relaxed);

        let discovery = Discovery::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
        );

        let stats = discovery.run().await?;
        info!(
            "Phase 2: {} local hints, {} bootstrapped, {} needing refresh",
            stats.local_hints, stats.bootstrap_relays, stats.needing_refresh
        );

        self.emit_tier_complete(2);
        Ok(())
    }

    /// Phase 3: Relay-centric content fetch.
    async fn phase_content(&self) -> Result<()> {
        self.sync_tier.store(3, Ordering::Relaxed);

        let discovery = Discovery::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
        );
        let needing_refresh = discovery.pubkeys_needing_relay_refresh()?;

        let content = ContentFetch::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
            self.sync_config.lookback_days,
        );

        let stats = content.run(&needing_refresh).await?;

        {
            let mut ss = self.sync_stats.write().await;
            ss.tier2_fetched += stats.events_stored as u64;
        }

        self.emit_progress(3, stats.events_stored as u64, 0, "content");
        info!(
            "Phase 3: {} events from {} relays",
            stats.events_stored, stats.relays_queried
        );

        self.emit_tier_complete(3);
        Ok(())
    }

    /// Phase 4: Fetch missing thread roots.
    async fn phase_threads(&self) -> Result<()> {
        let threads = ThreadContext::new(
            Arc::clone(&self.db),
            Arc::clone(&self.graph),
            Arc::clone(&self.pool),
            self.hex_pubkey.clone(),
        );

        let stats = threads.run(&self.relay_urls).await?;
        if stats.fetched > 0 {
            info!("Phase 4: {} of {} missing roots fetched", stats.fetched, stats.missing);
        }

        Ok(())
    }

    /// Phase 5: Download queued media.
    async fn phase_media(&self) -> Result<()> {
        self.sync_tier.store(4, Ordering::Relaxed);

        let media = MediaDownloader::new(
            Arc::clone(&self.db),
            self.hex_pubkey.clone(),
            self.storage_media_gb,
        );

        let stats = media.run(50).await?;
        if stats.downloaded > 0 {
            info!("Phase 5: {} downloaded, {} skipped", stats.downloaded, stats.skipped);
        }

        {
            let mut ss = self.sync_stats.write().await;
            ss.tier4_fetched += stats.downloaded as u64;
        }

        self.emit_tier_complete(4);
        Ok(())
    }

    /// Run tiered pruning.
    fn run_pruning(&self) -> Result<()> {
        let stats = pruning::run_pruning(&self.db, &self.graph, &self.hex_pubkey)?;
        if stats.total() > 0 {
            info!("Pruning: {} events deleted", stats.total());
        }
        Ok(())
    }

    /// WoT crawl — fetch contact lists for follows-of-follows.
    async fn phase_wot_crawl(&self) -> Result<()> {
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

    fn emit_phase(&self, phase: SyncPhase) {
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

    fn emit_tier_complete(&self, tier: u8) {
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
