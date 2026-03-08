use anyhow::Result;
use nostr_sdk::prelude::*;
use nostr_sdk::client::options::EventSource;
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::{mpsc, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::storage::{Database, FollowUpdateBatch};
use crate::wot::WotGraph;

// ── Tier Definitions ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum SyncTier {
    Idle = 0,
    Critical = 1,    // your profile + your follows
    Important = 2,   // recent events from your follows
    Background = 3,  // WoT crawl (follows-of-follows)
    Archive = 4,     // media, historical, deep WoT
}

impl From<u8> for SyncTier {
    fn from(v: u8) -> Self {
        match v {
            1 => SyncTier::Critical,
            2 => SyncTier::Important,
            3 => SyncTier::Background,
            4 => SyncTier::Archive,
            _ => SyncTier::Idle,
        }
    }
}

// ── Sync Progress Events ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub tier: u8,
    pub fetched: u64,
    pub total: u64,
    pub relay: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierComplete {
    pub tier: u8,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncStats {
    pub tier1_fetched: u64,
    pub tier2_fetched: u64,
    pub tier3_fetched: u64,
    pub tier4_fetched: u64,
    pub current_tier: u8,
}

// ── Relay Policy ───────────────────────────────────────────────────

#[allow(dead_code)]
struct RelayPolicy {
    requests_per_minute: u32,
    backoff_secs: u64,
    last_notice: Option<String>,
    request_times: Vec<Instant>,
    paused_until: Option<Instant>,
    consecutive_failures: u32,
}

#[allow(dead_code)]
impl RelayPolicy {
    fn new() -> Self {
        Self {
            requests_per_minute: 10,
            backoff_secs: 5,
            last_notice: None,
            request_times: Vec::new(),
            paused_until: None,
            consecutive_failures: 0,
        }
    }

    fn can_request(&mut self) -> bool {
        if let Some(paused_until) = self.paused_until {
            if Instant::now() < paused_until {
                return false;
            }
            self.paused_until = None;
        }

        let now = Instant::now();
        let one_min_ago = now - Duration::from_secs(60);
        self.request_times.retain(|&t| t > one_min_ago);
        self.request_times.len() < self.requests_per_minute as usize
    }

    fn record_request(&mut self) {
        self.request_times.push(Instant::now());
    }

    fn on_notice(&mut self, msg: &str) {
        let lower = msg.to_lowercase();
        if lower.contains("rate") || lower.contains("limit") {
            info!("Rate limit notice from relay, pausing 60s");
            self.paused_until = Some(Instant::now() + Duration::from_secs(60));
        }
        self.last_notice = Some(msg.to_string());
    }

    fn on_connection_failure(&mut self) {
        self.consecutive_failures += 1;
        let backoff = match self.consecutive_failures {
            1 => 5,
            2 => 10,
            3 => 30,
            4 => 60,
            5 => 120,
            _ => 300,
        };
        self.backoff_secs = backoff;
        self.paused_until = Some(Instant::now() + Duration::from_secs(backoff));
        warn!(
            "Connection failure #{}, backing off {}s",
            self.consecutive_failures, backoff
        );
    }

    fn on_connection_success(&mut self) {
        self.consecutive_failures = 0;
        self.backoff_secs = 5;
    }
}

// ── Relay URL Resolution ───────────────────────────────────────────

fn resolve_relay_url(alias: &str) -> &str {
    match alias {
        "primal" => "wss://relay.primal.net",
        "damus" => "wss://relay.damus.io",
        "nos" => "wss://relay.nos.social",
        "snort" => "wss://relay.snort.social",
        "coracle" => "wss://relay.coracle.social",
        "nostr.wine" => "wss://nostr.wine",
        "amethyst" => "wss://nostr.band",
        "yakihonne" => "wss://relay.yakihonne.com",
        _ => alias,
    }
}

// ── Internal Types ─────────────────────────────────────────────────

#[derive(Debug)]
struct FollowUpdate {
    pubkey: String,
    follows: Vec<String>,
    event_id: String,
    created_at: i64,
}

// ── Sync Engine ────────────────────────────────────────────────────

pub struct SyncEngine {
    graph: Arc<WotGraph>,
    db: Arc<Database>,
    relay_aliases: Vec<String>,
    cancel: CancellationToken,
    hex_pubkey: String,
    pub sync_tier: Arc<AtomicU8>,
    pub sync_stats: Arc<RwLock<SyncStats>>,
    app_handle: tauri::AppHandle,
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
    ) -> Self {
        Self {
            graph,
            db,
            relay_aliases,
            cancel: CancellationToken::new(),
            hex_pubkey,
            sync_tier,
            sync_stats,
            app_handle,
        }
    }

    /// Start sync as a background task. Returns a cancellation token to stop it.
    pub fn start(self: Arc<Self>) -> CancellationToken {
        let cancel = self.cancel.clone();

        tokio::spawn(async move {
            if let Err(e) = self.run().await {
                error!("Sync engine error: {}", e);
            }
        });

        cancel
    }

    /// Stop the sync engine
    #[allow(dead_code)]
    pub fn stop(&self) {
        self.cancel.cancel();
    }

    fn set_tier(&self, tier: SyncTier) {
        self.sync_tier.store(tier as u8, Ordering::Relaxed);
    }

    fn primary_relay_url(&self) -> String {
        self.relay_aliases
            .first()
            .map(|a| resolve_relay_url(a).to_string())
            .unwrap_or_else(|| "wss://relay.damus.io".to_string())
    }

    fn all_relay_urls(&self) -> Vec<String> {
        self.relay_aliases
            .iter()
            .map(|a| resolve_relay_url(a).to_string())
            .collect()
    }

    fn emit_progress(&self, tier: u8, fetched: u64, total: u64, relay: &str) {
        self.app_handle
            .emit(
                "sync:progress",
                SyncProgress {
                    tier,
                    fetched,
                    total,
                    relay: relay.to_string(),
                },
            )
            .ok();
    }

    fn emit_tier_complete(&self, tier: u8) {
        self.app_handle
            .emit("sync:tier_complete", TierComplete { tier })
            .ok();
    }

    async fn run(&self) -> Result<()> {
        info!(
            "Starting tiered sync from {} relays for pubkey {}",
            self.relay_aliases.len(),
            &self.hex_pubkey[..8]
        );

        let mut relay_policies: HashMap<String, RelayPolicy> = HashMap::new();
        for url in self.all_relay_urls() {
            relay_policies.insert(url, RelayPolicy::new());
        }

        // Tier 1: Critical
        if !self.cancel.is_cancelled() {
            self.run_tier1(&mut relay_policies).await?;
        }

        // Tier 2: Important
        if !self.cancel.is_cancelled() {
            self.run_tier2(&mut relay_policies).await?;
        }

        // Tier 3: Background
        if !self.cancel.is_cancelled() {
            self.run_tier3(&mut relay_policies).await?;
        }

        // Tier 4: Archive
        if !self.cancel.is_cancelled() {
            self.run_tier4(&mut relay_policies).await?;
        }

        self.set_tier(SyncTier::Idle);
        info!("All sync tiers complete");
        Ok(())
    }

    // ── Tier 1: Critical ──────────────────────────────────────────

    async fn run_tier1(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Critical);
        info!("Tier 1: Fetching own profile + follow list");

        let primary = self.primary_relay_url();
        let client = Client::default();

        // Connect to all relays for Tier 1 (profile + follows are critical)
        let mut connected_any = false;
        for url in self.all_relay_urls() {
            match client.add_relay(&url).await {
                Ok(_) => {
                    info!("Tier 1: Added relay {}", url);
                    if let Some(policy) = policies.get_mut(&url) {
                        policy.on_connection_success();
                    }
                    connected_any = true;
                }
                Err(e) => {
                    warn!("Tier 1: Failed to add relay {}: {}", url, e);
                    if let Some(policy) = policies.get_mut(&url) {
                        policy.on_connection_failure();
                    }
                }
            }
        }

        if !connected_any {
            warn!("Tier 1: Could not add any relay, skipping");
            return Ok(());
        }

        client.connect().await;

        // Give relay connections time to establish before querying
        tokio::time::sleep(Duration::from_secs(2)).await;

        let pk = PublicKey::from_hex(&self.hex_pubkey)?;
        info!("Tier 1: Querying {} for pubkey {}", primary, pk.to_hex());

        // Fetch kind:0 (profile metadata) + kind:3 (follow list)
        let filter = Filter::new()
            .author(pk)
            .kinds(vec![Kind::Metadata, Kind::ContactList])
            .limit(10);

        let mut fetched: u64 = 0;
        self.emit_progress(1, 0, 2, &primary);

        match tokio::time::timeout(
            Duration::from_secs(20),
            client.get_events_of(vec![filter], EventSource::relays(Some(Duration::from_secs(15)))),
        )
        .await
        {
            Ok(Ok(events)) => {
                for event in events.iter() {
                    if event.kind == Kind::ContactList {
                        if let Some(update) = process_contact_event(event) {
                            self.graph.update_follows(
                                &update.pubkey,
                                &update.follows,
                                Some(update.event_id.clone()),
                                Some(update.created_at),
                            );

                            // Persist
                            let batch = vec![FollowUpdateBatch {
                                pubkey: &update.pubkey,
                                follows: &update.follows,
                                event_id: Some(&update.event_id),
                                created_at: Some(update.created_at),
                            }];
                            self.db.update_follows_batch(&batch).ok();

                            info!(
                                "Tier 1: Loaded {} follows from own contact list",
                                update.follows.len()
                            );
                        }
                    }
                    fetched += 1;
                    self.emit_progress(1, fetched, 2, &primary);
                }
            }
            Ok(Err(e)) => warn!("Tier 1: fetch error: {}", e),
            Err(_) => warn!("Tier 1: timeout fetching profile"),
        }

        client.disconnect().await?;

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier1_fetched = fetched;
            stats.current_tier = 1;
        }

        self.emit_tier_complete(1);
        info!("Tier 1 complete: {} events fetched", fetched);
        Ok(())
    }

    // ── Tier 2: Important ─────────────────────────────────────────

    async fn run_tier2(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Important);
        info!("Tier 2: Fetching recent events from follows");

        let follows = match self.graph.get_follows(&self.hex_pubkey) {
            Some(f) => f,
            None => {
                warn!("Tier 2: No follows found, skipping");
                self.emit_tier_complete(2);
                return Ok(());
            }
        };

        let primary = self.primary_relay_url();
        let client = Client::default();
        for url in self.all_relay_urls() {
            if let Err(e) = client.add_relay(&url).await {
                warn!("Tier 2: Failed to add relay {}: {}", url, e);
            }
        }
        client.connect().await;

        let since = Timestamp::from(
            chrono::Utc::now()
                .checked_sub_signed(chrono::Duration::days(7))
                .unwrap()
                .timestamp() as u64,
        );

        let total = follows.len() as u64;
        let mut fetched: u64 = 0;

        // Process 20 pubkeys per batch
        for chunk in follows.chunks(20) {
            if self.cancel.is_cancelled() {
                break;
            }

            // Rate limit check
            if let Some(policy) = policies.get_mut(&primary) {
                while !policy.can_request() {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if self.cancel.is_cancelled() {
                        break;
                    }
                }
                policy.record_request();
            }

            let authors: Vec<PublicKey> = chunk
                .iter()
                .filter_map(|hex| PublicKey::from_hex(hex).ok())
                .collect();

            if authors.is_empty() {
                continue;
            }

            let filter = Filter::new()
                .authors(authors)
                .kind(Kind::TextNote)
                .since(since)
                .limit(500);

            match tokio::time::timeout(
                Duration::from_secs(10),
                client.get_events_of(vec![filter], EventSource::relays(Some(Duration::from_secs(10)))),
            )
            .await
            {
                Ok(Ok(events)) => {
                    for event in events.iter() {
                        let tags_json = serde_json::to_string(
                            &event.tags.iter().map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<_>>()).collect::<Vec<_>>()
                        ).unwrap_or_default();
                        self.db.store_event(
                            &event.id.to_hex(),
                            &event.pubkey.to_hex(),
                            event.created_at.as_u64() as i64,
                            event.kind.as_u16() as u32,
                            &tags_json,
                            &event.content.to_string(),
                            &event.sig.to_string(),
                        ).ok();
                    }
                    fetched += events.len() as u64;
                    debug!("Tier 2: batch fetched and stored {} events", events.len());
                }
                Ok(Err(e)) => {
                    warn!("Tier 2: fetch error: {}", e);
                    if let Some(policy) = policies.get_mut(&primary) {
                        policy.on_connection_failure();
                    }
                }
                Err(_) => {
                    warn!("Tier 2: timeout on batch");
                }
            }

            self.emit_progress(2, fetched, total, &primary);

            // Polite pause between batches
            tokio::time::sleep(Duration::from_millis(300)).await;
        }

        client.disconnect().await?;

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier2_fetched = fetched;
            stats.current_tier = 2;
        }

        self.emit_tier_complete(2);
        info!("Tier 2 complete: {} events fetched", fetched);
        Ok(())
    }

    // ── Tier 3: Background ────────────────────────────────────────

    async fn run_tier3(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Background);
        info!("Tier 3: WoT crawl — fetching follows-of-follows");

        let follows = match self.graph.get_follows(&self.hex_pubkey) {
            Some(f) => f,
            None => {
                warn!("Tier 3: No follows found, skipping");
                self.emit_tier_complete(3);
                return Ok(());
            }
        };

        // Check checkpoint: which pubkeys have we already crawled?
        let mut processed: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(Some(checkpoint)) = self.db.get_config("sync_tier3_checkpoint") {
            for pk in checkpoint.split(',') {
                if !pk.is_empty() {
                    processed.insert(pk.to_string());
                }
            }
            info!("Tier 3: Resuming from checkpoint ({} already processed)", processed.len());
        }

        let remaining: Vec<String> = follows
            .into_iter()
            .filter(|pk| !processed.contains(pk))
            .collect();

        let primary = self.primary_relay_url();
        let client = Client::default();
        for url in self.all_relay_urls() {
            client.add_relay(&url).await.ok();
        }
        client.connect().await;

        let (persist_tx, persist_rx) = mpsc::channel::<FollowUpdate>(10000);
        let db = self.db.clone();
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            persistence_worker(db, persist_rx, cancel).await;
        });

        let total = remaining.len() as u64;
        let mut fetched: u64 = 0;

        // Process 10 pubkeys per batch
        for chunk in remaining.chunks(10) {
            if self.cancel.is_cancelled() {
                break;
            }

            // Rate limit
            if let Some(policy) = policies.get_mut(&primary) {
                while !policy.can_request() {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if self.cancel.is_cancelled() {
                        break;
                    }
                }
                policy.record_request();
            }

            let authors: Vec<PublicKey> = chunk
                .iter()
                .filter_map(|hex| PublicKey::from_hex(hex).ok())
                .collect();

            if authors.is_empty() {
                continue;
            }

            let filter = Filter::new()
                .authors(authors)
                .kind(Kind::ContactList)
                .limit(10);

            match tokio::time::timeout(
                Duration::from_secs(10),
                client.get_events_of(vec![filter], EventSource::relays(Some(Duration::from_secs(10)))),
            )
            .await
            {
                Ok(Ok(events)) => {
                    for event in events.iter() {
                        if let Some(update) = process_contact_event(event) {
                            let updated = self.graph.update_follows(
                                &update.pubkey,
                                &update.follows,
                                Some(update.event_id.clone()),
                                Some(update.created_at),
                            );
                            if updated {
                                fetched += 1;
                                persist_tx.try_send(update).ok();
                            }
                        }
                    }
                }
                Ok(Err(e)) => {
                    warn!("Tier 3: fetch error: {}", e);
                    if let Some(policy) = policies.get_mut(&primary) {
                        policy.on_connection_failure();
                    }
                }
                Err(_) => {
                    warn!("Tier 3: timeout on batch");
                }
            }

            // Mark processed and checkpoint
            for pk in chunk {
                processed.insert(pk.clone());
            }

            // Checkpoint every 50 pubkeys
            if processed.len() % 50 == 0 {
                let checkpoint: String = processed.iter().cloned().collect::<Vec<_>>().join(",");
                self.db.set_config("sync_tier3_checkpoint", &checkpoint).ok();
            }

            self.emit_progress(3, fetched, total, &primary);

            // Polite pause — 2 seconds between batches
            tokio::time::sleep(Duration::from_secs(2)).await;
        }

        // Final checkpoint
        self.db.set_config("sync_tier3_checkpoint", "").ok(); // clear on completion

        client.disconnect().await?;

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier3_fetched = fetched;
            stats.current_tier = 3;
        }

        self.emit_tier_complete(3);
        info!("Tier 3 complete: {} follow lists fetched", fetched);
        Ok(())
    }

    // ── Tier 4: Archive ───────────────────────────────────────────

    async fn run_tier4(&self, _policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Archive);
        info!("Tier 4: Archive sync (media, historical, deep WoT)");

        // Tier 4 is a placeholder — media download, historical events, deep WoT
        // will be implemented as the storage layer matures.
        // For now, emit completion.

        // TODO: Blossom media downloads
        // TODO: Historical events (older than 7 days)
        // TODO: Deep WoT (hop-3+ pubkeys)

        // Simulate slow background work with 5s pauses
        let fetched: u64 = 0;
        self.emit_progress(4, fetched, 0, "");

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier4_fetched = fetched;
            stats.current_tier = 4;
        }

        self.emit_tier_complete(4);
        info!("Tier 4 complete (stub): {} items processed", fetched);
        Ok(())
    }
}

