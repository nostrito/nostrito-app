use anyhow::Result;
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
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
// Polite relay access: max 1 request per 3 seconds per relay.
// Back off aggressively on NOTICE or connection failure.

struct RelayPolicy {
    last_request: Option<Instant>,
    min_interval: Duration,
    paused_until: Option<Instant>,
    consecutive_failures: u32,
    last_notice: Option<String>,
}

impl RelayPolicy {
    fn new(min_interval_secs: u64) -> Self {
        Self {
            last_request: None,
            min_interval: Duration::from_secs(min_interval_secs),
            paused_until: None,
            consecutive_failures: 0,
            last_notice: None,
        }
    }

    /// Wait until we're allowed to send the next request, respecting rate limits.
    async fn wait_for_slot(&mut self) {
        // Check pause (from NOTICE or failure backoff)
        if let Some(paused_until) = self.paused_until {
            let now = Instant::now();
            if now < paused_until {
                let wait = paused_until - now;
                info!("RelayPolicy: paused, waiting {:.1}s", wait.as_secs_f32());
                tokio::time::sleep(wait).await;
            }
            self.paused_until = None;
        }

        // Enforce minimum interval between requests
        if let Some(last) = self.last_request {
            let elapsed = last.elapsed();
            if elapsed < self.min_interval {
                let wait = self.min_interval - elapsed;
                tokio::time::sleep(wait).await;
            }
        }

        self.last_request = Some(Instant::now());
    }

    fn on_notice(&mut self, msg: &str) {
        let lower = msg.to_lowercase();
        self.last_notice = Some(msg.to_string());

        if lower.contains("rate") || lower.contains("limit") || lower.contains("too many")
            || lower.contains("slow down") || lower.contains("blocked")
        {
            warn!("Rate limit NOTICE from relay: {}", msg);
            // Pause for 90 seconds on rate limit
            self.paused_until = Some(Instant::now() + Duration::from_secs(90));
            // Also increase minimum interval for this relay
            self.min_interval = Duration::from_secs(5);
        } else {
            // Generic NOTICE — brief pause just in case
            info!("Relay NOTICE: {}", msg);
            self.paused_until = Some(Instant::now() + Duration::from_secs(5));
        }
    }

    fn on_connection_failure(&mut self) {
        self.consecutive_failures += 1;
        let backoff = match self.consecutive_failures {
            1 => 10,
            2 => 30,
            3 => 60,
            4 => 120,
            _ => 300,
        };
        self.paused_until = Some(Instant::now() + Duration::from_secs(backoff));
        warn!(
            "Connection failure #{}, backing off {}s",
            self.consecutive_failures, backoff
        );
    }

