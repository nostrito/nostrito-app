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
    fn new() -> Self {
        Self {
            last_request: None,
            min_interval: Duration::from_secs(3),
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
                .or_insert_with(RelayPolicy::new);

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
            self.db
                .store_event(
                    &event.id.to_hex(),
                    &event.pubkey.to_hex(),
                    event.created_at.as_u64() as i64,
                    event.kind.as_u16() as u32,
                    &tags_json,
                    &event.content.to_string(),
                    &event.sig.to_string(),
                )
                .ok();

            fetched += 1;
            self.emit_progress(1, fetched, 2, "");
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

    // ── Tier 2: Important ─────────────────────────────────────────
    // Fetch recent notes from follows. ONE persistent client per sync session.
    // Connect once, send all subscription batches on that connection with pauses,
    // disconnect once at the end.

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

        info!("Tier 2: {} follows to fetch", follows.len());

        let since = Timestamp::from(
            chrono::Utc::now()
                .checked_sub_signed(chrono::Duration::days(7))
                .unwrap()
                .timestamp() as u64,
        );

        let relay_urls = self.all_relay_urls();
        let total = follows.len() as u64;
        let mut fetched: u64 = 0;

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
        for (batch_idx, chunk) in follows.chunks(10).enumerate() {
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
                .kinds(vec![
                    Kind::Metadata,                  // 0 — profile pics + WoT
                    Kind::TextNote,                  // 1 — notes
                    Kind::ContactList,               // 3 — WoT depth
                    Kind::EncryptedDirectMessage,    // 4 — NIP-04 DMs
                    Kind::Repost,                    // 6
                    Kind::Reaction,                  // 7
                    Kind::ZapReceipt,                // 9735
                    Kind::LongFormTextNote,          // 30023
                ])
                .since(since)
                .limit(50);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(RelayPolicy::new);

            match subscribe_and_collect(&client, vec![filter], 10, policy).await {
                Ok(events) => {
                    for event in events.iter() {
                        // Store every event in DB
                        let tags: Vec<Vec<String>> = event
                            .tags
                            .iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        self.db
                            .store_event(
                                &event.id.to_hex(),
                                &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64,
                                event.kind.as_u16() as u32,
                                &tags_json,
                                &event.content.to_string(),
                                &event.sig.to_string(),
                            )
                            .ok();

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
                    debug!(
                        "Tier 2: batch {}: {} follows → {} events",
                        batch_idx + 1,
                        chunk.len(),
                        events.len(),
                    );
                }
                Err(e) => {
                    warn!("Tier 2: subscribe error on batch {}: {}", batch_idx + 1, e);
                    let policy = policies
                        .entry(policy_url.clone())
                        .or_insert_with(RelayPolicy::new);
                    policy.on_connection_failure();
                }
            }

            self.emit_progress(2, fetched, total, &policy_url);

            // Polite pause: 7 seconds between batches on the same connection
            tokio::time::sleep(Duration::from_secs(7)).await;
        }

        // Disconnect once at the end
        client.disconnect().await.ok();
        info!("Tier 2: Disconnected persistent client");

        {
            let mut stats = self.sync_stats.write().await;
            stats.tier2_fetched = fetched;
            stats.current_tier = 2;
        }

        self.emit_tier_complete(2);
        info!("Tier 2 complete: {} events fetched", fetched);

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
        for (batch_idx, chunk) in remaining.chunks(5).enumerate() {
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
                .limit(15);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(RelayPolicy::new);

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
                        self.db
                            .store_event(
                                &event.id.to_hex(),
                                &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64,
                                event.kind.as_u16() as u32,
                                &tags_json,
                                &event.content.to_string(),
                                &event.sig.to_string(),
                            )
                            .ok();

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
                        .or_insert_with(RelayPolicy::new);
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

            // Polite pause: 7 seconds between batches on the same connection
            tokio::time::sleep(Duration::from_secs(7)).await;
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

    // ── Tier 4: Archive ───────────────────────────────────────────

    async fn run_tier4(&self, _policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Archive);
        info!("Tier 4: Archive sync (media, historical, deep WoT)");

        // Tier 4 is a placeholder — media download, historical events, deep WoT
        // will be implemented as the storage layer matures.

        // TODO: Blossom media downloads
        // TODO: Historical events (older than 7 days)
        // TODO: Deep WoT (hop-3+ pubkeys)

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
