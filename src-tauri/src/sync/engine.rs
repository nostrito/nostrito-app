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

/// Hardcoded default relays — used as fallback when no relays are configured or
/// all configured relays fail to connect. These should always be reachable.
const DEFAULT_RELAYS: &[&str] = &[
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
];

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
    pub tracked_fetched: u64,
    pub tier2_fetched: u64,
    pub tier3_fetched: u64,
    pub tier4_fetched: u64,
    pub current_tier: u8,
    /// Conceptual layer currently executing: "0", "0.5", "1", "2", "3", or "" (idle)
    pub current_layer: String,
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

/// Resolve a relay alias (e.g. "primal") to its canonical wss:// URL.
/// Returns the input unchanged if it's already a URL or unknown alias.
pub fn resolve_relay_url(alias: &str) -> &str {
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
    expected_eose: usize,
) -> Result<Vec<Event>> {
    // Respect rate limits before sending
    policy.wait_for_slot().await;

    // Create notification receiver BEFORE subscribing so we don't miss
    // events or EOSE that the relay sends immediately after receiving REQ.
    let mut notifications = client.notifications();
    let sub_id = client.subscribe(filter, None).await?.val;
    let mut events: Vec<Event> = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(timeout_secs));
    tokio::pin!(deadline);

    let mut got_eose = false;
    let mut eose_count: usize = 0;
    let expected = expected_eose.max(1);

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(notification) => {
                        match notification {
                            RelayPoolNotification::Event { event, subscription_id: ref evt_sid, .. } => {
                                // Only collect events for OUR subscription
                                if *evt_sid == sub_id {
                                    events.push(*event);
                                }
                            }
                            RelayPoolNotification::Message { message, .. } => {
                                match &message {
                                    RelayMessage::EndOfStoredEvents(eose_sid) => {
                                        // Only count EOSE for OUR subscription — ignore stale
                                        // EOSE from previous (unsubscribed) subscriptions that
                                        // arrived late on the broadcast channel.
                                        if *eose_sid != sub_id {
                                            debug!("Ignoring stale EOSE for sub {}, ours is {}", eose_sid, sub_id);
                                            continue;
                                        }
                                        eose_count += 1;
                                        if eose_count >= expected {
                                            // All relays have finished — we have everything
                                            got_eose = true;
                                            break;
                                        }
                                        // First EOSE but more relays pending: shorten deadline
                                        // to 3 seconds so we don't wait the full timeout but
                                        // still give slower relays a chance to send events.
                                        if eose_count == 1 {
                                            deadline.as_mut().reset(
                                                tokio::time::Instant::now() + Duration::from_secs(3)
                                            );
                                        }
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
                if eose_count > 0 {
                    // Got EOSE from some relays, drain period expired for the rest
                    got_eose = true;
                    debug!("Drain timeout: EOSE from {}/{} relays, {} events", eose_count, expected, events.len());
                } else {
                    warn!("Subscribe timeout after {}s, got {} events (no EOSE from any relay)", timeout_secs, events.len());
                }
                break;
            }
        }
    }

    client.unsubscribe(sub_id).await;

    if got_eose || !events.is_empty() {
        policy.on_success();
    }

    debug!("Collected {} events (EOSE={}, {}/{} relays)", events.len(), got_eose, eose_count, expected);
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
//
// ╔═══════════════════════════════════════════════════════════════════╗
// ║                 SYNC PRIORITY ORDER (STRICT)                     ║
// ╠═══════════════════════════════════════════════════════════════════╣
// ║                                                                   ║
// ║  Layer 0 — Own Content (HIGHEST PRIORITY, always first)           ║
// ║    Tier 1:  Own profile (kind 0) + contact list (kind 3)          ║
// ║    Tier 1b: Full own event history (all kinds, no time limit)     ║
// ║    Tier 1a: Own media download (all media from own events,        ║
// ║             no size limit, never evicted)                         ║
// ║    ► MUST complete before anything else starts.                   ║
// ║                                                                   ║
// ║  Layer 0.5 — Tracked Profiles                                     ║
// ║    Events + media from tracked npubs — always kept, no age limit. ║
// ║    Fetches kinds 0, 1, 3, 6, 30023 for all tracked pubkeys.      ║
// ║    Media downloaded same as own (no eviction, no size limit).     ║
// ║    ► Runs after Layer 0, before Layer 1.                          ║
// ║                                                                   ║
// ║  Layer 1 — Direct Follows Content                                 ║
// ║    Tier 2:  Fetch events from direct follows                      ║
// ║             (kinds 0, 1, 3, 6, 30023 + historical backfill)       ║
// ║    ► Only starts after Layer 0.5 is done.                         ║
// ║                                                                   ║
// ║  Layer 2 — WoT / Follows-of-Follows                              ║
// ║    Tier 1.5: Metadata refresh for WoT peers (every 3 cycles)     ║
// ║    Tier 3:   WoT crawl — contact lists from follows-of-follows   ║
// ║              (every 6 cycles, subject to storage limits)          ║
// ║    ► Runs last. WoT content pruned first when storage is tight.  ║
// ║                                                                   ║
// ║  Layer 3 — Media Archive                                         ║
// ║    Tier 4: Blossom media backup for others' content               ║
// ║            (subject to storage limit, LRU eviction)               ║
// ║    ► Own media is NEVER evicted regardless of storage limits.     ║
// ║                                                                   ║
// ║  Storage Pruning Rules:                                           ║
// ║    • Own events: NEVER pruned, regardless of limits               ║
// ║    • Tracked profile events: NEVER pruned                         ║
// ║    • Tracked profile media: NEVER evicted (same as own media)     ║
// ║    • WoT/others events: pruned when older than max_event_age_days ║
// ║    • Own media: NEVER evicted from media cache                    ║
// ║    • Others' media: LRU eviction when over storage_media_gb       ║
// ║                                                                   ║
// ╚═══════════════════════════════════════════════════════════════════╝

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
        sync_config: SyncConfig,
        max_event_age_days: u32,
    ) -> Self {
        // Filter out empty/whitespace-only relay URLs and fall back to defaults
        let valid_relays: Vec<String> = relay_aliases.into_iter()
            .filter(|r| !r.trim().is_empty())
            .collect();
        let final_relays = if valid_relays.is_empty() {
            warn!("SyncEngine: No valid relay URLs provided, using defaults");
            vec![
                "wss://relay.damus.io".to_string(),
                "wss://relay.primal.net".to_string(),
                "wss://nos.lol".to_string(),
            ]
        } else {
            valid_relays
        };
        info!("SyncEngine: initialized with {} relays: {:?}", final_relays.len(), final_relays);

        Self {
            graph,
            db,
            relay_aliases: final_relays,
            cancel: CancellationToken::new(),
            hex_pubkey,
            sync_tier,
            sync_stats,
            app_handle,
            storage_media_gb,
            sync_config,
            max_event_age_days,
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // SELF-HEALING DESIGN PRINCIPLE
    // ──────────────────────────────────────────────────────────────────
    // The sync engine is designed to be unbreakable and self-healing.
    // Users should never need to manually intervene in the sync process.
    // All cursor resets, backfills, and recovery logic must happen
    // automatically. If a cursor is stale, the engine detects it and
    // resets it. If articles are missing, the engine re-fetches them.
    // No buttons, no manual triggers, no user action required.
    // ──────────────────────────────────────────────────────────────────

    /// Start sync as a background task. Returns a cancellation token to stop it.
    pub fn start(self: Arc<Self>) -> CancellationToken {
        let cancel = self.cancel.clone();

        tokio::spawn(async move {
            // Run self-healing checks before starting the main sync loop
            self.run_self_healing_checks();

            if let Err(e) = self.run().await {
                error!("Sync engine error: {}", e);
            }
        });

        cancel
    }

    /// Self-healing checks that run on every startup.
    /// Detects and fixes stale or missing cursors so users never have to
    /// manually reset anything.
    fn run_self_healing_checks(&self) {
        info!("[self-healing] Running startup checks");

        // ── Check 1: Zero articles with existing follows ──
        // If we have follows but zero kind 30023 events, reset the articles
        // cursor so backfill starts fresh.
        let article_count = self.db.count_events_by_kind(30023).unwrap_or(0);
        let follows_count = self.graph.get_follows(&self.hex_pubkey)
            .map(|f| f.len())
            .unwrap_or(0);

        if article_count == 0 && follows_count > 0 {
            info!(
                "[self-healing] Zero articles (kind 30023) with {} follows — resetting articles cursor",
                follows_count
            );
            self.db.delete_config("tier2_history_until_articles").ok();
        }

        // ── Check 2: Suspiciously low article count ──
        // If follows > 10 but articles < 10, the cursor may be stuck.
        // Reset it so backfill reruns from now.
        if follows_count > 10 && article_count > 0 && article_count < 10 {
            info!(
                "[self-healing] Suspiciously low article count ({}) with {} follows — resetting articles cursor",
                article_count, follows_count
            );
            let now = chrono::Utc::now().timestamp() as u64;
            self.db.set_articles_history_cursor(now).ok();
        }

        // ── Check 3: Frozen cursors (>24h without advancing) ──
        // If a history cursor exists but hasn't moved in over 24 hours,
        // it may be stuck. Reset it.
        let now_epoch = chrono::Utc::now().timestamp() as u64;
        let twenty_four_hours = 24 * 3600;

        if let Ok(Some(_articles_cursor)) = self.db.get_articles_history_cursor() {
            // The cursor walks backward in time. If it's set but the difference
            // between now and the cursor is less than 24h, it means the cursor
            // hasn't walked back at all — it might be stuck right near "now".
            // We check: if cursor > now - 24h AND article count is still low,
            // something is wrong. But a more reliable check: if the cursor value
            // itself hasn't changed in 24h. Since we can't track "last changed"
            // without extra state, we use a proxy: if cursor exists but articles
            // are still very low after 24h+ of app runtime, reset.
            // For simplicity: if cursor is set and articles < 10 and follows > 5,
            // always reset — the backfill clearly didn't complete successfully.
            if article_count < 10 && follows_count > 5 {
                info!(
                    "[self-healing] Articles cursor exists but count still low ({}) — resetting for fresh backfill",
                    article_count
                );
                self.db.delete_config("tier2_history_until_articles").ok();
            }
        }

        if let Ok(Some(history_cursor)) = self.db.get_history_cursor() {
            // If main history cursor exists and is suspiciously close to now
            // (within 24h), but we have very few events, something may be stuck.
            let age = now_epoch.saturating_sub(history_cursor);
            if age < twenty_four_hours {
                let total_events = self.db.event_count().unwrap_or(0);
                if total_events < 50 && follows_count > 5 {
                    warn!(
                        "[self-healing] Main history cursor only {}h old with {} total events and {} follows — resetting",
                        age / 3600, total_events, follows_count
                    );
                    self.db.delete_config("tier2_history_until").ok();
                }
            }
        }

        info!("[self-healing] Startup checks complete");
    }

    /// Stop the sync engine
    #[allow(dead_code)]
    pub fn stop(&self) {
        self.cancel.cancel();
    }

    fn set_tier(&self, tier: SyncTier) {
        self.sync_tier.store(tier as u8, Ordering::Relaxed);
    }

    /// Update the current conceptual layer in SyncStats for dashboard display.
    async fn set_layer(&self, layer: &str) {
        let mut stats = self.sync_stats.write().await;
        stats.current_layer = layer.to_string();
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
            "Starting tiered sync from {} relays for pubkey {}: {:?}",
            self.relay_aliases.len(),
            &self.hex_pubkey[..8],
            self.relay_aliases,
        );

        if self.relay_aliases.is_empty() {
            error!("FATAL: No relay URLs configured — sync engine cannot operate. Aborting.");
            return Ok(());
        }

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

            // ── Defensive relay pre-flight check ───────────────────
            // Before running any tier, verify we can connect to at least
            // one relay. If the configured list is empty or all connections
            // fail, fall back to DEFAULT_RELAYS. This catches:
            //   - Empty relay config (DB corruption, wizard skip, etc.)
            //   - All configured relays being unreachable
            //   - Network-down scenarios (fail fast, retry next cycle)
            {
                let relay_urls = self.all_relay_urls();
                if relay_urls.is_empty() {
                    warn!(
                        "Sync cycle {}: relay_aliases is EMPTY — this indicates a config issue \
                         (relays not saved to DB or loaded incorrectly).",
                        cycle
                    );
                }

                let preflight_client = Client::default();
                let urls_to_try: Vec<String> = if relay_urls.is_empty() {
                    DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect()
                } else {
                    relay_urls.clone()
                };

                let mut any_added = false;
                for url in &urls_to_try {
                    if preflight_client.add_relay(url.as_str()).await.is_ok() {
                        any_added = true;
                    }
                }

                // If no configured relays could be added and we haven't tried defaults yet
                if !any_added && !relay_urls.is_empty() {
                    warn!("Sync cycle {}: No configured relays could be added, trying DEFAULT_RELAYS", cycle);
                    for url in DEFAULT_RELAYS {
                        if preflight_client.add_relay(*url).await.is_ok() {
                            any_added = true;
                        }
                    }
                }

                if any_added {
                    preflight_client.connect().await;
                    tokio::time::sleep(Duration::from_secs(3)).await;

                    let connected = preflight_client.relays().await;
                    if connected.is_empty() {
                        warn!(
                            "Sync cycle {}: Pre-flight relay check FAILED — added relays but \
                             none connected. Retrying in 60s. Configured: {:?}",
                            cycle, urls_to_try
                        );
                        preflight_client.disconnect().await.ok();
                        cycle += 1;
                        tokio::select! {
                            _ = self.cancel.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                        }
                        continue;
                    }
                    info!(
                        "Sync cycle {}: Pre-flight OK — {} relays connected",
                        cycle, connected.len()
                    );
                    preflight_client.disconnect().await.ok();
                } else {
                    error!(
                        "Sync cycle {}: Pre-flight CRITICAL — could not add ANY relay URL. \
                         Configured: {:?}, Defaults: {:?}. Retrying in 60s.",
                        cycle, relay_urls, DEFAULT_RELAYS
                    );
                    cycle += 1;
                    tokio::select! {
                        _ = self.cancel.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                    }
                    continue;
                }
            }

            // ────────────────────────────────────────────────────────
            // LAYER 0 — OWN CONTENT (highest priority, always first)
            // Must complete before ANY other layer starts.
            // ────────────────────────────────────────────────────────

            // Tier 1: Own profile (kind 0) + contact list (kind 3) + full event history
            if !self.cancel.is_cancelled() {
                self.set_layer("0").await;
                if let Err(e) = self.run_tier1(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 1 error: {}", cycle, e);
                }
            }

            // Tier 1a: Own media download — ALL media from own events, no size limit, never evicted
            if !self.cancel.is_cancelled() {
                info!("Sync cycle {}: Running Tier 1a (own media download)", cycle);
                if let Err(e) = self.run_own_media_download().await {
                    error!("Sync cycle {}: Tier 1a error: {}", cycle, e);
                }
            }

            // ────────────────────────────────────────────────────────
            // LAYER 0.5 — TRACKED PROFILES
            // Events + media from tracked npubs. Always kept, no age
            // limit. Runs after Layer 0, before Layer 1.
            // ────────────────────────────────────────────────────────

            if !self.cancel.is_cancelled() {
                self.set_layer("0.5").await;
                if let Err(e) = self.run_tracked_profiles_sync(&mut relay_policies).await {
                    error!("Sync cycle {}: Tracked profiles sync error: {}", cycle, e);
                }
            }

            // Tracked profiles media download (same rules as own media — never evicted)
            if !self.cancel.is_cancelled() {
                if let Err(e) = self.run_tracked_media_download().await {
                    error!("Sync cycle {}: Tracked media download error: {}", cycle, e);
                }
            }

            // ────────────────────────────────────────────────────────
            // LAYER 1 — DIRECT FOLLOWS CONTENT
            // Only starts after Layer 0.5 (tracked profiles) is complete.
            // ────────────────────────────────────────────────────────

            // Tier 2: Fetch recent events from direct follows (kinds 0,1,3,6,30023)
            // Includes incremental sync + historical backfill
            if !self.cancel.is_cancelled() {
                self.set_layer("1").await;
                if let Err(e) = self.run_tier2(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 2 error: {}", cycle, e);
                }
            }

            // ────────────────────────────────────────────────────────
            // LAYER 2 — WoT / FOLLOWS-OF-FOLLOWS (lowest content priority)
            // Runs after Layer 1. Subject to storage limits.
            // WoT content is pruned first when storage is tight.
            // ────────────────────────────────────────────────────────

            // Tier 1.5: WoT metadata refresh — profiles + contact lists for WoT peers
            // Runs every 3 cycles to keep display names, avatars, and follows fresh.
            // Placed in Layer 2 because it serves WoT graph, not direct follows.
            if !self.cancel.is_cancelled() && cycle % 3 == 0 {
                self.set_layer("2").await;
                info!("Sync cycle {}: Running Tier 1.5 (WoT metadata refresh)", cycle);
                if let Err(e) = self.run_metadata_refresh(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 1.5 error: {}", cycle, e);
                }
            }

            // Tier 3: WoT crawl — contact lists from follows-of-follows
            // Runs every 6 cycles (~30 min). Subject to storage limits.
            if !self.cancel.is_cancelled() && cycle % 6 == 0 {
                self.set_layer("2").await;
                info!("Sync cycle {}: Running Tier 3 (WoT crawl, every 6 cycles)", cycle);
                if let Err(e) = self.run_tier3(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 3 error: {}", cycle, e);
                }
            }

            // ────────────────────────────────────────────────────────
            // LAYER 3 — MEDIA ARCHIVE (others' media, subject to limits)
            // Own media was already handled in Layer 0 (Tier 1a).
            // Others' media: LRU eviction when over storage_media_gb.
            // ────────────────────────────────────────────────────────

            // Tier 4: Blossom media backup for others' content
            if !self.cancel.is_cancelled() {
                self.set_layer("3").await;
                info!("Sync cycle {}: Running Tier 4 (media backup)", cycle);
                if let Err(e) = self.run_tier4(&mut relay_policies).await {
                    error!("Sync cycle {}: Tier 4 error: {}", cycle, e);
                }
            }

            self.set_tier(SyncTier::Idle);
            self.set_layer("").await;
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

    // ── Tier 1: Critical (LAYER 0 — Own Content) ────────────────
    // HIGHEST PRIORITY. Runs at the START of every sync cycle.
    // Fetches: own profile (kind 0), own contact list (kind 3),
    // and full own event history (Tier 1b: all kinds, no time limit).
    // This MUST complete before Tier 2/3/4 start.
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

            match subscribe_and_collect(&client, vec![filter.clone()], 15, policy, 1).await {
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

        // Sort newest-first so replaceable events (kind:3) are processed in
        // correct order — the WoT timestamp guard rejects older duplicates.
        all_events.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        info!("Tier 1: Processing {} total events", all_events.len());

        for event in all_events.iter() {
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

                        info!(
                            "Tier 1: Loaded {} follows from own contact list (ts={})",
                            update.follows.len(),
                            update.created_at,
                        );
                    } else {
                        debug!(
                            "Tier 1: Skipped older contact list event (ts={})",
                            update.created_at,
                        );
                    }
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

            match subscribe_and_collect(&client, vec![all_own_filter.clone()], 30, policy, 1).await {
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

    // ── Tier 1a: Own Media Download (LAYER 0 — Own Content) ─────
    // Part of Layer 0: runs immediately after Tier 1, before any
    // follows or WoT work. Scans ALL own events for media URLs and
    // downloads them immediately.
    // Own media has NO size limit, NO eviction — always kept.

    async fn run_own_media_download(&self) -> Result<()> {
        info!("Tier 1a: Downloading own media (no limits, never evicted)");

        // Extract all media URLs from own events
        let own_media_urls = self.extract_own_media_urls().await;
        if own_media_urls.is_empty() {
            info!("Tier 1a: No own media URLs found");
            return Ok(());
        }

        info!("Tier 1a: Found {} own media URLs to check", own_media_urls.len());

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("nostrito/0.1.0")
            .build()
            .unwrap_or_default();

        let mut downloaded: u64 = 0;
        let mut skipped: u64 = 0;
        let mut already_cached: u64 = 0;

        for (url, pubkey) in &own_media_urls {
            if self.cancel.is_cancelled() {
                break;
            }

            let hash = extract_sha256_from_url(url)
                .unwrap_or_else(|| sha256_of_string(url));

            if self.db.media_exists(&hash) {
                already_cached += 1;
                continue;
            }

            // Own media: is_own=true, limit_bytes is irrelevant (ignored for own)
            match self.download_media(&client, url, &hash, pubkey, u64::MAX, true).await {
                Ok(true) => {
                    downloaded += 1;
                }
                Ok(false) => {
                    skipped += 1;
                }
                Err(e) => {
                    warn!("Tier 1a: download failed for {}: {}", url, e);
                    skipped += 1;
                }
            }

            // Brief pause between downloads
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        info!(
            "Tier 1a complete: {} downloaded, {} skipped, {} already cached (of {} total own media URLs)",
            downloaded, skipped, already_cached, own_media_urls.len()
        );
        Ok(())
    }

    // ── Layer 0.5: Tracked Profiles Sync ──────────────────────────
    // Fetches events from all tracked profiles (kinds 0, 1, 3, 6, 30023).
    // Uses an incremental cursor (tracked_since) stored in config.
    // Events from tracked profiles are NEVER pruned.
    // Runs every sync cycle, after Layer 0 and before Layer 1.

    async fn run_tracked_profiles_sync(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        let tracked_pubkeys = self.db.get_tracked_pubkeys().unwrap_or_default();
        if tracked_pubkeys.is_empty() {
            debug!("Layer 0.5: No tracked profiles, skipping");
            return Ok(());
        }

        info!("Layer 0.5: Syncing {} tracked profiles", tracked_pubkeys.len());

        // Incremental cursor — shared across all tracked profiles
        let now_epoch = chrono::Utc::now().timestamp() as u64;
        let since_ts = match self.db.get_config("tracked_since")? {
            Some(val) => val.parse::<u64>().unwrap_or(0).saturating_sub(60),
            None => {
                // First run: look back 30 days for tracked profiles
                now_epoch.saturating_sub(30 * 86400)
            }
        };
        let since = Timestamp::from(since_ts);

        info!(
            "Layer 0.5: since={} ({}), {} tracked pubkeys",
            since_ts,
            chrono::DateTime::from_timestamp(since_ts as i64, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| "?".into()),
            tracked_pubkeys.len(),
        );

        let relay_urls = self.all_relay_urls();
        let mut fetched: u64 = 0;
        let mut total_new: u64 = 0;

        // ONE persistent client for this tier
        let client = Client::default();
        for url in &relay_urls {
            if let Err(e) = client.add_relay(url.as_str()).await {
                warn!("Layer 0.5: Failed to add relay {}: {}", url, e);
            }
        }
        client.connect().await;
        tokio::time::sleep(Duration::from_secs(3)).await;

        let policy_url = relay_urls.first().cloned().unwrap_or_default();

        // Process in batches of 10 tracked pubkeys
        for (batch_idx, chunk) in tracked_pubkeys.chunks(10).enumerate() {
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

            let main_filter = Filter::new()
                .authors(authors.clone())
                .kinds(vec![
                    Kind::Metadata,           // 0
                    Kind::TextNote,           // 1
                    Kind::ContactList,        // 3
                    Kind::Repost,             // 6
                ])
                .since(since)
                .limit(200);

            let articles_filter = Filter::new()
                .authors(authors)
                .kinds(vec![Kind::LongFormTextNote]) // 30023
                .since(since)
                .limit(50);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&client, vec![main_filter, articles_filter], 15, policy, relay_urls.len().max(1)).await {
                Ok(events) => {
                    let mut batch_new: u64 = 0;
                    for event in events.iter() {
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
                        }

                        // Process kind:3 → update WoT graph
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
                    fetched += events.len() as u64;
                    total_new += batch_new;
                    info!(
                        "Layer 0.5: batch {}: {} tracked → {} events ({} new)",
                        batch_idx + 1,
                        chunk.len(),
                        events.len(),
                        batch_new,
                    );
                }
                Err(e) => {
                    warn!("Layer 0.5: batch {} failed: {}", batch_idx + 1, e);
                }
            }

            // Pause between batches
            if batch_idx + 1 < tracked_pubkeys.chunks(10).len() {
                tokio::time::sleep(Duration::from_secs(self.sync_config.batch_pause_secs as u64)).await;
            }
        }

        client.disconnect().await.ok();

        // Advance cursor
        self.db.set_config("tracked_since", &now_epoch.to_string())?;

        {
            let mut stats = self.sync_stats.write().await;
            stats.tracked_fetched = fetched;
        }

        self.emit_progress(15, fetched, fetched, ""); // tier 15 = layer 0.5 indicator
        self.emit_tier_complete(15);

        info!(
            "Layer 0.5 complete: {} events fetched ({} new) from {} tracked profiles",
            fetched, total_new, tracked_pubkeys.len()
        );
        Ok(())
    }

    // ── Layer 0.5: Tracked Profiles Media Download ──────────────
    // Downloads media from tracked profiles' events. Same rules as own
    // media: no size limit, never evicted.

    async fn run_tracked_media_download(&self) -> Result<()> {
        let tracked_pubkeys = self.db.get_tracked_pubkeys().unwrap_or_default();
        if tracked_pubkeys.is_empty() {
            return Ok(());
        }

        info!("Layer 0.5 media: Downloading media for {} tracked profiles", tracked_pubkeys.len());

        let events = self.db.query_events(
            None,
            Some(&tracked_pubkeys),
            None,  // all kinds
            None,
            None,
            5000,
        ).unwrap_or_default();

        let mut urls = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for (_id, pubkey, _created_at, _kind, tags_json, content, _sig) in &events {
            for url in extract_urls_from_text(content) {
                let is_media = extract_sha256_from_url(&url).is_some()
                    || mime_type_from_url(&url).is_some()
                    || is_nostr_media_cdn(&url);
                if is_media && seen.insert(url.clone()) {
                    urls.push((url, pubkey.clone()));
                }
            }
            for url in extract_urls_from_tags(tags_json) {
                let is_media = extract_sha256_from_url(&url).is_some()
                    || mime_type_from_url(&url).is_some()
                    || is_nostr_media_cdn(&url);
                if is_media && seen.insert(url.clone()) {
                    urls.push((url, pubkey.clone()));
                }
            }
        }

        if urls.is_empty() {
            info!("Layer 0.5 media: No media URLs found for tracked profiles");
            return Ok(());
        }

        info!("Layer 0.5 media: Found {} media URLs to check", urls.len());

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("nostrito/0.1.0")
            .build()
            .unwrap_or_default();

        let mut downloaded: u64 = 0;
        let mut skipped: u64 = 0;
        let mut already_cached: u64 = 0;

        for (url, pubkey) in &urls {
            if self.cancel.is_cancelled() {
                break;
            }

            let hash = extract_sha256_from_url(url)
                .unwrap_or_else(|| sha256_of_string(url));

            if self.db.media_exists(&hash) {
                already_cached += 1;
                continue;
            }

            // Tracked media: is_own=true (never evicted), no size limit
            match self.download_media(&client, url, &hash, pubkey, u64::MAX, true).await {
                Ok(true) => {
                    downloaded += 1;
                }
                Ok(false) => {
                    skipped += 1;
                }
                Err(e) => {
                    warn!("Layer 0.5 media: download failed for {}: {}", url, e);
                    skipped += 1;
                }
            }

            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        info!(
            "Layer 0.5 media complete: {} downloaded, {} skipped, {} already cached (of {} total)",
            downloaded, skipped, already_cached, urls.len()
        );
        Ok(())
    }

    // ── Tier 1.5: WoT Metadata Refresh (LAYER 2 — WoT) ─────────
    // Part of Layer 2: runs AFTER Tier 2 (direct follows content).
    // Refreshes kind:0 (profiles) and kind:3 (contact lists) for all
    // known pubkeys in the WoT graph. Keeps display names, avatars,
    // and follow lists fresh without waiting for Tier 3's full crawl.

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

            match subscribe_and_collect(&client, vec![filter], 10, policy, relay_urls.len().max(1)).await {
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

    // ── Tier 2: Important (LAYER 1 — Direct Follows) ────────────
    // Part of Layer 1: runs AFTER Layer 0 (own content) is complete.
    // Fetches recent notes from direct follows (kinds 0,1,3,6,30023).
    // Includes incremental sync via cursor + historical backfill.
    // ONE persistent client per sync session. Connect once, send all
    // subscription batches on that connection with pauses, disconnect
    // once at the end.

    async fn run_tier2(&self, policies: &mut HashMap<String, RelayPolicy>) -> Result<()> {
        self.set_tier(SyncTier::Important);
        info!("Tier 2: Fetching recent events from follows");

        // ── Storage pruning: time-based event retention ──
        // Prune others' events older than max_event_age_days.
        // NEVER prunes: own events (pubkey == hex_pubkey) or tracked profile events.
        // Only WoT/others' events are eligible for pruning.
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
        // Use the MORE RECENT of (cursor - 60s) or (now - lookback_days).
        // The cursor tracks our last successful sync position: use it when it's
        // recent so we only fetch new events (incremental sync). Fall back to
        // lookback_floor when there's no cursor or when it's very old (e.g. after
        // account change or first run).
        let since_ts = match cursor {
            Some(ts) => {
                let cursor_ts = ts.saturating_sub(60);
                let chosen = cursor_ts.max(lookback_floor); // use whichever is NEWER
                info!(
                    "Tier 2: cursor={}, lookback_floor={}, using since={} (newer of both)",
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
            //
            // Long-form articles (kind 30023) get their own filter so they aren't
            // crowded out by the much higher volume of metadata/contacts/notes.
            let main_filter = Filter::new()
                .authors(authors.clone())
                .kinds(vec![
                    Kind::Metadata,           // 0 — profiles
                    Kind::TextNote,           // 1 — notes
                    Kind::ContactList,        // 3 — follows (for WoT)
                    Kind::Repost,             // 6 — reposts
                ])
                .since(since)
                .limit(self.sync_config.events_per_batch as usize);

            let articles_filter = Filter::new()
                .authors(authors)
                .kinds(vec![Kind::LongFormTextNote]) // 30023 — articles
                .since(since)
                .limit(20);

            let policy = policies
                .entry(policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&client, vec![main_filter, articles_filter], 10, policy, relay_urls.len().max(1)).await {
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

        // Advance sync cursor when we successfully communicated with relays.
        // Advance even when total_new == 0 (all duplicates) — that means the
        // window was fully covered and we can move forward. Only hold the cursor
        // when NO batches ran at all (relay connectivity failure).
        if batches_processed > 0 {
            let cursor_ts = chrono::Utc::now().timestamp() as u64;
            self.db.set_sync_cursor(cursor_ts.saturating_sub(60)).ok();
            info!(
                "Tier 2: Updated sync cursor to {} ({} new, {} dupe across {} batches)",
                cursor_ts.saturating_sub(60), total_new, total_dupe, batches_processed
            );
        } else {
            info!(
                "Tier 2: Cursor NOT advanced — no batches processed (relay connectivity issue?)"
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
        // Two separate passes: notes/reposts (high volume) and articles (low volume).
        // Each has its own cursor so articles aren't crowded out by common kinds.
        if !self.cancel.is_cancelled() && !follows.is_empty() {
            let authors: Vec<PublicKey> = follows.iter()
                .filter_map(|hex| PublicKey::from_hex(hex).ok())
                .collect();

            // Use fresh client for historical fetch
            let hist_client = Client::default();
            for url in &relay_urls {
                hist_client.add_relay(url.as_str()).await.ok();
            }
            hist_client.connect().await;
            tokio::time::sleep(Duration::from_secs(2)).await;

            let hist_policy_url = relay_urls.first().cloned().unwrap_or_default();

            // ── Pass 1: Notes & reposts (main history cursor) ──
            let history_until = self.db.get_history_cursor().unwrap_or(None).unwrap_or_else(|| {
                chrono::Utc::now().timestamp() as u64 - (self.sync_config.lookback_days as u64 * 86400)
            });

            let age_days = now_epoch.saturating_sub(history_until) / 86400;
            info!("Tier 2: Historical notes backfill until={} (~{}d ago)", history_until, age_days);

            let notes_filter = Filter::new()
                .authors(authors.clone())
                .kinds(vec![Kind::TextNote, Kind::Repost])
                .until(Timestamp::from(history_until))
                .limit(500);

            let hist_policy = policies
                .entry(hist_policy_url.clone())
                .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

            match subscribe_and_collect(&hist_client, vec![notes_filter], 30, hist_policy, relay_urls.len().max(1)).await {
                Ok(hist_events) if !hist_events.is_empty() => {
                    let mut oldest_ts = history_until;
                    let mut hist_new: u64 = 0;

                    for event in &hist_events {
                        let tags: Vec<Vec<String>> = event.tags.iter()
                            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                            .collect();
                        let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                        let inserted = self.db.store_event(
                            &event.id.to_hex(), &event.pubkey.to_hex(),
                            event.created_at.as_u64() as i64, event.kind.as_u16() as u32,
                            &tags_json, &event.content.to_string(), &event.sig.to_string(),
                        ).unwrap_or(false);
                        if inserted {
                            hist_new += 1;
                            self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
                        }
                        let ts = event.created_at.as_u64();
                        if ts < oldest_ts { oldest_ts = ts; }
                    }

                    self.db.set_history_cursor(oldest_ts.saturating_sub(1)).ok();
                    info!(
                        "Tier 2: Historical notes: {} events ({} new), cursor → {} (~{}d ago)",
                        hist_events.len(), hist_new, oldest_ts, now_epoch.saturating_sub(oldest_ts) / 86400
                    );
                }
                Ok(_) => info!("Tier 2: Historical notes: no more events at this cursor position"),
                Err(e) => warn!("Tier 2: Historical notes fetch error: {}", e),
            }

            // Polite pause between passes
            tokio::time::sleep(Duration::from_secs(3)).await;

            // ── Pass 2: Articles (separate cursor — never crowded out by notes) ──
            if !self.cancel.is_cancelled() {
                let articles_until = self.db.get_articles_history_cursor().unwrap_or(None).unwrap_or_else(|| {
                    // First run: start from now and walk backward through all history
                    chrono::Utc::now().timestamp() as u64
                });

                let art_age_days = now_epoch.saturating_sub(articles_until) / 86400;
                info!("Tier 2: Historical articles backfill until={} (~{}d ago)", articles_until, art_age_days);

                let articles_filter = Filter::new()
                    .authors(authors)
                    .kinds(vec![Kind::LongFormTextNote]) // 30023
                    .until(Timestamp::from(articles_until))
                    .limit(200);

                let art_policy = policies
                    .entry(hist_policy_url.clone())
                    .or_insert_with(|| RelayPolicy::new(self.sync_config.relay_min_interval_secs as u64));

                match subscribe_and_collect(&hist_client, vec![articles_filter], 30, art_policy, relay_urls.len().max(1)).await {
                    Ok(art_events) if !art_events.is_empty() => {
                        let mut oldest_ts = articles_until;
                        let mut art_new: u64 = 0;

                        for event in &art_events {
                            let tags: Vec<Vec<String>> = event.tags.iter()
                                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                                .collect();
                            let tags_json = serde_json::to_string(&tags).unwrap_or_default();
                            let inserted = self.db.store_event(
                                &event.id.to_hex(), &event.pubkey.to_hex(),
                                event.created_at.as_u64() as i64, event.kind.as_u16() as u32,
                                &tags_json, &event.content.to_string(), &event.sig.to_string(),
                            ).unwrap_or(false);
                            if inserted {
                                art_new += 1;
                                self.queue_media_for_event(&event.pubkey.to_hex(), &event.content.to_string(), &tags_json);
                            }
                            let ts = event.created_at.as_u64();
                            if ts < oldest_ts { oldest_ts = ts; }
                        }

                        self.db.set_articles_history_cursor(oldest_ts.saturating_sub(1)).ok();
                        info!(
                            "Tier 2: Historical articles: {} events ({} new), cursor → {} (~{}d ago)",
                            art_events.len(), art_new, oldest_ts, now_epoch.saturating_sub(oldest_ts) / 86400
                        );
                    }
                    Ok(_) => info!("Tier 2: Historical articles: no more events at this cursor position"),
                    Err(e) => warn!("Tier 2: Historical articles fetch error: {}", e),
                }
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

    // ── Tier 3: Background (LAYER 2 — WoT Crawl) ────────────────
    // Part of Layer 2: runs AFTER Tier 2 (direct follows content).
    // WoT crawl — fetches contact lists from follows-of-follows.
    // Subject to storage limits; WoT content is pruned first when
    // storage is tight. Runs every 6 cycles (~30 min).
    // ONE persistent client per sync session.
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

            match subscribe_and_collect(&client, vec![filter], 10, policy, relay_urls.len().max(1)).await {
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

    // ── Tier 4: Archive (LAYER 3 — Others' Media Backup) ────────
    // Runs last. Downloads media from others' events, subject to
    // storage_media_gb limit. Own media was already downloaded in
    // Tier 1a (Layer 0) with no limits. Others' media uses LRU
    // eviction when over limit — own media is NEVER evicted.

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

        // Only cache images, videos, and audio
        if !mime.starts_with("image/") && !mime.starts_with("video/") && !mime.starts_with("audio/") {
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
    /// Only counts and evicts OTHERS' media — own media is NEVER evicted.
    /// Tracked profile media follows the same LRU policy as other non-own media.
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