    fn on_success(&mut self) {
        self.consecutive_failures = 0;
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

// ── Subscribe + Collect Helper ─────────────────────────────────────
// All relay fetching goes through this: subscribe, collect events until
// EOSE or timeout, then unsubscribe. Handles NOTICE for rate limiting.

async fn subscribe_and_collect(
    client: &Client,
    filter: Vec<Filter>,
    timeout_secs: u64,
    policy: &mut RelayPolicy,
) -> Result<Vec<Event>> {
    // Respect rate limits before sending
    policy.wait_for_slot().await;

    let sub_id = client.subscribe(filter, None).await?.val;
    let mut notifications = client.notifications();
    let mut events: Vec<Event> = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(timeout_secs));
    tokio::pin!(deadline);

    let mut got_eose = false;

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(notification) => {
                        match notification {
                            RelayPoolNotification::Event { event, .. } => {
                                events.push(*event);
                            }
                            RelayPoolNotification::Message { message, .. } => {
                                match &message {
                                    RelayMessage::EndOfStoredEvents(_) => {
                                        got_eose = true;
                                        break;
                                    }
                                    RelayMessage::Notice { message: msg } => {
                                        policy.on_notice(msg);
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        warn!("Notification channel error: {}", e);
                        policy.on_connection_failure();
                        break;
                    }
                }
            }
            _ = &mut deadline => {
                warn!("Subscribe timeout after {}s, got {} events (no EOSE)", timeout_secs, events.len());
                break;
            }
        }
    }

    client.unsubscribe(sub_id).await;

    if got_eose || !events.is_empty() {
        policy.on_success();
    }

    debug!("Collected {} events (EOSE={})", events.len(), got_eose);
    Ok(events)
}

// ── Sync Config ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub lookback_days: u32,
    pub batch_size: u32,
    pub events_per_batch: u32,
    pub batch_pause_secs: u32,
    pub relay_min_interval_secs: u32,
    pub wot_batch_size: u32,
    pub wot_events_per_batch: u32,
    pub cycle_interval_secs: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            lookback_days: 7,
            batch_size: 10,
            events_per_batch: 50,
            batch_pause_secs: 7,
            relay_min_interval_secs: 3,
            wot_batch_size: 5,
            wot_events_per_batch: 15,
            cycle_interval_secs: 300,
        }
    }
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
    storage_media_gb: f64,
    storage_others_gb: f64,
    sync_config: SyncConfig,
    max_event_age_days: u32,
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
        storage_others_gb: f64,
        sync_config: SyncConfig,
        max_event_age_days: u32,
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
            storage_media_gb,
            storage_others_gb,
            sync_config,
            max_event_age_days,
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

        let min_interval = self.sync_config.relay_min_interval_secs as u64;

        let mut cycle: u64 = 0;

        loop {
            if self.cancel.is_cancelled() {
                break;
            }

            // Fresh relay policies each cycle — clears any accumulated backoff/rate-limit
            // state from the previous cycle so relays aren't permanently blocked.
            let mut relay_policies: HashMap<String, RelayPolicy> = HashMap::new();
            for url in self.all_relay_urls() {
                relay_policies.insert(url, RelayPolicy::new(min_interval));
            }

            info!("Sync cycle {} starting (fresh relay policies)", cycle);

            // Tier 1: Critical — always run (fast, own profile + follows)
            if !self.cancel.is_cancelled() {
                if let Err(e) = self.run_tier1(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 1 error: {}", cycle, e);
                }
            }

            // Tier 1.5: Metadata refresh — refresh profiles + contact lists for WoT peers
            // Run every 3 cycles to keep display names, avatars, and follows fresh
            if !self.cancel.is_cancelled() && cycle % 3 == 0 {
                info!("Sync cycle {}: Running Tier 1.5 (WoT metadata refresh)", cycle);
                if let Err(e) = self.run_metadata_refresh(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 1.5 error: {}", cycle, e);
                }
            }

            // Tier 2: Important — always run (incremental via sync cursor)
            if !self.cancel.is_cancelled() {
                if let Err(e) = self.run_tier2(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 2 error: {}", cycle, e);
                }
            }

            // Tier 3: Background — every 6 cycles (~30 min)
            if !self.cancel.is_cancelled() && cycle % 6 == 0 {
                info!("Sync cycle {}: Running Tier 3 (WoT crawl, every 6 cycles)", cycle);
                if let Err(e) = self.run_tier3(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 3 error: {}", cycle, e);
                }
            }

            // Tier 4: Archive (media backup) — every cycle
            if !self.cancel.is_cancelled() {
                info!("Sync cycle {}: Running Tier 4 (media backup)", cycle);
                if let Err(e) = self.run_tier4(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 4 error: {}", cycle, e);
                }
            }

            self.set_tier(SyncTier::Idle);
            info!("Sync cycle {} complete, waiting 5 minutes before next cycle", cycle);

            cycle += 1;

            // Wait 5 minutes before next cycle, but respect cancellation
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    info!("Sync engine cancelled during inter-cycle wait");
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(self.sync_config.cycle_interval_secs as u64)) => {}
            }
        }

        self.set_tier(SyncTier::Idle);
        info!("Sync engine stopped after {} cycles", cycle);
        Ok(())
    }

    // ── Tier 1: Critical ──────────────────────────────────────────
    // Stagger across relays: connect to one relay at a time, fetch, disconnect, wait.

    async fn run_tier1(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Critical);
        info!("Tier 1: Fetching own profile + follow list");

        let pk = PublicKey::from_hex(&self.hex_pubkey)?;
        let filter = Filter::new()
            .author(pk)
            .kinds(vec![Kind::Metadata, Kind::ContactList])
            .limit(10);

        info!(
            "Tier 1: Filter — authors=[{}…], kinds=[0,3], limit=10",
            &self.hex_pubkey[..12]
        );

        let mut fetched: u64 = 0;
        let mut all_events: Vec<Event> = Vec::new();
        let relay_urls = self.all_relay_urls();

        // Stagger: one relay at a time, 2s gap between relays
        for (i, url) in relay_urls.iter().enumerate() {
            if self.cancel.is_cancelled() {
                break;
            }

            self.emit_progress(1, fetched, 2, url);

            let policy = policies
                .entry(url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            let client = Client::default();
            match client.add_relay(url.as_str()).await {
                Ok(_) => {
                    info!("Tier 1: Connecting to relay {}/{}: {}", i + 1, relay_urls.len(), url);
                }
                Err(e) => {
                    warn!("Tier 1: Failed to add relay {}: {}", url, e);
                    policy.on_connection_failure();
                    continue;
                }
            }

            client.connect().await;
            // Let WebSocket handshake settle
            tokio::time::sleep(Duration::from_secs(2)).await;

            match subscribe_and_collect(&client, vec![filter.clone()], 15, policy).await {
                Ok(events) => {
                    info!("Tier 1: Got {} events from {}", events.len(), url);
                    for event in events {
                        // Deduplicate by event ID
                        if !all_events.iter().any(|e| e.id == event.id) {
                            all_events.push(event);
                        }
                    }
                }
                Err(e) => {
                    warn!("Tier 1: Subscribe failed on {}: {}", url, e);
                    policy.on_connection_failure();
                }
            }

            client.disconnect().await.ok();

            // Stagger gap between relays
            if i + 1 < relay_urls.len() {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }

            // Stop early if we already have both kind:0 and kind:3
            let has_metadata = all_events.iter().any(|e| e.kind == Kind::Metadata);
            let has_contacts = all_events.iter().any(|e| e.kind == Kind::ContactList);
            if has_metadata && has_contacts {
                info!("Tier 1: Got both profile and contact list, skipping remaining relays");
                break;
            }
        }

        info!("Tier 1: Processing {} total events", all_events.len());

        for event in all_events.iter() {
            if event.kind == Kind::ContactList {
                if let Some(update) = process_contact_event(event) {
                    self.graph.update_follows(
                        &update.pubkey,
                        &update.follows,
                        Some(update.event_id.clone()),
                        Some(update.created_at),
                    );

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

            // Store all events (metadata too)
            let tags: Vec<Vec<String>> = event
                .tags
                .iter()
                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                .collect();
            let tags_json = serde_json::to_string(&tags).unwrap_or_default();
            let inserted = self.db
                .store_event(
                    &event.id.to_hex(),
                    &event.pubkey.to_hex(),
                    event.created_at.as_u64() as i64,
                    event.kind.as_u16() as u32,
                    &tags_json,
                    &event.content.to_string(),
                    &event.sig.to_string(),
                )
                .unwrap_or(false);

            if inserted {
                self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
            }

            fetched += 1;
            self.emit_progress(1, fetched, 2, "");
        }

        // ── Tier 1b: Fetch ALL own events (full history backup) ──
        // We intentionally keep ALL kinds here (including reactions, zaps, DMs)
        // because this is the user's own event history — we want a complete backup
        // of everything they've published. The broader kind set only applies to
        // this user's pubkey, so it doesn't create noise in the feed.
        info!("Tier 1b: Fetching ALL own events (full history backup)");

        let all_own_filter = Filter::new()
            .author(pk)
            .kinds(vec![
                Kind::Metadata,               // 0
                Kind::TextNote,               // 1
                Kind::ContactList,            // 3
                Kind::EncryptedDirectMessage, // 4
                Kind::Repost,                 // 6
                Kind::Reaction,               // 7
                Kind::ZapReceipt,             // 9735
                Kind::LongFormTextNote,        // 30023
            ])
            // NO .since() — fetch everything from all time
            .limit(1000);

        for url in relay_urls.iter() {
            if self.cancel.is_cancelled() { break; }

            let policy = policies
                .entry(url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            let client = Client::default();
            if client.add_relay(url.as_str()).await.is_err() { continue; }
            client.connect().await;
            tokio::time::sleep(Duration::from_secs(2)).await;

            match subscribe_and_collect(&client, vec![all_own_filter.clone()], 30, policy).await {
                Ok(events) => {
                    info!("Tier 1b: Got {} own events from {}", events.len(), url);
                    for event in &events {
                        let tags: Vec<Vec<String>> = event.tags.iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        let inserted = self.db.store_event(
                            &event.id.to_hex(),
                            &event.pubkey.to_hex(),
                            event.created_at.as_u64() as i64,
                            event.kind.as_u16() as u32,
                            &tags_json,
                            &event.content.to_string(),
                            &event.sig.to_string(),
                        ).unwrap_or(false);
                        if inserted {
                            self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
                        }
                    }
                    fetched += events.len() as u64;
                    // Stop after first relay that gives us events
                    if !events.is_empty() { client.disconnect().await.ok(); break; }
                }
                Err(e) => warn!("Tier 1b: Failed on {}: {}", url, e),
            }

            client.disconnect().await.ok();
            tokio::time::sleep(Duration::from_secs(2)).await;
        }

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier1_fetched = fetched;
            stats.current_tier = 1;
        }

        self.emit_tier_complete(1);
        info!("Tier 1 complete: {} events fetched", fetched);
        Ok(())
    }

    // ── Tier 1.5: WoT Metadata Refresh ──────────────────────────
    // Refresh kind:0 (profiles) and kind:3 (contact lists) for all known
    // pubkeys in the WoT graph. Keeps display names, avatars, and follow
    // lists fresh without waiting for Tier 3's full crawl.

    async fn run_metadata_refresh(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        info!("Tier 1.5: Refreshing metadata for WoT peers");

        let wot_pubkeys = self.graph.all_pubkeys();
        if wot_pubkeys.is_empty() {
            info!("Tier 1.5: No pubkeys in WoT graph, skipping");
            return Ok(());
        }

        info!("Tier 1.5: {} pubkeys in WoT graph", wot_pubkeys.len());

        let relay_urls = self.all_relay_urls();

        // ONE persistent client for metadata refresh
        let client = Client::default();
        for url in &relay_urls {
            client.add_relay(url.as_str()).await.ok();
        }
        client.connect().await;
        tokio::time::sleep(Duration::from_secs(2)).await;

        let policy_url = relay_urls.first().cloned().unwrap_or_default();
        let mut total_fetched: u64 = 0;
        let mut total_new: u64 = 0;

        // Process in chunks of 50 pubkeys
        for (batch_idx, chunk) in wot_pubkeys.chunks(50).enumerate() {
            if self.cancel.is_cancelled() {
                break;
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
                .kinds(vec![Kind::Metadata, Kind::ContactList])
                .limit(100);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&client, vec![filter], 10, policy).await {
                Ok(events) => {
                    let mut batch_new: u64 = 0;

                    for event in &events {
                        let tags: Vec<Vec<String>> = event
                            .tags
                            .iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        let inserted = self.db
                            .store_event(
                                &event.id.to_hex(),
                                &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64,
                                event.kind.as_u16() as u32,
                                &tags_json,
                                &event.content.to_string(),
                                &event.sig.to_string(),
                            )
                            .unwrap_or(false);

                        if inserted {
                            batch_new += 1;
                        }

                        // Update WoT graph with fresh contact lists
                        if event.kind == Kind::ContactList {
                            if let Some(update) = process_contact_event(event) {
                                let updated = self.graph.update_follows(
                                    &update.pubkey,
                                    &update.follows,
                                    Some(update.event_id.clone()),
                                    Some(update.created_at),
                                );
                                if updated {
                                    let batch = vec![FollowUpdateBatch {
                                        pubkey: &update.pubkey,
                                        follows: &update.follows,
                                        event_id: Some(&update.event_id),
                                        created_at: Some(update.created_at),
                                    }];
                                    self.db.update_follows_batch(&batch).ok();
                                }
                            }
                        }
                    }

                    total_fetched += events.len() as u64;
                    total_new += batch_new;

                    if batch_idx % 10 == 0 && batch_idx > 0 {
                        info!(
                            "Tier 1.5: Progress — batch {}, {} events fetched ({} new)",
                            batch_idx + 1, total_fetched, total_new
                        );
                    }
                }
                Err(e) => {
                    warn!("Tier 1.5: subscribe error on batch {}: {}", batch_idx + 1, e);
                    let policy = policies
                        .entry(policy_url.clone())
                        .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));
                    policy.on_connection_failure();
                }
            }

            // Polite pause between batches
            tokio::time::sleep(Duration::from_secs(self.sync_config.batch_pause_secs as u64)).await;
        }

        client.disconnect().await.ok();
        info!(
            "Tier 1.5 complete: {} events fetched ({} new) for {} WoT pubkeys",
            total_fetched, total_new, wot_pubkeys.len()
        );

        // Cool-down before next tier
        if !self.cancel.is_cancelled() {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }

        Ok(())
    }

    // ── Tier 2: Important ─────────────────────────────────────────
    // Fetch recent notes from follows. ONE persistent client per sync session.
    // Connect once, send all subscription batches on that connection with pauses,
    // disconnect once at the end.

    async fn run_tier2(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Important);
        info!("Tier 2: Fetching recent events from follows");

        // ── Storage pruning: time-based event retention ──
        // Prune others' events older than max_event_age_days, respecting tracked profiles
        let max_age_secs = self.max_event_age_days as u64 * 86400;
        let pruned = self.db.prune_old_events(&self.hex_pubkey, max_age_secs).unwrap_or(0);
        if pruned > 0 {
            info!("Storage: pruned {} events older than {} days", pruned, self.max_event_age_days);
        }

        let follows = match self.graph.get_follows(&self.hex_pubkey) {
            Some(f) => f,
            None => {
                warn!("Tier 2: No follows found, skipping");
                self.emit_tier_complete(2);
                return Ok(());
            }
        };

        info!("Tier 2: Found {} follows in WoT graph", follows.len());
        if follows.is_empty() {
            warn!("Tier 2: Follows list is empty — Tier 1 may not have loaded contacts yet");
            self.emit_tier_complete(2);
            return Ok(());
        }

        // Use a wall-clock sync cursor for incremental sync.
        // Always look back at least `lookback_days` to catch events from newly
        // added WoT follows whose historical events haven't been fetched yet.
        let now_epoch = chrono::Utc::now().timestamp() as u64;
        let lookback_floor = now_epoch.saturating_sub(self.sync_config.lookback_days as u64 * 86400);

        let cursor = self.db.get_sync_cursor().unwrap_or(None);
        // Use the OLDER of (cursor - 60s) or (now - lookback_days)
        // This ensures we always look back at least lookback_days for newly added follows
        let since_ts = match cursor {
            Some(ts) => {
                let cursor_ts = ts.saturating_sub(60);
                let chosen = cursor_ts.min(lookback_floor); // use whichever is OLDER
                info!(
                    "Tier 2: cursor={}, lookback_floor={}, using since={} (older of both)",
                    ts, lookback_floor, chosen
                );
                chosen
            }
            None => {
                info!("Tier 2: No cursor, using lookback floor since={} ({}d ago)", lookback_floor, self.sync_config.lookback_days);
                lookback_floor
            }
        };

        let since = Timestamp::from(since_ts);

        info!(
            "Tier 2: since={} ({}), {} follow chunks of {}",
            since_ts,
            chrono::DateTime::from_timestamp(since_ts as i64, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| "?".into()),
            (follows.len() + self.sync_config.batch_size as usize - 1) / self.sync_config.batch_size as usize,
            self.sync_config.batch_size,
        );

        let relay_urls = self.all_relay_urls();
        let total = follows.len() as u64;
        let mut fetched: u64 = 0;
        let mut total_new: u64 = 0;
        let mut total_dupe: u64 = 0;
        let mut batches_processed: u64 = 0;

        // ONE persistent client for the entire tier
        let client = Client::default();
        for url in &relay_urls {
            if let Err(e) = client.add_relay(url.as_str()).await {
                warn!("Tier 2: Failed to add relay {}: {}", url, e);
            }
        }
        client.connect().await;
        // Let all WebSocket handshakes settle
        tokio::time::sleep(Duration::from_secs(3)).await;
        info!("Tier 2: Connected to {} relays (persistent session)", relay_urls.len());

        // Use a single policy for the shared client — pick the first relay for tracking
        let policy_url = relay_urls.first().cloned().unwrap_or_default();

        // Small batches: 10 follows at a time, limit 50 events per request
        for (batch_idx, chunk) in follows.chunks(self.sync_config.batch_size as usize).enumerate() {
            if self.cancel.is_cancelled() {
                break;
            }

            let authors: Vec<PublicKey> = chunk
                .iter()
                .filter_map(|hex| PublicKey::from_hex(hex).ok())
                .collect();

            if authors.is_empty() {
                continue;
            }

            // Only fetch meaningful content kinds from follows.
            // Excluded: kind 4 (DMs — own events only), kind 7 (reactions — noisy,
            // low value for feed), kind 9735 (zaps — noise). This keeps the event
            // store focused on actual content and WoT-relevant data.
            let filter = Filter::new()
                .authors(authors)
                .kinds(vec![
                    Kind::Metadata,           // 0 — profiles
                    Kind::TextNote,           // 1 — notes
                    Kind::ContactList,        // 3 — follows (for WoT)
                    Kind::Repost,             // 6 — reposts
                    Kind::LongFormTextNote,   // 30023 — articles
                ])
                .since(since)
                .limit(self.sync_config.events_per_batch as usize);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&client, vec![filter], 10, policy).await {
                Ok(events) => {
                    let mut batch_new: u64 = 0;
                    let mut batch_dupe: u64 = 0;

                    for event in events.iter() {
                        // Store every event in DB
                        let tags: Vec<Vec<String>> = event
                            .tags
                            .iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        let inserted = self.db
                            .store_event(
                                &event.id.to_hex(),
                                &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64,
                                event.kind.as_u16() as u32,
                                &tags_json,
                                &event.content.to_string(),
                                &event.sig.to_string(),
                            )
                            .unwrap_or(false);

                        if inserted {
                            batch_new += 1;
                            self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
                        } else {
                            batch_dupe += 1;
                        }

                        // Process kind:3 → update WoT graph with follows-of-follows
                        if event.kind == Kind::ContactList {
                            if let Some(update) = process_contact_event(event) {
                                let updated = self.graph.update_follows(
                                    &update.pubkey,
                                    &update.follows,
                                    Some(update.event_id.clone()),
                                    Some(update.created_at),
                                );
                                if updated {
                                    let batch = vec![FollowUpdateBatch {
                                        pubkey: &update.pubkey,
                                        follows: &update.follows,
                                        event_id: Some(&update.event_id),
                                        created_at: Some(update.created_at),
                                    }];
                                    self.db.update_follows_batch(&batch).ok();
                                    debug!(
                                        "Tier 2: Updated WoT for {} ({} follows)",
                                        &update.pubkey[..8],
                                        update.follows.len()
                                    );
                                }
                            }
                        }
                    }
                    fetched += events.len() as u64;
                    total_new += batch_new;
                    total_dupe += batch_dupe;
                    batches_processed += 1;
                    info!(
                        "Tier 2: batch {}: {} follows → {} events ({} new, {} dupe)",
                        batch_idx + 1,
                        chunk.len(),
                        events.len(),
                        batch_new,
                        batch_dupe,
                    );
                }
                Err(e) => {
                    warn!("Tier 2: subscribe error on batch {}: {}", batch_idx + 1, e);
                    let policy = policies
                        .entry(policy_url.clone())
                        .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));
                    policy.on_connection_failure();
                }
            }

            self.emit_progress(2, fetched, total, &policy_url);

            // Polite pause between batches on the same connection
            tokio::time::sleep(Duration::from_secs(self.sync_config.batch_pause_secs as u64)).await;
        }

        // Disconnect once at the end
        client.disconnect().await.ok();
        info!("Tier 2: Disconnected persistent client");

        // Only advance sync cursor if we actually processed batches and fetched events.
        // This prevents the cursor from racing ahead when relays return 0 events,
        // which would cause the next cycle to use a too-narrow since window.
        if batches_processed > 0 && total_new > 0 {
            let cursor_ts = chrono::Utc::now().timestamp() as u64;
            self.db.set_sync_cursor(cursor_ts.saturating_sub(60)).ok();
            info!(
                "Tier 2: Updated sync cursor to {} ({} new events across {} batches)",
                cursor_ts.saturating_sub(60), total_new, batches_processed
            );
        } else {
            info!(
                "Tier 2: Cursor NOT advanced (batches={}, new={}, dupe={}) — will retry same window next cycle",
                batches_processed, total_new, total_dupe
            );
        }

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier2_fetched = fetched;
            stats.current_tier = 2;
        }

        self.emit_tier_complete(2);
        info!(
            "Tier 2 complete: {} events fetched ({} new, {} dupe, {} batches)",
            fetched, total_new, total_dupe, batches_processed
        );

        // ── Historical backfill: fetch older events going backward in time ──
        if !self.cancel.is_cancelled() && !follows.is_empty() {
            let history_until = self.db.get_history_cursor().unwrap_or(None).unwrap_or_else(|| {
                // Default: start from lookback floor, go backward
                chrono::Utc::now().timestamp() as u64 - (self.sync_config.lookback_days as u64 * 86400)
            });

            let age_secs = now_epoch.saturating_sub(history_until);
            let age_days = age_secs / 86400;
            info!(
                "Tier 2: Historical backfill until={} (~{}d ago)",
                history_until, age_days
            );

            let authors: Vec<PublicKey> = follows.iter()
                .filter_map(|hex| PublicKey::from_hex(hex).ok())
                .collect();

            let hist_filter = Filter::new()
                .authors(authors)
                .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
                .until(Timestamp::from(history_until))
                .limit(500);

            // Use fresh client for historical fetch
            let hist_client = Client::default();
            for url in &relay_urls {
                hist_client.add_relay(url.as_str()).await.ok();
            }
            hist_client.connect().await;
            tokio::time::sleep(Duration::from_secs(2)).await;

            let hist_policy_url = relay_urls.first().cloned().unwrap_or_default();
            let hist_policy = policies
                .entry(hist_policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&hist_client, vec![hist_filter], 30, hist_policy).await {
                Ok(hist_events) if !hist_events.is_empty() => {
                    let mut oldest_ts = history_until;
                    let mut hist_new: u64 = 0;

                    for event in &hist_events {
                        let tags: Vec<Vec<String>> = event
                            .tags
                            .iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        let inserted = self.db
                            .store_event(
                                &event.id.to_hex(),
                                &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64,
                                event.kind.as_u16() as u32,
                                &tags_json,
                                &event.content.to_string(),
                                &event.sig.to_string(),
                            )
                            .unwrap_or(false);
                        if inserted {
                            hist_new += 1;
                            self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
                        }
                        let ts = event.created_at.as_u64();
                        if ts < oldest_ts {
                            oldest_ts = ts;
                        }
                    }

                    // Move cursor back
                    self.db.set_history_cursor(oldest_ts.saturating_sub(1)).ok();
                    info!(
                        "Tier 2: Historical: {} events ({} new), cursor now at {} (~{}d ago)",
                        hist_events.len(),
                        hist_new,
                        oldest_ts,
                        now_epoch.saturating_sub(oldest_ts) / 86400
                    );
                }
                Ok(_) => info!("Tier 2: Historical: no more events at this cursor position"),
                Err(e) => warn!("Tier 2: Historical fetch error: {}", e),
            }

            hist_client.disconnect().await.ok();
        }

        // Cool-down: give relays a break before Tier 3
        if !self.cancel.is_cancelled() {
            info!("Cooling down 10s before Tier 3...");
            tokio::time::sleep(Duration::from_secs(10)).await;
        }

        Ok(())
    }

    // ── Tier 3: Background ────────────────────────────────────────
    // WoT crawl. ONE persistent client per sync session.
    // Connect once, send all subscription batches, disconnect once.

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
            info!(
                "Tier 3: Resuming from checkpoint ({} already processed)",
                processed.len()
            );
        }

        let remaining: Vec<String> = follows
            .into_iter()
            .filter(|pk| !processed.contains(pk))
            .collect();

        info!("Tier 3: {} pubkeys remaining to crawl", remaining.len());

        let (persist_tx, persist_rx) = mpsc::channel::<FollowUpdate>(10000);
        let db = self.db.clone();
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            persistence_worker(db, persist_rx, cancel).await;
        });

        let relay_urls = self.all_relay_urls();
        let total = remaining.len() as u64;
        let mut fetched: u64 = 0;

        // ONE persistent client for the entire tier
        let client = Client::default();
        for url in &relay_urls {
            if let Err(e) = client.add_relay(url.as_str()).await {
                warn!("Tier 3: Failed to add relay {}: {}", url, e);
            }
        }
        client.connect().await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        info!("Tier 3: Connected to {} relays (persistent session)", relay_urls.len());

        let policy_url = relay_urls.first().cloned().unwrap_or_default();

        // Small batches: 5 pubkeys at a time
        for (batch_idx, chunk) in remaining.chunks(self.sync_config.wot_batch_size as usize).enumerate() {
            if self.cancel.is_cancelled() {
                break;
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
                .kinds(vec![Kind::Metadata, Kind::ContactList])
                .limit(self.sync_config.wot_events_per_batch as usize);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&client, vec![filter], 10, policy).await {
                Ok(events) => {
                    for event in events.iter() {
                        // Store every event in DB (metadata + contact lists)
                        let tags: Vec<Vec<String>> = event
                            .tags
                            .iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        let inserted = self.db
                            .store_event(
                                &event.id.to_hex(),
                                &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64,
                                event.kind.as_u16() as u32,
                                &tags_json,
                                &event.content.to_string(),
                                &event.sig.to_string(),
                            )
                            .unwrap_or(false);

                        if inserted {
                            self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
                        }

                        // Process kind:3 → update WoT graph
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
                Err(e) => {
                    warn!("Tier 3: subscribe error on batch {}: {}", batch_idx + 1, e);
                    let policy = policies
                        .entry(policy_url.clone())
                        .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));
                    policy.on_connection_failure();
                }
            }

            // Mark processed and checkpoint
            for pk in chunk {
                processed.insert(pk.clone());
            }

            // Checkpoint every 50 pubkeys
            if processed.len() % 50 == 0 {
                let checkpoint: String =
                    processed.iter().cloned().collect::<Vec<_>>().join(",");
                self.db
                    .set_config("sync_tier3_checkpoint", &checkpoint)
                    .ok();
            }

            self.emit_progress(3, fetched, total, &policy_url);

            // Polite pause between batches on the same connection
            tokio::time::sleep(Duration::from_secs(self.sync_config.batch_pause_secs as u64)).await;
        }

        // Disconnect once at the end
        client.disconnect().await.ok();
        info!("Tier 3: Disconnected persistent client");

        // Final checkpoint — clear on completion
        self.db.set_config("sync_tier3_checkpoint", "").ok();

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier3_fetched = fetched;
            stats.current_tier = 3;
        }

        self.emit_tier_complete(3);
        info!("Tier 3 complete: {} follow lists fetched", fetched);
        Ok(())
    }

    // ── Tier 4: Archive (Blossom Media Backup) ──────────────────

    async fn run_tier4(&self, _policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Archive);
        info!("Tier 4: Blossom media backup");

        let limit_bytes = (self.storage_media_gb * 1024.0 * 1024.0 * 1024.0) as u64;

        // 1. Enforce limit: evict LRU items if already over
        self.enforce_media_limit(limit_bytes).await;

        // 1b. Backfill: if queue is empty but events exist, scan existing events
        // and populate the media queue (one-time migration for events stored before
        // the media_queue table was added)
        let queue_count = self.db.media_queue_count().unwrap_or(0);
        if queue_count == 0 {
            let event_count = self.db.event_count().unwrap_or(0);
            if event_count > 0 {
                info!("Tier 4: media queue empty but {} events exist, backfilling...", event_count);
                let events = self.db.query_events(None, None, Some(&[1, 6, 30023]), None, None, 5000).unwrap_or_default();
                for (_id, pubkey, _created_at, _kind, tags_json, content, _sig) in &events {
                    self.queue_media_for_event(pubkey, content, tags_json);
                }
                info!("Tier 4: backfill complete, queue now has {} items", self.db.media_queue_count().unwrap_or(0));
            }
        }

        // 2. Drain media URLs from the queue (populated at event store time)
        let urls = self.db.dequeue_media_urls(500).unwrap_or_default();
        info!("Tier 4: {} media URLs dequeued for download", urls.len());

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("nostrito/0.1.0")
            .build()
            .unwrap_or_default();

        let mut downloaded: u64 = 0;
        let mut skipped: u64 = 0;
        let total = urls.len() as u64;

        for (url, pubkey) in urls.iter() {
            if self.cancel.is_cancelled() {
                break;
            }

            let is_own = pubkey == &self.hex_pubkey;

            // Only enforce storage limit for others' media — own media always downloads
            if !is_own {
                let used = self.db.media_others_bytes(&self.hex_pubkey).unwrap_or(u64::MAX);
                if used >= limit_bytes {
                    // Skip non-own media that exceeds limit, but keep going for own media
                    skipped += 1;
                    continue;
                }
            }

            // Use sha256 from URL path (Blossom) or sha256 of the URL string as cache key
            let hash = extract_sha256_from_url(url)
                .unwrap_or_else(|| sha256_of_string(url));

            if self.db.media_exists(&hash) {
                skipped += 1;
                continue;
            }

            // Download
            match self
                .download_media(&client, url, &hash, pubkey, limit_bytes, is_own)
                .await
            {
                Ok(true) => {
                    downloaded += 1;
                }
                Ok(false) => {
                    skipped += 1;
                }
                Err(e) => {
                    warn!("Tier 4: download failed for {}: {}", url, e);
                    skipped += 1;
                }
            }

            self.emit_progress(4, downloaded, total, url);

            // Polite: 500ms between downloads
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier4_fetched = downloaded;
            stats.current_tier = 4;
        }

        self.emit_tier_complete(4);
        info!(
            "Tier 4 complete: {} downloaded, {} skipped",
            downloaded, skipped
        );
        Ok(())
    }

    /// Queue media URLs found in a single event's content+tags for later download.
    fn queue_media_for_event(&self, pubkey: &str, content: &str, tags_json: &str) {
        for url in extract_urls_from_text(content) {
            let is_media = extract_sha256_from_url(&url).is_some()
                || mime_type_from_url(&url).is_some()
                || is_nostr_media_cdn(&url);
            if is_media {
                self.db.queue_media_url(&url, pubkey).ok();
            }
        }
        for url in extract_urls_from_tags(tags_json) {
            let is_media = extract_sha256_from_url(&url).is_some()
                || mime_type_from_url(&url).is_some()
                || is_nostr_media_cdn(&url);
            if is_media {
                self.db.queue_media_url(&url, pubkey).ok();
            }
        }
    }

    /// Extract media URLs from ALL own events (full history, no limit cap)
    #[allow(dead_code)]
    async fn extract_own_media_urls(&self) -> Vec<(String, String)> {
        let own_pubkey = vec![self.hex_pubkey.clone()];
        let events = self.db.query_events(
            None,
            Some(&own_pubkey),
            None,  // all kinds
            None,  // no since
            None,  // no until
            5000,  // large limit for own events
        ).unwrap_or_default();

        let mut urls = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for (_id, pubkey, _created_at, _kind, tags_json, content, _sig) in &events {
            // Extract from content text
            for url in extract_urls_from_text(content) {
                let is_media = extract_sha256_from_url(&url).is_some()
                    || mime_type_from_url(&url).is_some()
                    || is_nostr_media_cdn(&url);
                if is_media && seen.insert(url.clone()) {
                    urls.push((url, pubkey.clone()));
                }
            }
            // Extract from tags (imeta, url, r, image, thumb, media tags)
            for url in extract_urls_from_tags(tags_json) {
                let is_media = extract_sha256_from_url(&url).is_some()
                    || mime_type_from_url(&url).is_some()
                    || is_nostr_media_cdn(&url);
                if is_media && seen.insert(url.clone()) {
                    urls.push((url, pubkey.clone()));
                }
            }
        }

        urls
    }

    /// Extract media URLs from recent DB events (kinds 1, 6, 30023)
    #[allow(dead_code)]
    async fn extract_media_urls_from_events(&self, limit: u32) -> Vec<(String, String)> {
        let events = self
            .db
            .query_events(None, None, Some(&[1, 6, 30023]), None, None, limit)
            .unwrap_or_default();

        let mut urls: Vec<(String, String)> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for (_id, pubkey, _created_at, _kind, tags_json, content, _sig) in &events {
            // Extract from content text
            for url in extract_urls_from_text(content) {
                // Only include URLs with a Blossom sha256 hash, known media extension, or known CDN
                let is_media = extract_sha256_from_url(&url).is_some()
                    || mime_type_from_url(&url).is_some()
                    || is_nostr_media_cdn(&url);
                if is_media && seen.insert(url.clone()) {
                    urls.push((url, pubkey.clone()));
                }
            }
            // Extract from tags (imeta, url, r, image, thumb, media tags)
            for url in extract_urls_from_tags(tags_json) {
                let is_media = extract_sha256_from_url(&url).is_some()
                    || mime_type_from_url(&url).is_some()
                    || is_nostr_media_cdn(&url);
                if is_media && seen.insert(url.clone()) {
                    urls.push((url, pubkey.clone()));
                }
            }
        }

        urls
    }

    /// Download and store one media item. Returns Ok(true) if downloaded, Ok(false) if skipped.
    async fn download_media(
        &self,
        client: &reqwest::Client,
        url: &str,
        hash: &str,
        pubkey: &str,
        limit_bytes: u64,
        is_own: bool,
    ) -> Result<bool> {
        const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB hard cap

        // Try HEAD first to get size/type — but don't fail hard if HEAD not supported
        let content_length_hint: Option<u64>;
        let mime_hint: Option<String>;

        match client.head(url).send().await {
            Ok(head) if head.status().is_success() => {
                content_length_hint = head
                    .headers()
                    .get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                mime_hint = head
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());
            }
            _ => {
                // HEAD not supported or failed — proceed to GET without hints
                content_length_hint = None;
                mime_hint = None;
            }
        }

        // Pre-flight size check (if we have a hint) — skip limit checks for own media
        if let Some(cl) = content_length_hint {
            if cl > MAX_FILE_SIZE {
                debug!("Tier 4: skipping {} — too large ({} bytes)", url, cl);
                return Ok(false);
            }
            if !is_own {
                let current_used = self.db.media_total_bytes().unwrap_or(0);
                if current_used + cl > limit_bytes {
                    return Ok(false);
                }
            }
        }

        // GET the content
        let response = match client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                debug!("Tier 4: GET {} returned {}", url, r.status());
                return Ok(false);
            }
            Err(e) => {
                debug!("Tier 4: GET {} failed: {}", url, e);
                return Ok(false);
            }
        };

        // Determine MIME type from GET response headers or URL extension or CDN domain
        let response_mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());

        let mime = response_mime
            .or(mime_hint)
            .or_else(|| mime_type_from_url(url).map(|s| s.to_string()))
            .unwrap_or_else(|| {
                // For known CDN domains, assume image/jpeg if no type info
                if is_nostr_media_cdn(url) {
                    "image/jpeg".to_string()
                } else {
                    "application/octet-stream".to_string()
                }
            });

        // Only cache images and videos
        if !mime.starts_with("image/") && !mime.starts_with("video/") {
            debug!("Tier 4: skipping {} — mime={}", url, mime);
            return Ok(false);
        }

        // Download bytes
        let bytes = match response.bytes().await {
            Ok(b) => b,
            Err(e) => {
                debug!("Tier 4: failed to read body {}: {}", url, e);
                return Ok(false);
            }
        };
        let size_bytes = bytes.len() as u64;

        if size_bytes == 0 || size_bytes > MAX_FILE_SIZE {
            return Ok(false);
        }

        // Final size check against limit — own media always downloads
        if !is_own {
            let current_used = self.db.media_total_bytes().unwrap_or(0);
            if current_used + size_bytes > limit_bytes {
                return Ok(false);
            }
        }

        // Write to disk: ~/.nostrito/media/<hash[0..2]>/<hash>
        let file_path = media_file_path(hash);
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| anyhow::anyhow!(e))?;
        }
        tokio::fs::write(&file_path, &bytes).await.map_err(|e| anyhow::anyhow!(e))?;

        // Record in DB
        self.db
            .store_media_record(hash, url, &mime, size_bytes, pubkey)
            .map_err(|e| anyhow::anyhow!(e))?;

        debug!(
            "Tier 4: downloaded {} ({} bytes, {}) → {:?}",
            &hash[..12.min(hash.len())],
            size_bytes,
            mime,
            file_path
        );

        Ok(true)
    }

    /// Enforce media storage limit — evict LRU items if over 95% of limit.
    /// Only counts and evicts OTHERS' media — own media is never evicted.
    async fn enforce_media_limit(&self, limit_bytes: u64) {
        let used = match self.db.media_others_bytes(&self.hex_pubkey) {
            Ok(b) => b,
            Err(_) => return,
        };

        if used < (limit_bytes as f64 * 0.95) as u64 {
            return; // Under 95% — no eviction needed
        }

        let target = (limit_bytes as f64 * 0.80) as u64;
        info!(
            "Tier 4: Others' media over 95% ({} / {} bytes), evicting to 80%",
            used, limit_bytes
        );

        let candidates = self.db.media_list_lru_excluding_pubkey(500, &self.hex_pubkey).unwrap_or_default();
        let mut freed: u64 = 0;
        let mut evicted: Vec<String> = Vec::new();
        let mut current = used;

        for (hash, size) in candidates {
            if current <= target { break; }
            let path = media_file_path(&hash);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                warn!("Tier 4: failed to delete {:?}: {}", path, e);
            }
            evicted.push(hash);
            freed += size;
            current = current.saturating_sub(size);
        }

        if !evicted.is_empty() {
            self.db.media_delete_records(&evicted).ok();
            info!(
                "Tier 4: Evicted {} items, freed {} bytes (own media preserved)",
                evicted.len(), freed
            );
        }
    }
}