// ── Helpers ────────────────────────────────────────────────────────

fn process_contact_event(event: &Event) -> Option<FollowUpdate> {
    if event.kind != Kind::ContactList {
        return None;
    }

    let pubkey = event.pubkey.to_hex();
    let event_id = event.id.to_hex();
    let created_at = event.created_at.as_u64() as i64;

    let follows: Vec<String> = event
        .tags
        .iter()
        .filter_map(|tag| {
            let tag_vec = tag.as_slice();
            if tag_vec.len() >= 2 && tag_vec[0] == "p" {
                let pk = &tag_vec[1];
                if pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()) {
                    Some(pk.to_string())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    debug!(
        "Processed contact list from {} with {} follows",
        &pubkey[..8],
        follows.len()
    );

    Some(FollowUpdate {
        pubkey,
        follows,
        event_id,
        created_at,
    })
}

async fn persistence_worker(
    db: Arc<Database>,
    mut rx: mpsc::Receiver<FollowUpdate>,
    cancel: CancellationToken,
) {
    info!("Persistence worker started");

    let mut batch: Vec<FollowUpdate> = Vec::with_capacity(100);
    let mut last_flush = Instant::now();

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                if !batch.is_empty() {
                    flush_batch(&db, &mut batch).await;
                }
                info!("Persistence worker shutting down");
                break;
            }
            Some(update) = rx.recv() => {
                batch.push(update);
                if batch.len() >= 100 || last_flush.elapsed() > Duration::from_secs(5) {
                    flush_batch(&db, &mut batch).await;
                    last_flush = Instant::now();
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if !batch.is_empty() {
                    flush_batch(&db, &mut batch).await;
                    last_flush = Instant::now();
                }
            }
        }
    }
}

async fn flush_batch(db: &Database, batch: &mut Vec<FollowUpdate>) {
    if batch.is_empty() {
        return;
    }

    debug!("Flushing {} updates to database", batch.len());

    let updates: Vec<FollowUpdateBatch<'_>> = batch
        .iter()
        .map(|u| FollowUpdateBatch {
            pubkey: &u.pubkey,
            follows: &u.follows,
            event_id: Some(&u.event_id),
            created_at: Some(u.created_at),
        })
        .collect();

    match db.update_follows_batch(&updates) {
        Ok(count) => debug!("Persisted {} updates in single transaction", count),
        Err(e) => error!("Failed to persist follow batch: {}", e),
    }

    batch.clear();
}