// ── Media Helpers ──────────────────────────────────────────────────

/// Blossom URLs contain a 64-char hex sha256 segment in the path.
/// Extract it if present.
/// Stable deterministic cache key for non-Blossom media URLs (FNV-1a, 64 hex chars).
fn sha256_of_string(s: &str) -> String {
    // Two-pass FNV-1a 64-bit — deterministic, no external crate, stable across runs
    const FNV_PRIME: u64 = 1099511628211;
    const FNV_BASIS: u64 = 14695981039346656037;
    let mut h1: u64 = FNV_BASIS;
    for b in s.bytes() {
        h1 ^= b as u64;
        h1 = h1.wrapping_mul(FNV_PRIME);
    }
    let mut h2: u64 = 0xcbf29ce484222325u64;
    for b in s.bytes().rev() {
        h2 ^= b as u64;
        h2 = h2.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}{:016x}{:032x}", h1, h2, 0u128)
}

/// Returns true if the URL is from a known Nostr media CDN
fn is_nostr_media_cdn(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("void.cat/d/")
        || lower.contains("nostr.build/")
        || lower.contains("image.nostr.build/")
        || lower.contains("i.nostr.build/")
        || lower.contains("cdn.nostr.build/")
        || lower.contains("media.nostr.band/")
        || lower.contains("nostrimg.com/")
        || lower.contains("nostpic.com/")
        || lower.contains("blossom.band/")
        || lower.contains("blossom.primal.net/")
        || lower.contains("files.v0l.io/")
        || lower.contains("nostr.mtrr.me/")
        || lower.contains("cdn.satellite.earth/")
        || lower.contains("primal.b-cdn.net/")
        || lower.contains("m.primal.net/")
        || lower.contains("media.tenor.com/")
        || lower.contains("i.imgur.com/")
        || lower.contains("pbs.twimg.com/")
        || lower.contains("video.twimg.com/")
        || lower.contains("cdn.zaprite.com/")
}

fn extract_sha256_from_url(url: &str) -> Option<String> {
    let path = url.split('?').next()?;
    for segment in path.split('/') {
        let stem = segment.split('.').next().unwrap_or(segment);
        if stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(stem.to_lowercase());
        }
    }
    None
}

/// Detect MIME type from URL file extension
fn mime_type_from_url(url: &str) -> Option<&'static str> {
    let path = url.split('?').next().unwrap_or(url).to_lowercase();
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        return Some("image/jpeg");
    }
    if path.ends_with(".png") {
        return Some("image/png");
    }
    if path.ends_with(".gif") {
        return Some("image/gif");
    }
    if path.ends_with(".webp") {
        return Some("image/webp");
    }
    if path.ends_with(".mp4") {
        return Some("video/mp4");
    }
    if path.ends_with(".webm") {
        return Some("video/webm");
    }
    if path.ends_with(".mov") {
        return Some("video/quicktime");
    }
    if path.ends_with(".mp3") {
        return Some("audio/mpeg");
    }
    if path.ends_with(".ogg") {
        return Some("audio/ogg");
    }
    if path.ends_with(".wav") {
        return Some("audio/wav");
    }
    None
}

/// Extract media URLs from Nostr event tags (JSON array of arrays).
/// Handles: imeta (with "url" key-value), url, r, image, thumb, media tag types.
fn extract_urls_from_tags(tags_json: &str) -> Vec<String> {
    let mut urls = Vec::new();

    // Parse tags as JSON array of arrays: [["tag", "val1", "val2"], ...]
    let parsed: Result<Vec<Vec<String>>, _> = serde_json::from_str(tags_json);
    let tags = match parsed {
        Ok(t) => t,
        Err(_) => return urls,
    };

    for tag in &tags {
        if tag.is_empty() {
            continue;
        }
        let tag_name = tag[0].as_str();
        match tag_name {
            "imeta" => {
                // imeta tags: ["imeta", "url https://...", "m image/jpeg", "dim 1920x1080", ...]
                // Each element after the tag name is "key value" or "key value1 value2"
                for element in &tag[1..] {
                    let trimmed = element.trim();
                    if let Some(url_val) = trimmed.strip_prefix("url ") {
                        let url = url_val.trim();
                        if url.starts_with("http://") || url.starts_with("https://") {
                            urls.push(url.to_string());
                        }
                    }
                }
            }
            "url" | "r" | "image" | "thumb" | "media" => {
                // Simple tags: ["url", "https://..."] or ["r", "https://..."]
                if tag.len() >= 2 {
                    let val = tag[1].trim();
                    if val.starts_with("http://") || val.starts_with("https://") {
                        urls.push(val.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    urls
}

/// Extract URLs from text content (simple scanner, no regex crate needed)
fn extract_urls_from_text(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut i = 0;
    let bytes = text.as_bytes();

    while i < bytes.len() {
        // Look for http:// or https://
        let remaining = &text[i..];
        let start = if remaining.starts_with("https://") {
            Some(i)
        } else if remaining.starts_with("http://") {
            Some(i)
        } else {
            None
        };

        if let Some(start) = start {
            // Collect until whitespace, quote, bracket, or end
            let mut end = start;
            for &b in &bytes[start..] {
                if b == b' '
                    || b == b'\n'
                    || b == b'\r'
                    || b == b'\t'
                    || b == b'"'
                    || b == b'\''
                    || b == b'<'
                    || b == b'>'
                    || b == b']'
                    || b == b')'
                {
                    break;
                }
                end += 1;
            }
            if end > start + 10 {
                urls.push(text[start..end].to_string());
            }
            i = end;
        } else {
            i += 1;
        }
    }

    urls
}

/// Media file path: ~/.nostrito/media/<hash[0..2]>/<hash>
fn media_file_path(hash: &str) -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".nostrito/media")
        .join(&hash[..2])
        .join(hash)
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
