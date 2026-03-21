mod nip46;
mod relay;
mod search;
mod storage;
mod sync;
mod wallet;
mod wot;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use storage::{Database, ProfileInfo};
use sync::{resolve_relay_url as resolve_relay_alias, SyncConfig, SyncEngine, SyncStats};
use wot::WotGraph;

// ── Helpers ────────────────────────────────────────────────────────

/// Show an error and exit gracefully instead of panicking.
#[cfg(desktop)]
fn fatal_exit(msg: &str) -> ! {
    tracing::error!("[fatal] {}", msg);
    let escaped = msg.replace('\\', "\\\\").replace('"', "\\\"");
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "display dialog \"{}\" with title \"nostrito\" buttons {{\"OK\"}} default button \"OK\" with icon stop",
            escaped
        ))
        .output();
    std::process::exit(1);
}

#[cfg(mobile)]
fn fatal_exit(msg: &str) -> ! {
    tracing::error!("[fatal] {}", msg);
    std::process::exit(1);
}

/// Spawn a background task that receives events from the relay and:
/// 1. Broadcasts them to all configured outbound relays
/// 2. Shows a native macOS notification (via tauri-plugin-notification)
fn spawn_outbound_broadcaster(
    config: Arc<RwLock<AppConfig>>,
    app_handle: tauri::AppHandle,
) -> relay::OutboundEventSender {
    use tauri_plugin_notification::NotificationExt;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    tokio::spawn(async move {
        while let Some(event_json) = rx.recv().await {
            let config = config.read().await;
            let relays = config.outbound_relays.clone();
            drop(config);

            if relays.is_empty() {
                tracing::warn!("[outbound] No outbound relays configured, skipping broadcast");
                continue;
            }

            // Parse event JSON for notification details
            let event_value: serde_json::Value = match serde_json::from_str(&event_json) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("[outbound] Failed to parse event JSON: {}", e);
                    continue;
                }
            };

            let kind = event_value["kind"].as_u64().unwrap_or(0);
            let event_id = event_value["id"].as_str().unwrap_or("unknown");
            let short_id = &event_id[..event_id.len().min(12)];

            // Send native macOS notification via Tauri
            {
                let notif_body = match kind {
                    1 => {
                        let content = event_value["content"].as_str().unwrap_or("");
                        let preview = if content.len() > 80 {
                            format!("{}...", &content[..80])
                        } else {
                            content.to_string()
                        };
                        format!("New note: {}", preview)
                    }
                    0 => "Profile metadata updated".to_string(),
                    3 => "Contact list updated".to_string(),
                    5 => "Deletion event published".to_string(),
                    7 => "Reaction published".to_string(),
                    _ => format!("New event (kind {})", kind),
                };
                if let Err(e) = app_handle.notification()
                    .builder()
                    .title("Nostrito")
                    .body(&notif_body)
                    .show()
                {
                    tracing::warn!("[outbound] Failed to show notification: {}", e);
                }
            }

            // Broadcast to all outbound relays
            let relay_count = relays.len();
            tracing::info!("[outbound] Broadcasting event {}… (kind {}) to {} relays", short_id, kind, relay_count);

            let event_json_clone = event_json.clone();
            tokio::spawn(async move {
                use nostr_sdk::prelude::*;

                let event = match Event::from_json(&event_json_clone) {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::error!("[outbound] Failed to reconstruct nostr event: {}", e);
                        return;
                    }
                };

                let client = Client::default();
                let mut connected = 0u32;
                for url in &relays {
                    if let Ok(_) = client.add_relay(url.as_str()).await {
                        if client.connect_relay(url.as_str()).await.is_ok() {
                            connected += 1;
                        }
                    }
                }

                if connected == 0 {
                    tracing::warn!("[outbound] Could not connect to any outbound relay");
                    return;
                }

                match client.send_event(event).await {
                    Ok(output) => {
                        tracing::info!(
                            "[outbound] Event broadcast complete: sent to {} relay(s), failed on {}",
                            output.success.len(),
                            output.failed.len()
                        );
                    }
                    Err(e) => {
                        tracing::error!("[outbound] Failed to broadcast event: {}", e);
                    }
                }

                client.disconnect().await.ok();
            });
        }
    });

    tx
}

/// Per-npub database path: `{data_dir}/{npub_prefix}.db`
fn db_path_for_npub(data_dir: &std::path::Path, npub: &str) -> PathBuf {
    let short = if npub.len() > 16 { &npub[..16] } else { npub };
    data_dir.join(format!("{}.db", short))
}

/// Lobby database used before any npub is known.
fn lobby_db_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("nostrito.db")
}

// ── App State ──────────────────────────────────────────────────────

pub struct AppState {
    pub wot_graph: Arc<WotGraph>,
    db: parking_lot::RwLock<Arc<Database>>,
    pub config: Arc<RwLock<AppConfig>>,
    pub data_dir: PathBuf,
    pub sync_cancel: Arc<RwLock<Option<CancellationToken>>>,
    pub sync_tier: Arc<AtomicU8>,
    pub sync_stats: Arc<RwLock<SyncStats>>,
    pub relay_cancel: Arc<RwLock<Option<CancellationToken>>>,
    pub start_time: std::time::Instant,
    pub wallet: wallet::SharedWalletState,
    pub nip46_signer: Arc<RwLock<Option<crate::nip46::Nip46Client>>>,
}

impl AppState {
    /// Get a clone of the current database Arc.
    pub fn db(&self) -> Arc<Database> {
        self.db.read().clone()
    }

    /// Swap the database to a new one.
    pub fn swap_db(&self, new_db: Arc<Database>) {
        let mut guard = self.db.write();
        *guard = new_db;
    }
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub npub: Option<String>,
    pub hex_pubkey: Option<String>,
    pub relay_port: u16,
    pub max_storage_mb: u32,
    pub wot_max_depth: u32,
    pub sync_interval_secs: u32,
    pub outbound_relays: Vec<String>,
    pub auto_start: bool,
    pub storage_others_gb: f64,
    pub storage_media_gb: f64,
    // Per-category storage limits
    pub storage_own_media_gb: f64,
    pub storage_tracked_media_gb: f64,
    pub storage_wot_media_gb: f64,
    pub wot_event_retention_days: u32,
    pub thread_retention_days: u32,
    // Sync tuning
    pub sync_lookback_days: u32,
    pub sync_batch_size: u32,
    pub sync_events_per_batch: u32,
    pub sync_batch_pause_secs: u32,
    pub sync_relay_min_interval_secs: u32,
    pub sync_wot_batch_size: u32,
    pub sync_wot_events_per_batch: u32,
    pub max_event_age_days: u32,
    /// How many notes to fetch from WoT peers each sync cycle (0 = disabled)
    pub sync_wot_notes_per_cycle: u32,
    /// Offline mode — stop all outbound sync, work only with local data
    pub offline_mode: bool,
    /// Cached nsec (loaded from system keychain on startup)
    pub nsec: Option<String>,
    /// Signing mode: "nsec", "bunker", "connect", or "read-only" (transient, not saved to DB)
    pub signing_mode: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            npub: None,
            hex_pubkey: None,
            relay_port: 4869,
            max_storage_mb: 2048,
            wot_max_depth: 2,
            sync_interval_secs: 300,
            outbound_relays: vec![
                "wss://relay.damus.io".into(),
                "wss://relay.primal.net".into(),
                "wss://nos.lol".into(),
                "wss://relay.nostr.band".into(),
                "wss://nostr.wine".into(),
            ],
            auto_start: true,
            storage_others_gb: 5.0,
            storage_media_gb: 2.0,
            storage_own_media_gb: 5.0,
            storage_tracked_media_gb: 3.0,
            storage_wot_media_gb: 2.0,
            wot_event_retention_days: 30,
            thread_retention_days: 30,
            sync_lookback_days: 30,
            sync_batch_size: 50,
            sync_events_per_batch: 50,
            sync_batch_pause_secs: 7,
            sync_relay_min_interval_secs: 3,
            sync_wot_batch_size: 5,
            sync_wot_events_per_batch: 15,
            max_event_age_days: 30,
            sync_wot_notes_per_cycle: 50,
            offline_mode: false,
            nsec: None,
            signing_mode: "read-only".to_string(),
        }
    }
}

// ── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct AppStatus {
    pub initialized: bool,
    pub npub: Option<String>,
    pub relay_running: bool,
    pub relay_port: u16,
    pub events_stored: u64,
    pub wot_nodes: usize,
    pub wot_edges: usize,
    pub sync_status: String,
    pub sync_tier: u8,
    pub sync_stats: SyncStats,
    pub media_stored: u64,
    pub offline_mode: bool,
    pub sync_wot_notes_per_cycle: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WotStatus {
    pub root_pubkey: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub nodes_with_follows: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FeedFilter {
    pub kinds: Option<Vec<u32>>,
    pub limit: Option<u32>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    pub wot_only: Option<bool>,
    pub search: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageStats {
    pub total_events: u64,
    pub db_size_bytes: u64,
    pub oldest_event: u64,
    pub newest_event: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnershipStorageStats {
    pub own_events_count: u64,
    pub own_media_bytes: u64,
    pub tracked_events_count: u64,
    pub tracked_media_bytes: u64,
    pub wot_events_count: u64,
    pub wot_media_bytes: u64,
    pub total_events: u64,
    pub db_size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageEstimateResponse {
    pub follows_count: u32,
    pub fof_estimate: u32,
    pub events_per_day: f64,
    pub bytes_per_day: f64,
    pub projected_30d_bytes: f64,
    pub current_db_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub npub: String,
    pub relay_port: u16,
    pub max_storage_mb: u32,
    pub storage_others_gb: f64,
    pub storage_media_gb: f64,
    pub storage_own_media_gb: f64,
    pub storage_tracked_media_gb: f64,
    pub storage_wot_media_gb: f64,
    pub wot_event_retention_days: u32,
    pub thread_retention_days: u32,
    pub wot_max_depth: u32,
    pub sync_interval_secs: u32,
    pub outbound_relays: Vec<String>,
    pub auto_start: bool,
    pub sync_lookback_days: u32,
    pub sync_batch_size: u32,
    pub sync_events_per_batch: u32,
    pub sync_batch_pause_secs: u32,
    pub sync_relay_min_interval_secs: u32,
    pub sync_wot_batch_size: u32,
    pub sync_wot_events_per_batch: u32,
    pub max_event_age_days: u32,
    pub sync_wot_notes_per_cycle: u32,
    pub offline_mode: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WotDistanceRequest {
    pub from: String,
    pub to: String,
    pub max_hops: Option<u8>,
    pub include_bridges: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WotDistanceResponse {
    pub from: String,
    pub to: String,
    pub hops: Option<u32>,
    pub path_count: u64,
    pub mutual_follow: bool,
    pub bridges: Option<Vec<String>>,
}

// ── Sync Engine Factory ───────────────────────────────────────────

/// Resolve relays for the sync engine: prefer NIP-65 read relays, fall back to config defaults.
fn resolve_sync_relays(db: &Database, hex_pubkey: &str, fallback_relays: &[String]) -> Vec<String> {
    let nip65_relays: Vec<String> = db
        .get_read_relays(hex_pubkey)
        .unwrap_or_default()
        .into_iter()
        .map(|(url, _source)| url)
        .collect();

    if nip65_relays.is_empty() {
        tracing::info!("No NIP-65 read relays found, using config defaults");
        fallback_relays.to_vec()
    } else {
        tracing::info!("Using {} NIP-65 read relays for sync", nip65_relays.len());
        nip65_relays
    }
}

/// Start the sync engine. Returns a CancellationToken for stopping.
fn start_sync_engine(
    wot_graph: Arc<WotGraph>,
    db: Arc<Database>,
    fallback_relays: Vec<String>,
    hex_pubkey: String,
    sync_tier: Arc<AtomicU8>,
    sync_stats: Arc<RwLock<SyncStats>>,
    app_handle: tauri::AppHandle,
    tracked_media_gb: f64,
    wot_media_gb: f64,
    sync_config: SyncConfig,
    max_event_age_days: u32,
) -> CancellationToken {
    let relays = resolve_sync_relays(&db, &hex_pubkey, &fallback_relays);
    let engine = Arc::new(SyncEngine::new(
        wot_graph, db, relays, hex_pubkey, sync_tier, sync_stats,
        app_handle, tracked_media_gb, wot_media_gb, sync_config, max_event_age_days,
    ));
    engine.start()
}

// ── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    tracing::debug!("[cmd:get_status] called");
    let config = state.config.read().await;
    let stats = state.wot_graph.stats();
    let sync_running = state.sync_cancel.read().await.is_some();
    let relay_running = state.relay_cancel.read().await.is_some();
    let current_tier = state.sync_tier.load(Ordering::Relaxed);
    let sync_stats = state.sync_stats.read().await.clone();
    let events_stored = state.db().event_count().unwrap_or(0);
    let media_stored = state.db().media_total_bytes().unwrap_or(0);
    let offline_mode = config.offline_mode;

    tracing::debug!("[cmd:get_status] relay_running={}, events={}, wot_nodes={}, sync_tier={}", relay_running, events_stored, stats.node_count, current_tier);

    Ok(AppStatus {
        initialized: config.npub.is_some(),
        npub: config.npub.clone(),
        relay_running,
        relay_port: config.relay_port,
        events_stored,
        wot_nodes: stats.node_count,
        wot_edges: stats.edge_count,
        sync_status: if sync_running {
            match current_tier {
                1 => "syncing (phase 1: own data)".into(),
                2 => "syncing (phase 2: discovery)".into(),
                3 => "syncing (phase 3: content)".into(),
                4 => "syncing (phase 4: threads)".into(),
                5 => "syncing (phase 5: media)".into(),
                6 => "syncing (wot crawl)".into(),
                _ => "idle".into(),
            }
        } else {
            "idle".into()
        },
        sync_tier: current_tier,
        sync_stats,
        media_stored,
        offline_mode,
        sync_wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
    })
}

#[tauri::command]
async fn init_nostrito(
    npub: String,
    relays: Vec<String>,
    storage_others_gb: Option<f64>,
    storage_tracked_media_gb: Option<f64>,
    storage_wot_media_gb: Option<f64>,
    wot_retention_days: Option<u32>,
    max_event_age_days: Option<u32>,
    retention_overrides: Option<String>,
    storage_preset: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("Initializing nostrito with npub: {}", npub);

    // Parse npub to hex pubkey
    let hex_pubkey = if npub.starts_with("npub1") {
        use nostr_sdk::prelude::*;
        let pk = PublicKey::from_bech32(&npub).map_err(|e| format!("Invalid npub: {}", e))?;
        pk.to_hex()
    } else if npub.len() == 64 && npub.chars().all(|c| c.is_ascii_hexdigit()) {
        npub.clone()
    } else {
        return Err("Invalid pubkey format. Use npub1... or 64-char hex".into());
    };

    // Open per-npub database and swap it in
    let user_db_path = db_path_for_npub(&state.data_dir, &npub);
    tracing::info!("[init_nostrito] Opening per-user DB: {}", user_db_path.display());
    let new_db = Arc::new(
        Database::open(&user_db_path).map_err(|e| format!("Failed to open per-user DB: {}", e))?,
    );
    state.swap_db(new_db);

    // Save npub to lobby DB so we know which user to auto-load on next startup
    let lobby_path = lobby_db_path(&state.data_dir);
    if let Ok(lobby) = Database::open(&lobby_path) {
        lobby.set_config("npub", &npub).ok();
        lobby.set_config("hex_pubkey", &hex_pubkey).ok();
    }

    // Clear WoT graph and reload from new DB
    state.wot_graph.clear();

    // Resolve relay aliases to canonical wss:// URLs (wizard may send short aliases)
    let resolved_relays: Vec<String> = relays
        .iter()
        .map(|r| resolve_relay_alias(r).to_string())
        .collect();

    // Update config
    {
        let mut config = state.config.write().await;
        config.npub = Some(npub.clone());
        config.hex_pubkey = Some(hex_pubkey.clone());
        if !resolved_relays.is_empty() {
            config.outbound_relays = resolved_relays.clone();
        }
        if let Some(gb) = storage_others_gb {
            config.storage_others_gb = gb;
        }
        if let Some(gb) = storage_tracked_media_gb {
            config.storage_tracked_media_gb = gb;
        }
        if let Some(gb) = storage_wot_media_gb {
            config.storage_wot_media_gb = gb;
        }
        if let Some(days) = wot_retention_days {
            config.wot_event_retention_days = days;
        }
        if let Some(days) = max_event_age_days {
            config.max_event_age_days = days;
        }
    }

    // Persist to DB
    state.db()
        .set_config("npub", &npub)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    state.db()
        .set_config("hex_pubkey", &hex_pubkey)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    if !resolved_relays.is_empty() {
        state.db()
            .set_config("outbound_relays", &resolved_relays.join(","))
            .map_err(|e| format!("Failed to save relays: {}", e))?;
    }

    // Persist per-category media limits
    {
        let config = state.config.read().await;
        state.db().set_config("storage_tracked_media_gb", &config.storage_tracked_media_gb.to_string()).ok();
        state.db().set_config("storage_wot_media_gb", &config.storage_wot_media_gb.to_string()).ok();
        state.db().set_config("wot_event_retention_days", &config.wot_event_retention_days.to_string()).ok();
        state.db().set_config("max_event_age_days", &config.max_event_age_days.to_string()).ok();
    }

    // Persist storage preset key
    if let Some(ref preset_key) = storage_preset {
        state.db().set_config("storage_preset", preset_key).ok();
    }

    // Apply retention overrides (JSON string: {"follows":{"minEvents":50,"windowDays":30},...})
    if let Some(ref overrides_json) = retention_overrides {
        if let Ok(overrides) = serde_json::from_str::<serde_json::Value>(overrides_json) {
            for (tier, cfg) in overrides.as_object().into_iter().flatten() {
                if let (Some(min_events), Some(window_days)) = (
                    cfg.get("minEvents").and_then(|v| v.as_u64()),
                    cfg.get("windowDays").and_then(|v| v.as_u64()),
                ) {
                    let window_secs = window_days * 86400;
                    state.db()
                        .set_retention_config(tier, min_events as u32, window_secs)
                        .ok();
                    tracing::info!(
                        "[init_nostrito] retention override: tier={} min_events={} window_days={}",
                        tier, min_events, window_days
                    );
                }
            }
        }
    }

    // Load existing graph from DB
    state.db()
        .load_graph(&state.wot_graph)
        .map_err(|e| format!("Failed to load graph: {}", e))?;

    // Start tiered sync engine (unless offline mode is active)
    let config = state.config.read().await;
    if config.offline_mode {
        tracing::info!("[init] Offline mode active — skipping sync engine start");
    } else {
        let sync_config = SyncConfig {
            lookback_days: config.sync_lookback_days,
            batch_size: config.sync_batch_size,
            events_per_batch: config.sync_events_per_batch,
            batch_pause_secs: config.sync_batch_pause_secs,
            relay_min_interval_secs: config.sync_relay_min_interval_secs,
            wot_batch_size: config.sync_wot_batch_size,
            wot_events_per_batch: config.sync_wot_events_per_batch,
            cycle_interval_secs: config.sync_interval_secs,
            wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
            thread_retention_days: config.thread_retention_days,
        };
        let cancel = start_sync_engine(
            state.wot_graph.clone(),
            state.db(),
            config.outbound_relays.clone(),
            hex_pubkey.clone(),
            state.sync_tier.clone(),
            state.sync_stats.clone(),
            app_handle.clone(),
            config.storage_tracked_media_gb,
            config.storage_wot_media_gb,
            sync_config,
            config.max_event_age_days,
        );
        *state.sync_cancel.write().await = Some(cancel);
    }

    // Auto-setup mkcert (desktop only — needs OS trust store)
    #[cfg(desktop)]
    {
        let cert_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".nostrito/certs/localhost.pem");
        if !cert_path.exists() {
            tracing::info!("[mkcert] First launch — setting up browser integration automatically");
            let app_clone = app_handle.clone();
            match tokio::task::spawn_blocking(move || run_mkcert_setup(&app_clone)).await {
                Ok(Ok(_)) => tracing::info!("[mkcert] Browser integration ready"),
                Ok(Err(e)) => tracing::warn!("[mkcert] Setup failed (non-fatal): {}", e),
                Err(e) => tracing::warn!("[mkcert] Task panicked (non-fatal): {}", e),
            }
        }
    }

    // Auto-start relay (TLS on desktop if certs available, plain WS everywhere)
    {
        let config = state.config.read().await;
        let port = config.relay_port;
        let allowed = config.hex_pubkey.clone();
        drop(config);

        let db_relay = state.db();
        let relay_cancel = CancellationToken::new();
        let relay_cancel_clone = relay_cancel.clone();
        let outbound_tx = spawn_outbound_broadcaster(state.config.clone(), app_handle.clone());

        let cert_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".nostrito/certs/localhost.pem");
        let key_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".nostrito/certs/localhost-key.pem");

        if cert_path.exists() && key_path.exists() {
            let tls_cancel = relay_cancel_clone.clone();
            let tls_db = db_relay.clone();
            let tls_allowed = allowed.clone();
            let tls_outbound = outbound_tx.clone();
            tracing::info!("[relay] Starting TLS relay on wss://127.0.0.1:{}", port);
            tokio::spawn(async move {
                if let Err(e) =
                    relay::run_relay_tls(port, cert_path, key_path, tls_db, tls_allowed, tls_cancel, Some(tls_outbound))
                        .await
                {
                    tracing::error!("TLS relay error: {}", e);
                }
            });
            let plain_port = port + 1;
            tracing::info!("[relay] Starting plain relay on ws://127.0.0.1:{} (browser fallback)", plain_port);
            tokio::spawn(async move {
                if let Err(e) = relay::run_relay(plain_port, db_relay, allowed, relay_cancel_clone, Some(outbound_tx)).await {
                    tracing::error!("Plain relay error: {}", e);
                }
            });
        } else {
            tracing::info!("[relay] Starting plain relay on ws://127.0.0.1:{}", port);
            tokio::spawn(async move {
                if let Err(e) = relay::run_relay(port, db_relay, allowed, relay_cancel_clone, Some(outbound_tx)).await {
                    tracing::error!("Relay server error: {}", e);
                }
            });
        }

        *state.relay_cancel.write().await = Some(relay_cancel);
        tracing::info!("Relay auto-started on port {}", port);
    }

    tracing::info!("Nostrito initialized for {}", &hex_pubkey[..8]);
    Ok(())
}

#[tauri::command]
async fn get_follows(pubkey: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    tracing::debug!("[cmd:get_follows] pubkey={}...", &pubkey[..pubkey.len().min(8)]);
    match state.wot_graph.get_follows(&pubkey) {
        Some(follows) => Ok(follows),
        None => Ok(vec![]),
    }
}

#[tauri::command]
async fn get_profiles_batch(pubkeys: Vec<String>, state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    tracing::debug!("[cmd:get_profiles_batch] called for {} pubkeys", pubkeys.len());
    let profiles = state.db().get_profiles(&pubkeys).map_err(|e| e.to_string())?;
    let map: std::collections::HashMap<String, _> = profiles.into_iter().map(|p| (p.pubkey.clone(), p)).collect();
    let result = pubkeys.iter().map(|pk| {
        if let Some(p) = map.get(pk) {
            serde_json::json!({
                "pubkey": pk,
                "name": p.name,
                "display_name": p.display_name,
                "picture": p.picture,
                "picture_local": p.picture_local,
            })
        } else {
            serde_json::json!({ "pubkey": pk, "name": null, "display_name": null, "picture": null, "picture_local": null })
        }
    }).collect();
    Ok(result)
}

#[tauri::command]
async fn get_wot(state: State<'_, AppState>) -> Result<WotStatus, String> {
    tracing::debug!("[cmd:get_wot] called");
    let config = state.config.read().await;
    let stats = state.wot_graph.stats();

    tracing::info!("[cmd:get_wot] nodes={}, edges={}, with_follows={}", stats.node_count, stats.edge_count, stats.nodes_with_follows);

    Ok(WotStatus {
        root_pubkey: config.hex_pubkey.clone().unwrap_or_default(),
        node_count: stats.node_count,
        edge_count: stats.edge_count,
        nodes_with_follows: stats.nodes_with_follows,
    })
}

#[tauri::command]
async fn get_wot_distance(
    request: WotDistanceRequest,
    state: State<'_, AppState>,
) -> Result<WotDistanceResponse, String> {
    tracing::info!("[cmd:get_wot_distance] from={}..., to={}..., max_hops={:?}", &request.from[..std::cmp::min(8, request.from.len())], &request.to[..std::cmp::min(8, request.to.len())], request.max_hops);
    let query = wot::bfs::DistanceQuery {
        from: Arc::from(request.from.as_str()),
        to: Arc::from(request.to.as_str()),
        max_hops: request.max_hops.unwrap_or(3),
        include_bridges: request.include_bridges.unwrap_or(false),
    };

    let result = wot::bfs::compute_distance(&state.wot_graph, &query);

    Ok(WotDistanceResponse {
        from: result.from.to_string(),
        to: result.to.to_string(),
        hops: result.hops,
        path_count: result.path_count,
        mutual_follow: result.mutual_follow,
        bridges: result
            .bridges
            .map(|b| b.iter().map(|s| s.to_string()).collect()),
    })
}

#[tauri::command]
async fn get_wot_hop_distances(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, u8>, String> {
    let config = state.config.read().await;
    let hex_pubkey = config
        .hex_pubkey
        .clone()
        .ok_or("Not initialized — no pubkey set")?;
    drop(config);

    let distances = wot::bfs::get_all_hop_distances(&state.wot_graph, &hex_pubkey, 3);
    Ok(distances
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect())
}

#[tauri::command]
async fn start_sync(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("[cmd:start_sync] called");
    let existing = state.sync_cancel.read().await;
    if existing.is_some() {
        tracing::warn!("[cmd:start_sync] sync already running, rejecting");
        return Err("Sync already running".into());
    }
    drop(existing);

    let config = state.config.read().await;
    let hex_pubkey = config
        .hex_pubkey
        .clone()
        .ok_or("Not initialized — no pubkey set")?;

    let sync_config = SyncConfig {
        lookback_days: config.sync_lookback_days,
        batch_size: config.sync_batch_size,
        events_per_batch: config.sync_events_per_batch,
        batch_pause_secs: config.sync_batch_pause_secs,
        relay_min_interval_secs: config.sync_relay_min_interval_secs,
        wot_batch_size: config.sync_wot_batch_size,
        wot_events_per_batch: config.sync_wot_events_per_batch,
        cycle_interval_secs: config.sync_interval_secs,
        wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
        thread_retention_days: config.thread_retention_days,
    };
    let cancel = start_sync_engine(
        state.wot_graph.clone(),
        state.db(),
        config.outbound_relays.clone(),
        hex_pubkey,
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle,
        config.storage_tracked_media_gb,
        config.storage_wot_media_gb,
        sync_config,
        config.max_event_age_days,
    );
    *state.sync_cancel.write().await = Some(cancel);

    Ok(())
}

#[tauri::command]
async fn stop_sync(state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:stop_sync] called");
    let cancel = state.sync_cancel.write().await.take();
    if let Some(cancel) = cancel {
        cancel.cancel();
        state.sync_tier.store(0u8, Ordering::Relaxed);
        tracing::info!("Sync engine stopped");
    }
    Ok(())
}

#[tauri::command]
async fn set_offline_mode(
    enabled: bool,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("[cmd:set_offline_mode] enabled={}", enabled);

    // Update in-memory config
    {
        let mut config = state.config.write().await;
        config.offline_mode = enabled;
    }

    // Persist to DB
    state.db().set_config("offline_mode", if enabled { "true" } else { "false" })
        .map_err(|e| format!("Failed to save offline_mode: {}", e))?;

    if enabled {
        // Stop sync engine
        if let Some(cancel) = state.sync_cancel.write().await.take() {
            cancel.cancel();
            state.sync_tier.store(0u8, Ordering::Relaxed);
            tracing::info!("[cmd:set_offline_mode] Sync engine stopped");
        }
    } else {
        // Restart sync engine
        let config = state.config.read().await;
        if let Some(ref hex_pubkey) = config.hex_pubkey {
            // Cancel any existing sync first
            if let Some(cancel) = state.sync_cancel.write().await.take() {
                cancel.cancel();
                state.sync_tier.store(0u8, Ordering::Relaxed);
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }

            let sync_config = SyncConfig {
                lookback_days: config.sync_lookback_days,
                batch_size: config.sync_batch_size,
                events_per_batch: config.sync_events_per_batch,
                batch_pause_secs: config.sync_batch_pause_secs,
                relay_min_interval_secs: config.sync_relay_min_interval_secs,
                wot_batch_size: config.sync_wot_batch_size,
                wot_events_per_batch: config.sync_wot_events_per_batch,
                cycle_interval_secs: config.sync_interval_secs,
                wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
                thread_retention_days: config.thread_retention_days,
            };
            let cancel = start_sync_engine(
                state.wot_graph.clone(),
                state.db(),
                config.outbound_relays.clone(),
                hex_pubkey.clone(),
                state.sync_tier.clone(),
                state.sync_stats.clone(),
                app_handle,
                config.storage_tracked_media_gb,
                config.storage_wot_media_gb,
                sync_config,
                config.max_event_age_days,
            );
            drop(config);

            *state.sync_cancel.write().await = Some(cancel);
            tracing::info!("[cmd:set_offline_mode] Sync engine restarted");
        }
    }

    Ok(())
}

#[tauri::command]
async fn restart_sync(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<(), String> {
    tracing::info!("[cmd:restart_sync] called");
    // Cancel existing sync
    if let Some(cancel) = state.sync_cancel.write().await.take() {
        cancel.cancel();
        state.sync_tier.store(0u8, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // Read current config and restart
    let config = state.config.read().await;

    // Don't restart sync in offline mode
    if config.offline_mode {
        tracing::info!("[cmd:restart_sync] Offline mode active — not restarting");
        return Ok(());
    }

    let hex_pubkey = match &config.hex_pubkey {
        Some(pk) => pk.clone(),
        None => return Ok(()), // not initialized yet
    };

    let sync_config = SyncConfig {
        lookback_days: config.sync_lookback_days,
        batch_size: config.sync_batch_size,
        events_per_batch: config.sync_events_per_batch,
        batch_pause_secs: config.sync_batch_pause_secs,
        relay_min_interval_secs: config.sync_relay_min_interval_secs,
        wot_batch_size: config.sync_wot_batch_size,
        wot_events_per_batch: config.sync_wot_events_per_batch,
        cycle_interval_secs: config.sync_interval_secs,
        wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
        thread_retention_days: config.thread_retention_days,
    };

    let cancel = start_sync_engine(
        state.wot_graph.clone(),
        state.db(),
        config.outbound_relays.clone(),
        hex_pubkey,
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle.clone(),
        config.storage_tracked_media_gb,
        config.storage_wot_media_gb,
        sync_config,
        config.max_event_age_days,
    );
    drop(config);

    *state.sync_cancel.write().await = Some(cancel);

    tracing::info!("[cmd:restart_sync] Sync restarted with new config");
    Ok(())
}

/// Reset all user sync cursors so the next cycle does a full lookback fetch.
/// Used when the user wants to restart sync from scratch.
#[tauri::command]
async fn reset_sync_cursors(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<(), String> {
    tracing::info!("[cmd:reset_sync_cursors] Clearing all user cursors");
    state.db().clear_user_cursors()
        .map_err(|e| format!("Failed to clear cursors: {}", e))?;

    // Also restart sync so it picks up the cleared state immediately
    restart_sync(state, app_handle).await?;
    tracing::info!("[cmd:reset_sync_cursors] Cursors cleared — sync restarted from scratch");
    Ok(())
}

/// Reset the articles (kind 30023) backfill cursor so historical articles are re-fetched.
/// Also resets the main history cursor to trigger a full re-crawl of notes too.
/// The next sync cycle will start backfilling from now, walking backward through all history.
///
/// NOTE: This is no longer exposed as a user-facing Tauri command.
/// The sync engine handles cursor resets automatically via self-healing checks.
/// Kept as internal logic for programmatic use if needed.
#[allow(dead_code)]
#[tauri::command]
async fn resync_articles(state: State<'_, AppState>) -> Result<String, String> {
    tracing::info!("[cmd:resync_articles] Resetting article sync cursors");

    // Reset articles-specific cursor (kind 30023 backfill)
    state.db().delete_config("tier2_history_until_articles")
        .map_err(|e| format!("Failed to reset articles cursor: {}", e))?;

    // Also reset the main history cursor so notes/reposts re-backfill too
    state.db().delete_config("tier2_history_until")
        .map_err(|e| format!("Failed to reset history cursor: {}", e))?;

    tracing::info!("[cmd:resync_articles] Cursors reset — next sync cycle will re-backfill all history");
    Ok("Article sync cursors reset. Historical backfill will restart on next sync cycle.".to_string())
}

#[tauri::command]
async fn get_feed(filter: FeedFilter, state: State<'_, AppState>) -> Result<Vec<NostrEvent>, String> {
    tracing::debug!("[cmd:get_feed] called with filter: kinds={:?}, limit={:?}, since={:?}, wot_only={:?}", filter.kinds, filter.limit, filter.since, filter.wot_only);
    // If no kinds specified, default to feed-worthy kinds (no metadata like reactions, zaps, etc.)
    let feed_kinds = if filter.kinds.is_none() {
        Some(vec![1u32, 6, 30023])
    } else {
        filter.kinds
    };
    let kinds = feed_kinds.as_deref();
    let limit = filter.limit.unwrap_or(50);

    // Branch: WoT mode uses a SQL subquery (avoids SQLite parameter limit with large graphs)
    let events = if filter.wot_only.unwrap_or(false) {
        let own_pk = state.config.read().await.hex_pubkey.clone();
        state.db().query_wot_feed(own_pk.as_deref(), kinds, filter.since, filter.until, limit)
            .map_err(|e| {
                tracing::error!("[cmd:get_feed] wot query failed: {}", e);
                format!("Failed to query WoT feed: {}", e)
            })?
    } else {
        let author_vec = filter.author.map(|a| vec![a]);
        let authors = author_vec.as_deref();
        state.db().query_events(None, authors, kinds, filter.since, filter.until, limit)
            .map_err(|e| {
                tracing::error!("[cmd:get_feed] query failed: {}", e);
                format!("Failed to query events: {}", e)
            })?
    };

    tracing::info!("[cmd:get_feed] returning {} events (pre-filter)", events.len());

    // Filter out events containing muted words or hashtags
    let muted_words = state.db().get_muted_words().unwrap_or_default();
    let muted_hashtags: std::collections::HashSet<String> = state.db().get_muted_hashtags()
        .unwrap_or_default().into_iter().collect();

    let results: Vec<NostrEvent> = events
        .into_iter()
        .map(|(id, pubkey, created_at, kind, tags_json, content, sig)| {
            let tags: Vec<Vec<String>> = serde_json::from_str(&tags_json).unwrap_or_default();
            NostrEvent {
                id,
                pubkey,
                created_at: created_at as u64,
                kind: kind as u32,
                tags,
                content,
                sig,
            }
        })
        .filter(|event| {
            // Skip events containing muted words (case-insensitive)
            let content_lower = event.content.to_lowercase();
            for word in &muted_words {
                if content_lower.contains(&word.to_lowercase()) {
                    return false;
                }
            }
            // Skip events with muted hashtags
            for tag in &event.tags {
                if tag.len() >= 2 && tag[0] == "t" {
                    if muted_hashtags.contains(&tag[1].to_lowercase()) {
                        return false;
                    }
                }
            }
            true
        })
        .collect();

    tracing::info!("[cmd:get_feed] returning {} events", results.len());
    Ok(results)
}

fn rows_to_events(rows: Vec<(String, String, i64, i64, String, String, String)>) -> Vec<NostrEvent> {
    rows.into_iter()
        .map(|(id, pubkey, created_at, kind, tags_json, content, sig)| {
            let tags: Vec<Vec<String>> = serde_json::from_str(&tags_json).unwrap_or_default();
            NostrEvent {
                id,
                pubkey,
                created_at: created_at as u64,
                kind: kind as u32,
                tags,
                content,
                sig,
            }
        })
        .collect()
}

#[tauri::command]
async fn get_event(id: String, state: State<'_, AppState>) -> Result<Option<NostrEvent>, String> {
    let events = state.db().query_events(Some(&[id]), None, None, None, None, 1)
        .map_err(|e| format!("Failed to get event: {}", e))?;
    Ok(rows_to_events(events).into_iter().next())
}

#[tauri::command]
async fn get_addressable_event(
    kind: u32,
    pubkey: String,
    d_tag: String,
    state: State<'_, AppState>,
) -> Result<Option<NostrEvent>, String> {
    let rows = state.db().query_events(None, Some(&[pubkey]), Some(&[kind]), None, None, 50)
        .map_err(|e| format!("Failed to query events: {}", e))?;
    let events = rows_to_events(rows);
    // Find the one with matching d-tag
    Ok(events.into_iter().find(|ev| {
        ev.tags.iter().any(|t| t.len() >= 2 && t[0] == "d" && t[1] == d_tag)
    }))
}

#[tauri::command]
async fn get_note_replies(
    note_id: String,
    until: Option<u64>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    let own_pk = state.config.read().await.hex_pubkey.clone();
    let rows = state.db().query_events_by_tag(
        "e", &note_id,
        Some(&[1]),
        own_pk.as_deref(),
        until,
        limit.unwrap_or(50),
    ).map_err(|e| format!("Failed to get replies: {}", e))?;
    Ok(rows_to_events(rows))
}

#[tauri::command]
async fn get_note_reactions(
    note_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    let own_pk = state.config.read().await.hex_pubkey.clone();
    let rows = state.db().query_events_by_tag(
        "e", &note_id,
        Some(&[7]),
        own_pk.as_deref(),
        None,
        500,
    ).map_err(|e| format!("Failed to get reactions: {}", e))?;
    Ok(rows_to_events(rows))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadData {
    pub root: Option<NostrEvent>,
    pub replies: Vec<NostrEvent>,
    pub reactions: Vec<NostrEvent>,
    pub zaps: Vec<NostrEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionCounts {
    pub replies: u32,
    pub reposts: u32,
    pub reactions: u32,
    pub zaps: u32,
}

#[tauri::command]
async fn get_thread_events(
    root_id: String,
    state: State<'_, AppState>,
) -> Result<ThreadData, String> {
    let (root, replies, reactions, zaps) = state.db().get_thread_events(&root_id)
        .map_err(|e| format!("Failed to get thread events: {}", e))?;

    Ok(ThreadData {
        root: root.map(|(id, pubkey, created_at, kind, tags_json, content, sig)| {
            let tags: Vec<Vec<String>> = serde_json::from_str(&tags_json).unwrap_or_default();
            NostrEvent { id, pubkey, created_at: created_at as u64, kind: kind as u32, tags, content, sig }
        }),
        replies: rows_to_events(replies),
        reactions: rows_to_events(reactions),
        zaps: rows_to_events(zaps),
    })
}

#[tauri::command]
async fn get_interaction_counts(
    event_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, InteractionCounts>, String> {
    let raw = state.db().get_interaction_counts(&event_ids)
        .map_err(|e| format!("Failed to get interaction counts: {}", e))?;

    let result: std::collections::HashMap<String, InteractionCounts> = raw
        .into_iter()
        .map(|(id, (replies, reposts, reactions, zaps))| {
            (id, InteractionCounts { replies, reposts, reactions, zaps })
        })
        .collect();

    Ok(result)
}

#[tauri::command]
async fn fetch_thread_from_relays(
    root_id: String,
    skip_root: bool,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    use nostr_sdk::prelude::*;

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    let fallback_relays = cfg.outbound_relays.clone();
    drop(cfg);

    let relay_urls = resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays);
    if relay_urls.is_empty() {
        return Err("No relays available".into());
    }

    let event_id = EventId::from_hex(&root_id)
        .map_err(|e| format!("Invalid event ID: {}", e))?;

    // Fetch replies/reactions/zaps (and optionally the root event)
    let mut filters = vec![
        Filter::new().event(event_id).kinds(vec![Kind::TextNote]).limit(500),
        Filter::new().event(event_id).kinds(vec![Kind::Reaction, Kind::from(9735)]).limit(500),
    ];
    if !skip_root {
        filters.insert(0, Filter::new().id(event_id).limit(1));
    }

    let pool = crate::sync::pool::RelayPool::new();
    let events = pool.subscribe_and_collect(
        &relay_urls,
        filters,
        15,
    ).await.map_err(|e| format!("Relay fetch failed: {}", e))?;

    if events.is_empty() {
        return Ok(0);
    }

    let db = state.db();
    let graph = Arc::clone(&state.wot_graph);
    let (stored, _) = crate::sync::processing::process_events(
        &events,
        &db,
        &graph,
        &hex_pubkey,
        crate::sync::types::EventSource::ThreadContext,
        crate::sync::types::MEDIA_PRIORITY_OTHERS,
        None,
        "thread",
    );

    // Emit thread-updated event so frontend can refresh
    app_handle.emit("thread-updated", &root_id).ok();

    Ok(stored)
}

#[tauri::command]
async fn fetch_profile_content_from_relays(
    pubkey: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    use nostr_sdk::prelude::*;

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    let fallback_relays = cfg.outbound_relays.clone();
    drop(cfg);

    let relay_urls = resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays);
    if relay_urls.is_empty() {
        return Err("No relays available".into());
    }

    let pk = PublicKey::from_hex(&pubkey)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;

    // Recent notes, reposts, articles by this author
    let notes_filter = Filter::new()
        .authors(vec![pk])
        .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
        .limit(100);

    // Metadata + contact list + relay list
    let meta_filter = Filter::new()
        .authors(vec![pk])
        .kinds(vec![Kind::Metadata, Kind::ContactList, Kind::from(10002u16)])
        .limit(5);

    // Followers: kind:3 events that tag this pubkey in a "p" tag
    let followers_filter = Filter::new()
        .kind(Kind::ContactList)
        .custom_tag(SingleLetterTag::lowercase(Alphabet::P), vec![pubkey.clone()])
        .limit(500);

    let pool = crate::sync::pool::RelayPool::new();
    let events = pool.subscribe_and_collect(
        &relay_urls,
        vec![notes_filter, meta_filter, followers_filter],
        15,
    ).await.map_err(|e| format!("Relay fetch failed: {}", e))?;

    if events.is_empty() {
        app_handle.emit("profile-content-updated", &pubkey).ok();
        return Ok(0);
    }

    let db = state.db();
    let graph = Arc::clone(&state.wot_graph);
    let (stored, _) = crate::sync::processing::process_events(
        &events,
        &db,
        &graph,
        &hex_pubkey,
        crate::sync::types::EventSource::Sync,
        crate::sync::types::MEDIA_PRIORITY_OTHERS,
        None,
        "profile-fetch",
    );

    // Update profile fetched_at timestamp
    let now = chrono::Utc::now().timestamp();
    db.set_profile_fetched_at(&pubkey, now).ok();

    // Emit event so frontend can refresh
    app_handle.emit("profile-content-updated", &pubkey).ok();

    tracing::info!(
        "[cmd:fetch_profile_content] pubkey={}… stored {} events from {} relay events",
        &pubkey[..pubkey.len().min(12)],
        stored,
        events.len()
    );

    Ok(stored)
}

#[tauri::command]
async fn fetch_note_context_from_relays(
    note_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    use nostr_sdk::prelude::*;

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    let fallback_relays = cfg.outbound_relays.clone();
    drop(cfg);

    let relay_urls = resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays);
    if relay_urls.is_empty() {
        return Err("No relays available".into());
    }

    let event_id = EventId::from_hex(&note_id)
        .map_err(|e| format!("Invalid event ID: {}", e))?;

    // Fetch the event itself + replies + reactions + zaps
    let filters = vec![
        Filter::new().id(event_id).limit(1),
        Filter::new().event(event_id).kinds(vec![Kind::TextNote]).limit(500),
        Filter::new().event(event_id).kinds(vec![Kind::Reaction, Kind::from(9735u16)]).limit(500),
    ];

    let pool = crate::sync::pool::RelayPool::new();
    let events = pool.subscribe_and_collect(
        &relay_urls,
        filters,
        15,
    ).await.map_err(|e| format!("Relay fetch failed: {}", e))?;

    if events.is_empty() {
        return Ok(0);
    }

    let db = state.db();
    let graph = Arc::clone(&state.wot_graph);
    let (stored, _) = crate::sync::processing::process_events(
        &events,
        &db,
        &graph,
        &hex_pubkey,
        crate::sync::types::EventSource::ThreadContext,
        crate::sync::types::MEDIA_PRIORITY_OTHERS,
        None,
        "note-context",
    );

    // Emit thread-updated so frontend can refresh
    app_handle.emit("thread-updated", &note_id).ok();

    tracing::info!(
        "[cmd:fetch_note_context] note={}… stored {} events",
        &note_id[..note_id.len().min(12)],
        stored
    );

    Ok(stored)
}

#[tauri::command]
async fn fetch_addressable_event_from_relays(
    kind: u16,
    pubkey: String,
    d_tag: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use nostr_sdk::prelude::*;

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    let fallback_relays = cfg.outbound_relays.clone();
    drop(cfg);

    let relay_urls = resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays);
    if relay_urls.is_empty() {
        return Err("No relays available".into());
    }

    let pk = PublicKey::from_hex(&pubkey)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;

    let filter = Filter::new()
        .kind(Kind::from(kind))
        .authors(vec![pk])
        .custom_tag(SingleLetterTag::lowercase(Alphabet::D), vec![d_tag])
        .limit(1);

    let pool = crate::sync::pool::RelayPool::new();
    let events = pool.subscribe_and_collect(
        &relay_urls,
        vec![filter],
        10,
    ).await.map_err(|e| format!("Relay fetch failed: {}", e))?;

    if events.is_empty() {
        return Ok(None);
    }

    let event_id = events[0].id.to_hex();

    let db = state.db();
    let graph = Arc::clone(&state.wot_graph);
    crate::sync::processing::process_events(
        &events,
        &db,
        &graph,
        &hex_pubkey,
        crate::sync::types::EventSource::Search,
        crate::sync::types::MEDIA_PRIORITY_OTHERS,
        None,
        "naddr-fetch",
    );

    Ok(Some(event_id))
}

#[tauri::command]
async fn get_note_zaps(
    note_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    let own_pk = state.config.read().await.hex_pubkey.clone();
    let rows = state.db().query_events_by_tag(
        "e", &note_id,
        Some(&[9735]),
        own_pk.as_deref(),
        None,
        500,
    ).map_err(|e| format!("Failed to get zaps: {}", e))?;
    Ok(rows_to_events(rows))
}

#[tauri::command]
async fn fetch_global_feed(limit: Option<u32>, until: Option<u64>, kinds: Option<Vec<u32>>, state: State<'_, AppState>) -> Result<Vec<NostrEvent>, String> {
    use nostr_sdk::prelude::*;

    let lim = limit.unwrap_or(50);
    tracing::info!("[cmd:fetch_global_feed] limit={}, until={:?}, kinds={:?}", lim, until, kinds);

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    let fallback_relays = cfg.outbound_relays.clone();
    drop(cfg);

    let relay_urls = resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays);
    if relay_urls.is_empty() {
        return Err("No relays available".into());
    }

    let relay_count = relay_urls.len();
    tracing::info!("[fetch_global_feed] querying {} relays", relay_count);

    let feed_kinds = match &kinds {
        Some(k) => k.iter().map(|&n| Kind::from(n as u16)).collect(),
        None => vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote],
    };
    let mut filter = Filter::new()
        .kinds(feed_kinds)
        .limit(lim as usize);

    // Use a wider time window for article-only queries since they're published less frequently
    let articles_only = matches!(&kinds, Some(k) if k.len() == 1 && k[0] == 30023);
    let window_secs: u64 = if articles_only { 86400 * 30 } else { 86400 };

    if let Some(until_ts) = until {
        // Pagination: fetch events before this timestamp
        filter = filter.until(Timestamp::from(until_ts));
        let since_ts = until_ts.saturating_sub(window_secs);
        filter = filter.since(Timestamp::from(since_ts));
    } else {
        // Initial load
        let since_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .saturating_sub(window_secs);
        filter = filter.since(Timestamp::from(since_ts));
    }

    let client = Client::default();
    for url in &relay_urls {
        if let Err(e) = client.add_relay(url.as_str()).await {
            tracing::warn!("[fetch_global_feed] Failed to add relay {}: {}", url, e);
        }
    }
    client.connect().await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let mut notifications = client.notifications();
    let sub_id = match client.subscribe(vec![filter], None).await {
        Ok(output) => output.val,
        Err(e) => {
            client.disconnect().await.ok();
            return Err(format!("Subscribe failed: {}", e));
        }
    };

    let mut all_events: Vec<Event> = Vec::new();
    let mut eose_count: usize = 0;
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(10));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if !all_events.iter().any(|e| e.id == event.id) {
                            all_events.push(*event);
                        }
                        if all_events.len() >= lim as usize {
                            break;
                        }
                    }
                    Ok(RelayPoolNotification::Message { message, .. }) => {
                        if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                            eose_count += 1;
                            if eose_count >= relay_count {
                                break;
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            _ = &mut deadline => {
                tracing::info!("[fetch_global_feed] timeout, got {} events (eose {}/{})", all_events.len(), eose_count, relay_count);
                break;
            }
        }
    }

    client.unsubscribe(sub_id).await;
    client.disconnect().await.ok();

    // Global events are NOT persisted — they are returned as temporary data.
    // Users can explicitly save individual events via the save_event command.
    tracing::info!("[fetch_global_feed] {} events fetched (not persisted)", all_events.len());

    // Filter out muted pubkeys and events
    let muted_pubkeys: std::collections::HashSet<String> = state.db().get_muted_pubkeys()
        .unwrap_or_default().into_iter().collect();
    let muted_words = state.db().get_muted_words().unwrap_or_default();
    let muted_hashtags: std::collections::HashSet<String> = state.db().get_muted_hashtags()
        .unwrap_or_default().into_iter().collect();

    Ok(all_events
        .into_iter()
        .filter(|event| {
            // Skip muted pubkeys
            if muted_pubkeys.contains(&event.pubkey.to_hex()) {
                return false;
            }
            // Skip muted event IDs
            if state.db().is_event_muted(&event.id.to_hex()).unwrap_or(false) {
                return false;
            }
            // Skip events containing muted words (case-insensitive)
            let content_lower = event.content.to_lowercase();
            for word in &muted_words {
                if content_lower.contains(&word.to_lowercase()) {
                    return false;
                }
            }
            // Skip events with muted hashtags
            for tag in event.tags.iter() {
                let tag_slice = tag.as_slice();
                if tag_slice.len() >= 2 && tag_slice[0] == "t" {
                    if muted_hashtags.contains(&tag_slice[1].to_lowercase()) {
                        return false;
                    }
                }
            }
            true
        })
        .map(|event| {
            let tags: Vec<Vec<String>> = event.tags.iter()
                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                .collect();
            NostrEvent {
                id: event.id.to_hex(),
                pubkey: event.pubkey.to_hex(),
                created_at: event.created_at.as_u64(),
                kind: event.kind.as_u16() as u32,
                tags,
                content: event.content.to_string(),
                sig: event.sig.to_string(),
            }
        })
        .collect())
}

/// Fetch articles (kind 30023) from relays for WoT pubkeys.
/// `layer`: "follows" fetches from direct follows, "wot" from follows-of-follows.
/// `until`: optional pagination cursor (fetch articles older than this timestamp).
/// `limit`: max articles to return.
///
/// Articles are persisted to the local DB so subsequent calls to get_feed find them.
#[tauri::command]
async fn fetch_wot_articles(
    layer: String,
    until: Option<u64>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    use nostr_sdk::prelude::*;

    let lim = limit.unwrap_or(20);
    tracing::info!("[cmd:fetch_wot_articles] layer={}, until={:?}, limit={}", layer, until, lim);

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    drop(cfg);

    // Resolve pubkeys for the requested layer
    let follows = state.wot_graph.get_follows(&hex_pubkey).unwrap_or_default();

    let pubkeys: Vec<String> = if layer == "follows" {
        follows.clone()
    } else {
        // WoT layer: follows-of-follows, excluding direct follows
        let follow_set: std::collections::HashSet<&str> =
            follows.iter().map(|s| s.as_str()).collect();
        let mut fof = Vec::new();
        for f in &follows {
            if let Some(ff) = state.wot_graph.get_follows(f) {
                for pk in ff {
                    if !follow_set.contains(pk.as_str()) && pk != hex_pubkey {
                        fof.push(pk);
                    }
                }
            }
        }
        fof.sort();
        fof.dedup();
        // Sample up to 200 FoF to keep relay connections manageable
        if fof.len() > 200 {
            use rand::seq::SliceRandom;
            use rand::thread_rng;
            let mut rng = thread_rng();
            fof.shuffle(&mut rng);
            fof.truncate(200);
        }
        fof
    };

    if pubkeys.is_empty() {
        return Ok(vec![]);
    }

    // Group pubkeys by their write relays for efficient batching
    let db = state.db();
    let mut relay_to_authors: std::collections::HashMap<String, Vec<PublicKey>> =
        std::collections::HashMap::new();

    for pk in &pubkeys {
        let relays = db.get_write_relays(pk).unwrap_or_default();
        let author = match PublicKey::from_hex(pk.as_str()) {
            Ok(a) => a,
            Err(_) => continue,
        };
        if relays.is_empty() {
            // Fall back to default relays
            for r in sync::types::DEFAULT_RELAYS {
                relay_to_authors.entry(r.to_string()).or_default().push(author);
            }
        } else {
            for (url, _) in relays {
                relay_to_authors.entry(url).or_default().push(author);
            }
        }
    }

    // Cap at 10 relays to keep it fast
    let mut relay_batches: Vec<(String, Vec<PublicKey>)> = relay_to_authors.into_iter().collect();
    relay_batches.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    relay_batches.truncate(10);

    let mut all_events: Vec<Event> = Vec::new();
    let target = lim as usize;

    for (relay_url, authors) in &relay_batches {
        if all_events.len() >= target {
            break;
        }

        let mut filter = Filter::new()
            .authors(authors.clone())
            .kind(Kind::LongFormTextNote)
            .limit(target);

        if let Some(until_ts) = until {
            filter = filter.until(Timestamp::from(until_ts));
        }

        let client = Client::default();
        if let Err(e) = client.add_relay(relay_url.as_str()).await {
            tracing::warn!("[fetch_wot_articles] Failed to add relay {}: {}", relay_url, e);
            continue;
        }
        client.connect().await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let mut notifications = client.notifications();
        let sub_id = match client.subscribe(vec![filter], None).await {
            Ok(output) => output.val,
            Err(e) => {
                tracing::warn!("[fetch_wot_articles] Subscribe failed on {}: {}", relay_url, e);
                client.disconnect().await.ok();
                continue;
            }
        };

        let deadline = tokio::time::sleep(std::time::Duration::from_secs(8));
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                result = notifications.recv() => {
                    match result {
                        Ok(RelayPoolNotification::Event { event, .. }) => {
                            if !all_events.iter().any(|e| e.id == event.id) {
                                all_events.push(*event);
                            }
                            if all_events.len() >= target {
                                break;
                            }
                        }
                        Ok(RelayPoolNotification::Message { message, .. }) => {
                            if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                _ = &mut deadline => {
                    tracing::info!("[fetch_wot_articles] timeout on {}, got {} events", relay_url, all_events.len());
                    break;
                }
            }
        }

        client.unsubscribe(sub_id).await;
        client.disconnect().await.ok();
    }

    tracing::info!("[fetch_wot_articles] fetched {} articles from relays", all_events.len());

    // Persist articles to local DB
    let graph = Arc::clone(&state.wot_graph);
    let db_arc = state.db();
    sync::processing::process_events(
        &all_events,
        &db_arc,
        &graph,
        &hex_pubkey,
        sync::types::EventSource::OwnBackup,
        sync::types::MEDIA_PRIORITY_FOLLOWS,
        None,
        if layer == "follows" { "1" } else { "2" },
    );

    // Sort newest-first and return
    let mut sorted = all_events;
    sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    sorted.truncate(target);

    // Filter out muted pubkeys, events, words, and hashtags
    let muted_pubkeys: std::collections::HashSet<String> = state.db().get_muted_pubkeys()
        .unwrap_or_default().into_iter().collect();
    let muted_words = state.db().get_muted_words().unwrap_or_default();
    let muted_hashtags: std::collections::HashSet<String> = state.db().get_muted_hashtags()
        .unwrap_or_default().into_iter().collect();

    Ok(sorted
        .into_iter()
        .filter(|event| {
            if muted_pubkeys.contains(&event.pubkey.to_hex()) {
                return false;
            }
            if state.db().is_event_muted(&event.id.to_hex()).unwrap_or(false) {
                return false;
            }
            let content_lower = event.content.to_lowercase();
            for word in &muted_words {
                if content_lower.contains(&word.to_lowercase()) {
                    return false;
                }
            }
            for tag in event.tags.iter() {
                let tag_slice = tag.as_slice();
                if tag_slice.len() >= 2 && tag_slice[0] == "t" {
                    if muted_hashtags.contains(&tag_slice[1].to_lowercase()) {
                        return false;
                    }
                }
            }
            true
        })
        .map(|event| {
            let tags: Vec<Vec<String>> = event.tags.iter()
                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                .collect();
            NostrEvent {
                id: event.id.to_hex(),
                pubkey: event.pubkey.to_hex(),
                created_at: event.created_at.as_u64(),
                kind: event.kind.as_u16() as u32,
                tags,
                content: event.content.to_string(),
                sig: event.sig.to_string(),
            }
        })
        .collect())
}

#[tauri::command]
async fn save_event(event: NostrEvent, state: State<'_, AppState>) -> Result<bool, String> {
    tracing::info!("[cmd:save_event] id={}...", &event.id[..event.id.len().min(12)]);
    let tags_json = serde_json::to_string(&event.tags).unwrap_or_else(|_| "[]".to_string());
    state.db().store_event(
        &event.id,
        &event.pubkey,
        event.created_at as i64,
        event.kind,
        &tags_json,
        &event.content,
        &event.sig,
    ).map_err(|e| format!("Failed to save event: {}", e))
}

// ── Bookmarked Media Commands ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookmarkedMediaItem {
    pub event_id: String,
    pub media_url: String,
    pub event: NostrEvent,
    pub profile: serde_json::Value,
    pub bookmarked_at: u64,
}

#[tauri::command]
async fn bookmark_media(
    event_id: String,
    media_url: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    tracing::info!("[cmd:bookmark_media] event={}... url={}...", &event_id[..event_id.len().min(12)], &media_url[..media_url.len().min(40)]);
    let db = state.db();

    // Look up the event
    let rows = db.query_events(Some(&[event_id.clone()]), None, None, None, None, 1)
        .map_err(|e| format!("Failed to find event: {}", e))?;
    let event_row = rows.into_iter().next()
        .ok_or_else(|| "Event not found in local database".to_string())?;

    let event = NostrEvent {
        id: event_row.0,
        pubkey: event_row.1.clone(),
        created_at: event_row.2 as u64,
        kind: event_row.3 as u32,
        tags: serde_json::from_str(&event_row.4).unwrap_or_default(),
        content: event_row.5,
        sig: event_row.6,
    };
    let event_json = serde_json::to_string(&event).map_err(|e| e.to_string())?;

    // Look up the profile
    let profiles = db.get_profiles(&[event.pubkey.clone()]).map_err(|e| e.to_string())?;
    let profile = profiles.into_iter().next().unwrap_or(ProfileInfo {
        pubkey: event.pubkey.clone(),
        name: None,
        display_name: None,
        picture: None,
        picture_local: None,
        nip05: None,
        about: None,
        banner: None,
        website: None,
        lud16: None,
    });
    let profile_json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;

    db.bookmark_media(&event_id, &media_url, &event_json, &profile_json)
        .map_err(|e| format!("Failed to bookmark: {}", e))
}

#[tauri::command]
async fn unbookmark_media(
    event_id: String,
    media_url: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    tracing::info!("[cmd:unbookmark_media] event={}...", &event_id[..event_id.len().min(12)]);
    state.db().unbookmark_media(&event_id, &media_url)
        .map_err(|e| format!("Failed to unbookmark: {}", e))
}

#[tauri::command]
async fn is_media_bookmarked(
    event_id: String,
    media_url: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state.db().is_media_bookmarked(&event_id, &media_url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_bookmarked_media(state: State<'_, AppState>) -> Result<Vec<BookmarkedMediaItem>, String> {
    let rows = state.db().get_bookmarked_media().map_err(|e| e.to_string())?;
    Ok(rows.into_iter().filter_map(|(event_id, media_url, event_json, profile_json, bookmarked_at)| {
        let event: NostrEvent = serde_json::from_str(&event_json).ok()?;
        let profile: serde_json::Value = serde_json::from_str(&profile_json).unwrap_or(serde_json::Value::Null);
        Some(BookmarkedMediaItem { event_id, media_url, event, profile, bookmarked_at: bookmarked_at as u64 })
    }).collect())
}

#[tauri::command]
async fn find_event_for_media(
    media_url: String,
    pubkey: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<NostrEvent>, String> {
    let row = state.db()
        .find_event_by_media_url(&media_url, pubkey.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(row.map(|(id, pk, created_at, kind, tags_json, content, sig)| {
        NostrEvent {
            id,
            pubkey: pk,
            created_at: created_at as u64,
            kind: kind as u32,
            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            content,
            sig,
        }
    }))
}

#[tauri::command]
async fn delete_media_files(
    urls: Vec<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    if urls.is_empty() {
        return Ok(0);
    }
    tracing::info!("[cmd:delete_media_files] deleting {} media file(s)", urls.len());
    let db = state.db();
    let lookup = db
        .media_cache_lookup_by_urls(&urls)
        .map_err(|e| format!("Failed to lookup media: {}", e))?;

    let mut deleted = 0u32;
    let mut hashes = Vec::new();
    for (_url, (hash, _mime, _size, _ts)) in &lookup {
        let path = sync::media::media_file_path(hash);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                tracing::warn!("[cmd:delete_media_files] failed to delete {}: {}", path.display(), e);
            } else {
                deleted += 1;
            }
        }
        hashes.push(hash.clone());
    }

    if !hashes.is_empty() {
        db.media_delete_records(&hashes)
            .map_err(|e| format!("Failed to delete media records: {}", e))?;
    }

    // Mark URLs as deleted so they don't reappear in the gallery
    db.media_mark_deleted(&urls)
        .map_err(|e| format!("Failed to mark media as deleted: {}", e))?;

    tracing::info!("[cmd:delete_media_files] deleted {} files, {} db records, marked {} urls", deleted, hashes.len(), urls.len());

    // Notify frontend to refresh storage stats
    let _ = app_handle.emit("media-deleted", deleted);

    Ok(deleted)
}

#[tauri::command]
async fn fetch_events_by_ids(ids: Vec<String>, state: State<'_, AppState>) -> Result<Vec<NostrEvent>, String> {
    use nostr_sdk::prelude::*;

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    tracing::info!("[cmd:fetch_events_by_ids] fetching {} event(s) from relays", ids.len());

    let cfg = state.config.read().await;
    let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
    let fallback_relays = cfg.outbound_relays.clone();
    drop(cfg);

    let relay_urls = resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays);
    if relay_urls.is_empty() {
        return Err("No relays available".into());
    }

    let event_ids: Vec<EventId> = ids.iter()
        .filter_map(|id| EventId::from_hex(id).ok())
        .collect();

    if event_ids.is_empty() {
        return Err("No valid event IDs".into());
    }

    let filter = Filter::new().ids(event_ids).limit(ids.len());

    let client = Client::default();
    for url in &relay_urls {
        if let Err(e) = client.add_relay(url.as_str()).await {
            tracing::warn!("[fetch_events_by_ids] Failed to add relay {}: {}", url, e);
        }
    }
    client.connect().await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let mut notifications = client.notifications();
    let sub_id = match client.subscribe(vec![filter], None).await {
        Ok(output) => output.val,
        Err(e) => {
            client.disconnect().await.ok();
            return Err(format!("Subscribe failed: {}", e));
        }
    };

    let mut all_events: Vec<Event> = Vec::new();
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(10));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if !all_events.iter().any(|e| e.id == event.id) {
                            all_events.push(*event);
                        }
                    }
                    Ok(RelayPoolNotification::Message { message, .. }) => {
                        if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            _ = &mut deadline => {
                tracing::info!("[fetch_events_by_ids] timeout, got {} events", all_events.len());
                break;
            }
        }
    }

    client.unsubscribe(sub_id).await;
    client.disconnect().await.ok();

    tracing::info!("[fetch_events_by_ids] {} events fetched", all_events.len());

    Ok(all_events
        .into_iter()
        .map(|event| {
            let tags: Vec<Vec<String>> = event.tags.iter()
                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                .collect();
            NostrEvent {
                id: event.id.to_hex(),
                pubkey: event.pubkey.to_hex(),
                created_at: event.created_at.as_u64(),
                kind: event.kind.as_u16() as u32,
                tags,
                content: event.content.to_string(),
                sig: event.sig.to_string(),
            }
        })
        .collect())
}

#[tauri::command]
async fn search_events(query: String, limit: Option<u32>, state: State<'_, AppState>) -> Result<Vec<NostrEvent>, String> {
    tracing::info!("[cmd:search_events] query={:?}, limit={:?}", query, limit);
    let lim = limit.unwrap_or(50);

    // Determine if query is an npub/hex pubkey or a keyword search
    let mut author_filter: Option<String> = None;
    let mut keyword: Option<String> = None;

    let trimmed = query.trim();

    if trimmed.starts_with("npub1") {
        // Decode npub to hex
        use nostr_sdk::prelude::*;
        match PublicKey::from_bech32(trimmed) {
            Ok(pk) => { author_filter = Some(pk.to_hex()); },
            Err(_) => { keyword = Some(trimmed.to_string()); },
        }
    } else if trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        // Hex pubkey
        author_filter = Some(trimmed.to_string());
    } else {
        // Keyword search
        keyword = Some(trimmed.to_string());
    }

    let events = state.db()
        .search_events(keyword.as_deref(), author_filter.as_deref(), lim)
        .map_err(|e| {
            tracing::error!("[cmd:search_events] query failed: {}", e);
            format!("Search failed: {}", e)
        })?;

    tracing::info!("[cmd:search_events] returning {} events", events.len());

    Ok(events
        .into_iter()
        .map(|(id, pubkey, created_at, kind, tags_json, content, sig)| {
            let tags: Vec<Vec<String>> = serde_json::from_str(&tags_json).unwrap_or_default();
            NostrEvent {
                id,
                pubkey,
                created_at: created_at as u64,
                kind: kind as u32,
                tags,
                content,
                sig,
            }
        })
        .collect())
}

#[tauri::command]
async fn search_global(query: String, limit: Option<u32>, state: State<'_, AppState>) -> Result<Vec<NostrEvent>, String> {
    use nostr_sdk::prelude::*;

    let lim = limit.unwrap_or(50) as usize;
    let trimmed = query.trim().to_string();
    tracing::info!("[cmd:search_global] query={:?}, limit={}", trimmed, lim);

    // Determine query type
    let mut author_hex: Option<String> = None;

    if trimmed.starts_with("npub1") {
        if let Ok(pk) = PublicKey::from_bech32(&trimmed) {
            author_hex = Some(pk.to_hex());
        }
    } else if trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        author_hex = Some(trimmed.clone());
    }

    // For author queries, use sync relays; for text queries, use NIP-50 search relays
    let relay_urls: Vec<String> = if author_hex.is_some() {
        let cfg = state.config.read().await;
        let hex_pubkey = cfg.hex_pubkey.clone().unwrap_or_default();
        let fallback_relays = cfg.outbound_relays.clone();
        drop(cfg);
        resolve_sync_relays(&state.db(), &hex_pubkey, &fallback_relays)
    } else {
        // NIP-50 search relays that support full-text search
        vec![
            "wss://relay.nostr.band".to_string(),
            "wss://search.nos.today".to_string(),
            "wss://nostr.wine".to_string(),
        ]
    };

    if relay_urls.is_empty() {
        return Ok(Vec::new());
    }

    let filter = if let Some(ref author) = author_hex {
        Filter::new()
            .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
            .authors(vec![PublicKey::from_hex(author).map_err(|e| format!("Invalid pubkey: {}", e))?])
            .limit(lim)
    } else {
        // NIP-50 full-text search filter
        Filter::new()
            .kinds(vec![Kind::TextNote, Kind::LongFormTextNote])
            .search(&trimmed)
            .limit(lim)
    };

    let client = Client::default();
    for url in &relay_urls {
        if let Err(e) = client.add_relay(url.as_str()).await {
            tracing::warn!("[search_global] Failed to add relay {}: {}", url, e);
        }
    }
    client.connect().await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let mut notifications = client.notifications();
    let sub_id = match client.subscribe(vec![filter], None).await {
        Ok(output) => output.val,
        Err(e) => {
            client.disconnect().await.ok();
            return Err(format!("Subscribe failed: {}", e));
        }
    };

    let mut all_events: Vec<Event> = Vec::new();
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(10));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if !all_events.iter().any(|e| e.id == event.id) {
                            all_events.push(*event);
                        }
                    }
                    Ok(RelayPoolNotification::Message { message, .. }) => {
                        if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            _ = &mut deadline => {
                tracing::info!("[search_global] timeout, got {} events", all_events.len());
                break;
            }
        }
    }

    client.unsubscribe(sub_id).await;
    client.disconnect().await.ok();

    let results: Vec<&Event> = all_events.iter().take(lim).collect();

    // Store matching events in DB
    for event in &results {
        let tags_json = serde_json::to_string(
            &event.tags.iter().map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<String>>()).collect::<Vec<Vec<String>>>()
        ).unwrap_or_else(|_| "[]".to_string());

        state.db().store_event(
            &event.id.to_hex(),
            &event.pubkey.to_hex(),
            event.created_at.as_u64() as i64,
            event.kind.as_u16() as u32,
            &tags_json,
            &event.content.to_string(),
            &event.sig.to_string(),
        ).ok();
    }

    tracing::info!("[search_global] {} results from NIP-50 search", results.len());

    // Filter out muted pubkeys
    let muted_pubkeys: std::collections::HashSet<String> = state.db().get_muted_pubkeys()
        .unwrap_or_default().into_iter().collect();

    Ok(results
        .into_iter()
        .filter(|event| !muted_pubkeys.contains(&event.pubkey.to_hex()))
        .map(|event| {
            let tags: Vec<Vec<String>> = event.tags.iter()
                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect())
                .collect();
            NostrEvent {
                id: event.id.to_hex(),
                pubkey: event.pubkey.to_hex(),
                created_at: event.created_at.as_u64(),
                kind: event.kind.as_u16() as u32,
                tags,
                content: event.content.to_string(),
                sig: event.sig.to_string(),
            }
        })
        .collect())
}

#[tauri::command]
async fn get_storage_stats(state: State<'_, AppState>) -> Result<StorageStats, String> {
    tracing::debug!("[cmd:get_storage_stats] called");
    let total_events = state.db().event_count().map_err(|e| e.to_string())?;
    let db_size_bytes = state.db().db_size_bytes().map_err(|e| e.to_string())?;
    let (oldest_event, newest_event) = state.db().event_time_range().map_err(|e| e.to_string())?;

    tracing::info!("[cmd:get_storage_stats] events={}, db_size={} bytes, range={}..{}", total_events, db_size_bytes, oldest_event, newest_event);

    Ok(StorageStats {
        total_events,
        db_size_bytes,
        oldest_event,
        newest_event,
    })
}

#[tauri::command]
async fn get_ownership_storage_stats(state: State<'_, AppState>) -> Result<OwnershipStorageStats, String> {
    tracing::debug!("[cmd:get_ownership_storage_stats] called");
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    if own_pubkey.is_empty() {
        return Err("Not initialized — no pubkey set".into());
    }

    let db = state.db();

    // Use batch query (2 SQL calls instead of 7+)
    let (own_events_count, tracked_events_count, wot_events_count, total_events,
         own_media_bytes, tracked_media_bytes, wot_media_bytes, db_size_bytes) =
        db.get_ownership_stats_batch(&own_pubkey).map_err(|e| e.to_string())?;

    tracing::info!(
        "[cmd:get_ownership_storage_stats] own={}/{}, tracked={}/{}, wot={}/{}",
        own_events_count, own_media_bytes,
        tracked_events_count, tracked_media_bytes,
        wot_events_count, wot_media_bytes,
    );

    Ok(OwnershipStorageStats {
        own_events_count,
        own_media_bytes,
        tracked_events_count,
        tracked_media_bytes,
        wot_events_count,
        wot_media_bytes,
        total_events,
        db_size_bytes,
    })
}

#[tauri::command]
async fn prune_wot_data(state: State<'_, AppState>) -> Result<String, String> {
    tracing::info!("[cmd:prune_wot_data] called");
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    if own_pubkey.is_empty() {
        return Err("Not initialized — no pubkey set".into());
    }

    let db = state.db();
    let graph = &state.wot_graph;
    let stats = sync::pruning::run_pruning(&db, graph, &own_pubkey)
        .map_err(|e| format!("Pruning failed: {}", e))?;

    let msg = format!(
        "Pruned {} events (follows={}, fof={}, hop3={}, others={})",
        stats.total(),
        stats.follows_pruned,
        stats.fof_pruned,
        stats.hop3_pruned,
        stats.others_pruned,
    );
    tracing::info!("[cmd:prune_wot_data] {}", msg);
    Ok(msg)
}

#[tauri::command]
async fn get_storage_estimate(state: State<'_, AppState>) -> Result<StorageEstimateResponse, String> {
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    if own_pubkey.is_empty() {
        return Err("Not initialized — no pubkey set".into());
    }

    let db = state.db();
    let estimate = storage::estimation::estimate_storage(&db, &state.wot_graph, &own_pubkey)
        .map_err(|e| format!("Estimation failed: {}", e))?;

    Ok(StorageEstimateResponse {
        follows_count: estimate.follows_count,
        fof_estimate: estimate.fof_estimate,
        events_per_day: estimate.events_per_day,
        bytes_per_day: estimate.bytes_per_day,
        projected_30d_bytes: estimate.projected_30d_bytes,
        current_db_size: estimate.current_db_size,
    })
}

#[tauri::command]
async fn start_relay(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:start_relay] called");
    let existing = state.relay_cancel.read().await;
    if existing.is_some() {
        tracing::warn!("[cmd:start_relay] relay already running, rejecting");
        return Err("Relay already running".into());
    }
    drop(existing);

    let config = state.config.read().await;
    let port = config.relay_port;
    let allowed_pubkey = config.hex_pubkey.clone();
    drop(config);

    let db = state.db();
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();
    let outbound_tx = spawn_outbound_broadcaster(state.config.clone(), app_handle);

    let cert_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".nostrito/certs/localhost.pem");
    let key_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".nostrito/certs/localhost-key.pem");

    if cert_path.exists() && key_path.exists() {
        let tls_cancel = cancel_clone.clone();
        let tls_db = db.clone();
        let tls_allowed = allowed_pubkey.clone();
        let tls_outbound = outbound_tx.clone();
        tracing::info!("[relay] Starting TLS relay on wss://127.0.0.1:{}", port);
        tokio::spawn(async move {
            if let Err(e) =
                relay::run_relay_tls(port, cert_path, key_path, tls_db, tls_allowed, tls_cancel, Some(tls_outbound))
                    .await
            {
                tracing::error!("TLS relay error: {}", e);
            }
        });
        let plain_port = port + 1;
        tracing::info!("[relay] Starting plain relay on ws://127.0.0.1:{} (browser fallback)", plain_port);
        tokio::spawn(async move {
            if let Err(e) = relay::run_relay(plain_port, db, allowed_pubkey, cancel_clone, Some(outbound_tx)).await {
                tracing::error!("Plain relay error: {}", e);
            }
        });
    } else {
        tracing::info!("[relay] Starting plain relay on ws://127.0.0.1:{}", port);
        tokio::spawn(async move {
            if let Err(e) = relay::run_relay(port, db, allowed_pubkey, cancel_clone, Some(outbound_tx)).await {
                tracing::error!("Relay server error: {}", e);
            }
        });
    }

    *state.relay_cancel.write().await = Some(cancel);
    tracing::info!("Relay server started on port {}", port);
    Ok(())
}

#[tauri::command]
async fn stop_relay(state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:stop_relay] called");
    let cancel = state.relay_cancel.write().await.take();
    if let Some(cancel) = cancel {
        cancel.cancel();
        tracing::info!("Relay server stopped");
    }
    Ok(())
}

#[tauri::command]
async fn get_uptime(state: State<'_, AppState>) -> Result<u64, String> {
    let secs = state.start_time.elapsed().as_secs();
    tracing::debug!("[cmd:get_uptime] {}s", secs);
    Ok(secs)
}

#[tauri::command]
async fn reset_app_data(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("Resetting app data — clearing DB, config, and graph");

    // Stop sync if running
    if let Some(cancel) = state.sync_cancel.write().await.take() {
        cancel.cancel();
        state
            .sync_tier
            .store(0u8, Ordering::Relaxed);
    }

    // Stop relay if running
    if let Some(cancel) = state.relay_cancel.write().await.take() {
        cancel.cancel();
    }

    // Clear database
    state.db()
        .clear_all()
        .map_err(|e| format!("Failed to clear database: {}", e))?;

    // Clear in-memory WoT graph
    state.wot_graph.clear();

    // Reset sync stats
    {
        let mut stats = state.sync_stats.write().await;
        *stats = SyncStats::default();
    }

    // Reset config to defaults (no npub)
    {
        let mut config = state.config.write().await;
        *config = AppConfig::default();
    }

    // Emit event to frontend to show wizard
    app_handle.emit("app:reset", ()).ok();

    tracing::info!("App data reset complete");
    Ok(())
}

/// Change account: clears only identity (npub/hex_pubkey) and sync cursors,
/// keeps all event data, WoT graph edges, settings, and media intact.
/// When the user re-enters an npub that already has events in the DB,
/// the existing data is reused (fast account switching).
#[tauri::command]
async fn change_account(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("Changing account — switching to lobby DB");

    // Stop sync if running
    if let Some(cancel) = state.sync_cancel.write().await.take() {
        cancel.cancel();
        state.sync_tier.store(0u8, Ordering::Relaxed);
    }

    // Stop relay if running
    if let Some(cancel) = state.relay_cancel.write().await.take() {
        cancel.cancel();
    }

    // Clear nsec and bunker from keychain
    {
        let config = state.config.read().await;
        if let Some(ref npub) = config.npub {
            delete_nsec_from_keychain(npub);
            delete_bunker_from_keychain(npub);
        }
    }

    // Shutdown NIP-46 signer if active
    {
        let mut nip46 = state.nip46_signer.write().await;
        if let Some(signer) = nip46.take() {
            if let Err(e) = signer.shutdown().await {
                tracing::warn!("[change_account] NIP-46 shutdown error: {}", e);
            }
        }
    }

    // Swap to lobby DB — the per-user DB keeps all data intact for later
    let lobby_path = lobby_db_path(&state.data_dir);
    let lobby_db = Arc::new(
        Database::open(&lobby_path).map_err(|e| format!("Failed to open lobby DB: {}", e))?,
    );
    state.swap_db(lobby_db);

    // Clear npub from lobby so startup doesn't auto-load the old user
    state.db().delete_config("npub").ok();
    state.db().delete_config("hex_pubkey").ok();

    // Clear WoT graph
    state.wot_graph.clear();

    // Reset sync stats
    {
        let mut stats = state.sync_stats.write().await;
        *stats = SyncStats::default();
    }

    // Clear identity from in-memory config (keep relay/storage settings)
    {
        let mut config = state.config.write().await;
        config.npub = None;
        config.hex_pubkey = None;
        config.nsec = None;
        config.signing_mode = "read-only".to_string();
    }

    // Emit event to frontend to show wizard
    app_handle.emit("app:reset", ()).ok();

    tracing::info!("Account change complete — switched to lobby DB, user data preserved");
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RelayStatusInfo {
    pub url: String,
    pub name: String,
    pub connected: bool,
    pub latency_ms: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KindCounts {
    pub counts: std::collections::HashMap<u32, u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackedProfileDetail {
    pub pubkey: String,
    pub tracked_at: i64,
    pub note: Option<String>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub picture: Option<String>,
    pub picture_local: Option<String>,
    pub event_count: u64,
    pub media_bytes: u64,
    pub media_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MediaBreakdown {
    pub image_count: u64,
    pub image_bytes: u64,
    pub video_count: u64,
    pub video_bytes: u64,
    pub audio_count: u64,
    pub audio_bytes: u64,
    pub other_count: u64,
    pub other_bytes: u64,
    pub total_count: u64,
    pub total_bytes: u64,
    pub oldest_media: i64,
    pub newest_media: i64,
}

#[tauri::command]
async fn get_activity_data(state: State<'_, AppState>) -> Result<Vec<u64>, String> {
    tracing::debug!("[cmd:get_activity_data] called");
    let counts = state.db().get_hourly_counts(24).map_err(|e| e.to_string())?;
    let total: u64 = counts.iter().sum();
    tracing::debug!("[cmd:get_activity_data] 24h total={}", total);
    Ok(counts)
}

#[tauri::command]
async fn get_relay_status(state: State<'_, AppState>) -> Result<Vec<RelayStatusInfo>, String> {
    tracing::debug!("[cmd:get_relay_status] called");
    let config = state.config.read().await;
    let mut relays = config.outbound_relays.clone();
    drop(config);

    // Filter out empty strings and fall back to defaults if nothing valid remains
    relays.retain(|r| !r.trim().is_empty());
    if relays.is_empty() {
        relays = vec![
            "wss://relay.damus.io".into(),
            "wss://relay.primal.net".into(),
            "wss://nos.lol".into(),
        ];
    }

    tracing::debug!("[cmd:get_relay_status] checking {} relays concurrently", relays.len());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("nostrito/0.1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Check all relays concurrently via NIP-11 info endpoint
    let futures: Vec<_> = relays
        .iter()
        .map(|url| {
            let client = client.clone();
            let url = url.clone();
            async move {
                let name = url
                    .replace("wss://", "")
                    .replace("ws://", "")
                    .replace("relay.", "")
                    .trim_end_matches('/')
                    .to_string();

                // Convert wss:// → https:// or ws:// → http:// for NIP-11 info request
                let http_url = url
                    .replace("wss://", "https://")
                    .replace("ws://", "http://");

                let start = std::time::Instant::now();
                let result = client
                    .get(&http_url)
                    .header("Accept", "application/nostr+json")
                    .send()
                    .await;

                match result {
                    Ok(_response) => {
                        let latency = start.elapsed().as_millis() as u32;
                        tracing::debug!("[relay_status] {} — connected ({}ms)", url, latency);
                        RelayStatusInfo {
                            url,
                            name,
                            connected: true,
                            latency_ms: Some(latency),
                        }
                    }
                    Err(e) => {
                        tracing::debug!("[relay_status] {} — failed: {}", url, e);
                        RelayStatusInfo {
                            url,
                            name,
                            connected: false,
                            latency_ms: None,
                        }
                    }
                }
            }
        })
        .collect();

    let results = futures_util::future::join_all(futures).await;
    tracing::info!(
        "[cmd:get_relay_status] {} relays checked: {} connected",
        results.len(),
        results.iter().filter(|r| r.connected).count()
    );

    Ok(results)
}

#[tauri::command]
async fn get_kind_counts(state: State<'_, AppState>) -> Result<KindCounts, String> {
    tracing::debug!("[cmd:get_kind_counts] called");
    let counts = state.db().get_kind_counts().map_err(|e| e.to_string())?;
    tracing::info!("[cmd:get_kind_counts] {} distinct kinds found", counts.len());
    Ok(KindCounts { counts })
}

#[tauri::command]
async fn get_dm_events(
    own_pubkey: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    tracing::debug!("[cmd:get_dm_events] called for pubkey={}..., limit={:?}", &own_pubkey[..std::cmp::min(8, own_pubkey.len())], limit);
    let lim = limit.unwrap_or(200);
    let events = state.db()
        .get_dm_events(&own_pubkey, lim)
        .map_err(|e| format!("Failed to query DM events: {}", e))?;

    tracing::info!("[cmd:get_dm_events] returning {} DM events", events.len());

    Ok(events
        .into_iter()
        .map(|(id, pubkey, created_at, kind, tags_json, content, sig)| {
            let tags: Vec<Vec<String>> = serde_json::from_str(&tags_json).unwrap_or_default();
            NostrEvent {
                id,
                pubkey,
                created_at: created_at as u64,
                kind: kind as u32,
                tags,
                content,
                sig,
            }
        })
        .collect())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    tracing::debug!("[cmd:get_settings] called");
    let config = state.config.read().await;
    tracing::info!("[cmd:get_settings] port={}, relays={}, wot_depth={}", config.relay_port, config.outbound_relays.len(), config.wot_max_depth);
    Ok(Settings {
        npub: config.npub.clone().unwrap_or_default(),
        relay_port: config.relay_port,
        max_storage_mb: config.max_storage_mb,
        storage_others_gb: config.storage_others_gb,
        storage_media_gb: config.storage_media_gb,
        storage_own_media_gb: config.storage_own_media_gb,
        storage_tracked_media_gb: config.storage_tracked_media_gb,
        storage_wot_media_gb: config.storage_wot_media_gb,
        wot_event_retention_days: config.wot_event_retention_days,
        thread_retention_days: config.thread_retention_days,
        wot_max_depth: config.wot_max_depth,
        sync_interval_secs: config.sync_interval_secs,
        outbound_relays: config.outbound_relays.clone(),
        auto_start: config.auto_start,
        sync_lookback_days: config.sync_lookback_days,
        sync_batch_size: config.sync_batch_size,
        sync_events_per_batch: config.sync_events_per_batch,
        sync_batch_pause_secs: config.sync_batch_pause_secs,
        sync_relay_min_interval_secs: config.sync_relay_min_interval_secs,
        sync_wot_batch_size: config.sync_wot_batch_size,
        sync_wot_events_per_batch: config.sync_wot_events_per_batch,
        max_event_age_days: config.max_event_age_days,
        sync_wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
        offline_mode: config.offline_mode,
    })
}

#[tauri::command]
async fn save_settings(settings: Settings, app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:save_settings] called — port={}, relays={:?}, wot_depth={}, sync_interval={}s", settings.relay_port, settings.outbound_relays, settings.wot_max_depth, settings.sync_interval_secs);
    let mut config = state.config.write().await;
    config.relay_port = settings.relay_port;
    config.max_storage_mb = settings.max_storage_mb;
    config.storage_others_gb = settings.storage_others_gb;
    config.storage_media_gb = settings.storage_media_gb;
    config.storage_own_media_gb = settings.storage_own_media_gb;
    config.storage_tracked_media_gb = settings.storage_tracked_media_gb;
    config.storage_wot_media_gb = settings.storage_wot_media_gb;
    config.wot_event_retention_days = settings.wot_event_retention_days;
    config.thread_retention_days = settings.thread_retention_days;
    config.wot_max_depth = settings.wot_max_depth;
    config.sync_interval_secs = settings.sync_interval_secs;
    // Only update relays if the new list has valid entries — never clear to empty
    let valid_relays: Vec<String> = settings.outbound_relays.iter()
        .map(|r| sync::resolve_relay_url(r).to_string())
        .filter(|r| !r.trim().is_empty())
        .collect();
    let relays_changed = !valid_relays.is_empty() && valid_relays != config.outbound_relays;
    if !valid_relays.is_empty() {
        config.outbound_relays = valid_relays.clone();
    }
    config.auto_start = settings.auto_start;
    config.sync_lookback_days = settings.sync_lookback_days;
    config.sync_batch_size = settings.sync_batch_size;
    config.sync_events_per_batch = settings.sync_events_per_batch;
    config.sync_batch_pause_secs = settings.sync_batch_pause_secs;
    config.sync_relay_min_interval_secs = settings.sync_relay_min_interval_secs;
    config.sync_wot_batch_size = settings.sync_wot_batch_size;
    config.sync_wot_events_per_batch = settings.sync_wot_events_per_batch;
    config.max_event_age_days = settings.max_event_age_days;
    config.sync_wot_notes_per_cycle = settings.sync_wot_notes_per_cycle;
    config.offline_mode = settings.offline_mode;

    // Persist ALL settings to DB so they survive restart
    drop(config);
    let db = state.db();

    // Persist relay list — use the FILTERED/RESOLVED list, not the raw input.
    // BUG FIX: previously persisted raw settings.outbound_relays which could
    // contain empty strings or unresolved aliases.
    if !valid_relays.is_empty() {
        db.set_config("outbound_relays", &valid_relays.join(","))
            .map_err(|e| format!("Failed to save relays: {}", e))?;
        tracing::info!("[cmd:save_settings] Persisted {} relays to DB: {:?}", valid_relays.len(), valid_relays);
    }

    // Persist other settings that were previously missing
    db.set_config("relay_port", &settings.relay_port.to_string()).ok();
    db.set_config("max_storage_mb", &settings.max_storage_mb.to_string()).ok();
    db.set_config("storage_others_gb", &settings.storage_others_gb.to_string()).ok();
    db.set_config("storage_media_gb", &settings.storage_media_gb.to_string()).ok();
    db.set_config("wot_max_depth", &settings.wot_max_depth.to_string()).ok();
    db.set_config("sync_interval_secs", &settings.sync_interval_secs.to_string()).ok();

    // Persist sync tuning config
    db.set_config("sync_lookback_days", &settings.sync_lookback_days.to_string()).ok();
    db.set_config("sync_batch_size", &settings.sync_batch_size.to_string()).ok();
    db.set_config("sync_events_per_batch", &settings.sync_events_per_batch.to_string()).ok();
    db.set_config("sync_batch_pause_secs", &settings.sync_batch_pause_secs.to_string()).ok();
    db.set_config("sync_relay_min_interval_secs", &settings.sync_relay_min_interval_secs.to_string()).ok();
    db.set_config("sync_wot_batch_size", &settings.sync_wot_batch_size.to_string()).ok();
    db.set_config("sync_wot_events_per_batch", &settings.sync_wot_events_per_batch.to_string()).ok();
    db.set_config("max_event_age_days", &settings.max_event_age_days.to_string()).ok();
    db.set_config("sync_wot_notes_per_cycle", &settings.sync_wot_notes_per_cycle.to_string()).ok();
    db.set_config("offline_mode", if settings.offline_mode { "true" } else { "false" }).ok();
    db.set_config("storage_own_media_gb", &settings.storage_own_media_gb.to_string()).ok();
    db.set_config("storage_tracked_media_gb", &settings.storage_tracked_media_gb.to_string()).ok();
    db.set_config("storage_wot_media_gb", &settings.storage_wot_media_gb.to_string()).ok();
    db.set_config("wot_event_retention_days", &settings.wot_event_retention_days.to_string()).ok();
    db.set_config("thread_retention_days", &settings.thread_retention_days.to_string()).ok();

    // If relays changed, clear user cursors so the next cycle does a full lookback
    if relays_changed {
        tracing::info!("[cmd:save_settings] Relays changed — clearing user cursors for fresh sync");
        db.clear_user_cursors().ok();
    }

    // ── Restart sync engine with new settings (especially relay changes) ──
    // Without this, relay changes in Settings only take effect on app restart.
    // Cancel existing sync, then start a new engine with the fresh config.
    if let Some(cancel) = state.sync_cancel.write().await.take() {
        cancel.cancel();
        state.sync_tier.store(0u8, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // In offline mode, don't restart the sync engine — just leave it stopped
    if settings.offline_mode {
        tracing::info!("[cmd:save_settings] Offline mode enabled — sync engine not restarted");
        return Ok(());
    }

    let config = state.config.read().await;
    if let Some(ref hex_pubkey) = config.hex_pubkey {
        let sync_config = SyncConfig {
            lookback_days: config.sync_lookback_days,
            batch_size: config.sync_batch_size,
            events_per_batch: config.sync_events_per_batch,
            batch_pause_secs: config.sync_batch_pause_secs,
            relay_min_interval_secs: config.sync_relay_min_interval_secs,
            wot_batch_size: config.sync_wot_batch_size,
            wot_events_per_batch: config.sync_wot_events_per_batch,
            cycle_interval_secs: config.sync_interval_secs,
            wot_notes_per_cycle: config.sync_wot_notes_per_cycle,
            thread_retention_days: config.thread_retention_days,
        };
        let cancel = start_sync_engine(
            state.wot_graph.clone(),
            state.db(),
            config.outbound_relays.clone(),
            hex_pubkey.clone(),
            state.sync_tier.clone(),
            state.sync_stats.clone(),
            app_handle.clone(),
            config.storage_tracked_media_gb,
            config.storage_wot_media_gb,
            sync_config,
            config.max_event_age_days,
        );
        drop(config);

        *state.sync_cancel.write().await = Some(cancel);
        tracing::info!("[cmd:save_settings] Sync engine restarted with new settings");
    }

    Ok(())
}

#[tauri::command]
async fn get_followers(pubkey: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    tracing::debug!("[cmd:get_followers] pubkey={}...", &pubkey[..pubkey.len().min(8)]);
    match state.wot_graph.get_followers(&pubkey) {
        Some(followers) => Ok(followers),
        None => Ok(vec![]),
    }
}

#[tauri::command]
async fn is_tracked_profile(pubkey: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.db().is_tracked(&pubkey).map_err(|e| e.to_string())
}

#[tauri::command]
async fn is_pubkey_muted_cmd(pubkey: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.db().is_pubkey_muted(&pubkey).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mute_pubkey(pubkey: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db().mute_pubkey(&pubkey).map_err(|e| e.to_string())
}

#[tauri::command]
async fn unmute_pubkey(pubkey: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db().unmute_pubkey(&pubkey).map_err(|e| e.to_string())
}

#[tauri::command]
async fn hex_to_npub(pubkey: String) -> Result<String, String> {
    use nostr_sdk::prelude::*;
    let pk = PublicKey::from_hex(&pubkey).map_err(|e| format!("Invalid pubkey: {}", e))?;
    Ok(pk.to_bech32().map_err(|e| format!("Bech32 error: {}", e))?)
}

#[tauri::command]
async fn track_profile(pubkey: String, note: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    use nostr_sdk::prelude::*;
    let trimmed = pubkey.trim();
    // Normalize npub/hex to hex pubkey
    let hex_pk = if trimmed.starts_with("npub") {
        PublicKey::from_bech32(trimmed)
            .map(|pk| pk.to_hex())
            .map_err(|e| format!("Invalid npub: {}", e))?
    } else {
        // Validate hex pubkey
        PublicKey::from_hex(trimmed)
            .map(|pk| pk.to_hex())
            .map_err(|e| format!("Invalid pubkey: {}", e))?
    };
    tracing::info!("[cmd:track_profile] pubkey={}...", &hex_pk[..hex_pk.len().min(12)]);
    state.db().track_profile(&hex_pk, note.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn untrack_profile(pubkey: String, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:untrack_profile] pubkey={}...", &pubkey[..pubkey.len().min(12)]);
    state.db().untrack_profile(&pubkey).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_tracked_profiles(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    tracing::debug!("[cmd:get_tracked_profiles] called");
    let profiles = state.db().get_tracked_profiles().map_err(|e| e.to_string())?;
    Ok(profiles.into_iter().map(|(pubkey, tracked_at, note)| {
        serde_json::json!({
            "pubkey": pubkey,
            "tracked_at": tracked_at,
            "note": note,
        })
    }).collect())
}

#[tauri::command]
async fn get_tracked_profiles_detail(state: State<'_, AppState>) -> Result<Vec<TrackedProfileDetail>, String> {
    tracing::debug!("[cmd:get_tracked_profiles_detail] called");
    let profiles = state.db().get_tracked_profiles().map_err(|e| e.to_string())?;
    let pubkeys: Vec<String> = profiles.iter().map(|(pk, _, _)| pk.clone()).collect();
    let profile_infos = state.db().get_profiles(&pubkeys).unwrap_or_default();

    let mut result = Vec::new();
    for (pubkey, tracked_at, note) in profiles {
        let event_count = state.db().count_events_for_pubkey(&pubkey).unwrap_or(0);
        let media_bytes = state.db().media_bytes_for_pubkey(&pubkey).unwrap_or(0);
        let media_count = state.db().media_count_for_pubkey(&pubkey).unwrap_or(0);
        let info = profile_infos.iter().find(|p| p.pubkey == pubkey);
        result.push(TrackedProfileDetail {
            pubkey,
            tracked_at,
            note,
            name: info.and_then(|p| p.name.clone()),
            display_name: info.and_then(|p| p.display_name.clone()),
            picture: info.and_then(|p| p.picture.clone()),
            picture_local: info.and_then(|p| p.picture_local.clone()),
            event_count,
            media_bytes,
            media_count,
        });
    }
    Ok(result)
}

#[tauri::command]
async fn get_kind_counts_for_category(category: String, state: State<'_, AppState>) -> Result<KindCounts, String> {
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    let counts = match category.as_str() {
        "own" => state.db().kind_counts_for_pubkey(&own_pubkey),
        "tracked" => state.db().kind_counts_for_tracked(&own_pubkey),
        "wot" => state.db().kind_counts_for_wot(&own_pubkey),
        _ => return Err("Invalid category. Use 'own', 'tracked', or 'wot'".into()),
    }.map_err(|e| e.to_string())?;

    Ok(KindCounts { counts })
}

#[tauri::command]
async fn get_media_breakdown_for_category(category: String, state: State<'_, AppState>) -> Result<MediaBreakdown, String> {
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    let (ic, ib, vc, vb, ac, ab, oc, ob, tc, tb, oldest, newest) = state.db()
        .media_breakdown_for_category(&own_pubkey, &category)
        .map_err(|e| e.to_string())?;

    Ok(MediaBreakdown {
        image_count: ic,
        image_bytes: ib,
        video_count: vc,
        video_bytes: vb,
        audio_count: ac,
        audio_bytes: ab,
        other_count: oc,
        other_bytes: ob,
        total_count: tc,
        total_bytes: tb,
        oldest_media: oldest,
        newest_media: newest,
    })
}

#[tauri::command]
async fn get_events_for_category(
    category: String,
    kinds: Option<Vec<u32>>,
    until: Option<u64>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    let limit = limit.unwrap_or(50);
    let kinds_slice = kinds.as_deref();

    let rows = state.db()
        .query_events_for_category(&own_pubkey, &category, kinds_slice, until, limit)
        .map_err(|e| e.to_string())?;

    Ok(rows_to_events(rows))
}

#[tauri::command]
async fn get_media_for_category(
    category: String,
    state: State<'_, AppState>,
) -> Result<Vec<OwnMediaItem>, String> {
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    let records = state.db()
        .get_media_for_category(&own_pubkey, &category)
        .map_err(|e| e.to_string())?;

    let home = dirs::home_dir().unwrap_or_default();
    Ok(records.into_iter().map(|(hash, url, mime_type, size_bytes, downloaded_at)| {
        let local_path = home.join(".nostrito/media")
            .join(&hash[..2])
            .join(&hash)
            .to_string_lossy()
            .to_string();
        OwnMediaItem {
            hash,
            url,
            local_path,
            mime_type,
            size_bytes,
            downloaded_at: downloaded_at as u64,
        }
    }).collect())
}

/// A media reference extracted from a stored event, with optional local cache info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventMediaRef {
    pub url: String,
    pub local_path: Option<String>,
    pub mime_type: String,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub pubkey: String,
    pub created_at: u64,
}

/// Scan stored events for a category and extract all media URLs,
/// cross-referencing with media_cache for local copies.
#[tauri::command]
async fn get_event_media_for_category(
    category: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<EventMediaRef>, String> {
    use crate::sync::media::{extract_urls_from_text, extract_urls_from_tags, mime_type_from_url, is_nostr_media_cdn};
    use crate::sync::processing::is_media_url;

    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    let limit = limit.unwrap_or(500);
    let db = state.db();

    // Fetch recent events with media-bearing kinds
    let rows = db.query_events_for_category(
        &own_pubkey, &category,
        Some(&[0, 1, 6, 30023]),
        None, limit,
    ).map_err(|e| e.to_string())?;

    // Extract media URLs from each event
    let mut seen = std::collections::HashSet::new();
    let mut items: Vec<(String, String, u64)> = Vec::new(); // (url, pubkey, created_at)

    for (_, pubkey, created_at, kind, tags_json, content, _) in &rows {
        let kind = *kind as u32;

        if kind == 0 {
            // Profile metadata: extract picture and banner
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
                for field in &["picture", "banner"] {
                    if let Some(url) = parsed.get(field).and_then(|v| v.as_str()) {
                        if (url.starts_with("https://") || url.starts_with("http://"))
                            && url.len() > 10
                            && seen.insert(url.to_string())
                        {
                            items.push((url.to_string(), pubkey.clone(), *created_at as u64));
                        }
                    }
                }
            }
        } else {
            // Notes, reposts, articles: extract from content text + tags
            let text_urls = extract_urls_from_text(content);
            let tag_urls = extract_urls_from_tags(tags_json);

            for url in text_urls.iter().chain(tag_urls.iter()) {
                if (is_media_url(url) || is_nostr_media_cdn(url) || mime_type_from_url(url).is_some())
                    && seen.insert(url.clone())
                {
                    items.push((url.clone(), pubkey.clone(), *created_at as u64));
                }
            }
        }
    }

    // Batch lookup which URLs have local copies
    let all_urls: Vec<String> = items.iter().map(|(u, _, _)| u.clone()).collect();

    // Filter out URLs the user has explicitly deleted
    let deleted_urls = db.media_get_deleted(&all_urls).map_err(|e| e.to_string())?;
    if !deleted_urls.is_empty() {
        items.retain(|(url, _, _)| !deleted_urls.contains(url));
    }
    let all_urls: Vec<String> = items.iter().map(|(u, _, _)| u.clone()).collect();
    let cache_map = db.media_cache_lookup_by_urls(&all_urls).map_err(|e| e.to_string())?;

    let home = dirs::home_dir().unwrap_or_default();
    let result: Vec<EventMediaRef> = items.into_iter().map(|(url, pubkey, created_at)| {
        if let Some((hash, mime, size, _downloaded_at)) = cache_map.get(&url) {
            let local_path = home.join(".nostrito/media")
                .join(&hash[..2])
                .join(hash)
                .to_string_lossy()
                .to_string();
            EventMediaRef {
                url,
                local_path: Some(local_path),
                mime_type: mime.clone(),
                size_bytes: *size,
                downloaded: true,
                pubkey,
                created_at,
            }
        } else {
            let mime = mime_type_from_url(&url)
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    if is_nostr_media_cdn(&url) { "image/jpeg".to_string() }
                    else { "image/jpeg".to_string() }
                });
            EventMediaRef {
                url,
                local_path: None,
                mime_type: mime,
                size_bytes: 0,
                downloaded: false,
                pubkey,
                created_at,
            }
        }
    }).collect();

    tracing::info!(
        "[cmd:get_event_media_for_category] category={} scanned {} events, found {} media refs ({} cached)",
        category, rows.len(), result.len(), result.iter().filter(|r| r.downloaded).count()
    );

    Ok(result)
}

#[tauri::command]
async fn requeue_profile_media(pubkey: String, state: State<'_, AppState>) -> Result<u32, String> {
    tracing::info!("[cmd:requeue_profile_media] pubkey={}...", &pubkey[..pubkey.len().min(12)]);
    state.db().requeue_events_media(&pubkey).map_err(|e| e.to_string())
}

/// Download pending media for tracked profiles immediately (doesn't wait for sync cycle).
#[tauri::command]
async fn download_tracked_media(state: State<'_, AppState>) -> Result<u32, String> {
    tracing::info!("[cmd:download_tracked_media] starting immediate download for tracked profiles");
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    let tracked_media_gb = config.storage_tracked_media_gb;
    let wot_media_gb = config.storage_wot_media_gb;
    drop(config);

    let db = state.db();

    // Ensure tracked profiles' media is queued
    let tracked_pks = db.get_tracked_pubkeys().unwrap_or_default();
    for tpk in &tracked_pks {
        if tpk != &own_pubkey {
            db.requeue_events_media(tpk).ok();
        }
    }

    // Run media downloader for queued items
    let downloader = sync::media::MediaDownloader::new(
        db.clone(),
        own_pubkey,
        tracked_media_gb,
        wot_media_gb,
    );
    match downloader.run(200).await {
        Ok(stats) => {
            tracing::info!(
                "[cmd:download_tracked_media] done: downloaded={}, skipped={}, failed={}",
                stats.downloaded, stats.skipped, stats.failed
            );
            Ok(stats.downloaded)
        }
        Err(e) => Err(format!("Media download failed: {}", e)),
    }
}

#[tauri::command]
async fn get_profiles(
    pubkeys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ProfileInfo>, String> {
    tracing::debug!("[cmd:get_profiles] called for {} pubkeys", pubkeys.len());
    state.db()
        .get_profiles(&pubkeys)
        .map_err(|e| format!("Failed to get profiles: {}", e))
}

#[tauri::command]
async fn search_profiles(
    query: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<ProfileInfo>, String> {
    let lim = limit.unwrap_or(20);
    tracing::debug!("[cmd:search_profiles] query={:?}, limit={}", query, lim);
    state.db()
        .search_profiles(&query, lim)
        .map_err(|e| format!("Failed to search profiles: {}", e))
}

#[tauri::command]
async fn get_own_profile(state: State<'_, AppState>) -> Result<Option<ProfileInfo>, String> {
    tracing::debug!("[cmd:get_own_profile] called");
    let config = state.config.read().await;
    let hex_pubkey = match &config.hex_pubkey {
        Some(pk) => pk.clone(),
        None => return Ok(None),
    };
    drop(config);

    let profiles = state.db()
        .get_profiles(&[hex_pubkey])
        .map_err(|e| format!("Failed to get own profile: {}", e))?;

    Ok(profiles.into_iter().next())
}

// ── Browser Integration (mkcert TLS) ───────────────────────────────

/// Core mkcert setup logic — synchronous, reusable by both auto-setup and manual command.
#[cfg(desktop)]
fn run_mkcert_setup(app: &tauri::AppHandle) -> Result<String, String> {
    use std::process::Command;

    // Find bundled mkcert
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;

    let mkcert_name = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mkcert-macos-arm64"
        } else {
            "mkcert-macos-amd64"
        }
    } else if cfg!(target_os = "linux") {
        "mkcert-linux-amd64"
    } else {
        "mkcert-windows-amd64.exe"
    };

    let mkcert_path = resource_dir.join("resources").join(mkcert_name);

    // chmod +x on unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&mkcert_path)
            .map_err(|e| format!("mkcert binary not found at {:?}: {}", mkcert_path, e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&mkcert_path, perms).map_err(|e| e.to_string())?;
    }

    // mkcert -install (triggers OS trust dialog)
    let install = Command::new(&mkcert_path)
        .arg("-install")
        .output()
        .map_err(|e| format!("mkcert -install failed: {}", e))?;

    if !install.status.success() {
        return Err(format!(
            "mkcert -install error: {}",
            String::from_utf8_lossy(&install.stderr)
        ));
    }

    // Generate cert
    let cert_dir = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".nostrito/certs");
    std::fs::create_dir_all(&cert_dir).map_err(|e| e.to_string())?;

    let gen = Command::new(&mkcert_path)
        .args([
            "-cert-file",
            "localhost.pem",
            "-key-file",
            "localhost-key.pem",
            "localhost",
            "127.0.0.1",
        ])
        .current_dir(&cert_dir)
        .output()
        .map_err(|e| format!("mkcert gen failed: {}", e))?;

    if !gen.status.success() {
        return Err(format!(
            "mkcert gen error: {}",
            String::from_utf8_lossy(&gen.stderr)
        ));
    }

    tracing::info!("[mkcert] Browser integration set up — certs at {:?}", cert_dir);
    Ok(cert_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn setup_browser_integration(#[allow(unused)] app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        let app_clone = app.clone();
        let result = tokio::task::spawn_blocking(move || run_mkcert_setup(&app_clone))
            .await
            .map_err(|e| format!("Task failed: {}", e))??;
        app.emit("relay:restart_required", ()).ok();
        return Ok(result);
    }
    #[cfg(mobile)]
    Err("Browser integration is not available on mobile".to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MediaStats {
    pub total_bytes: u64,
    pub file_count: u64,
    pub limit_bytes: u64,
    pub tracked_bytes: u64,
    pub tracked_limit_bytes: u64,
    pub wot_bytes: u64,
    pub wot_limit_bytes: u64,
}

#[tauri::command]
async fn get_media_stats(state: State<'_, AppState>) -> Result<MediaStats, String> {
    let db = state.db();
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.as_deref().unwrap_or("");
    let total_bytes = db.media_total_bytes().map_err(|e| e.to_string())?;
    let file_count = db.media_file_count().map_err(|e| e.to_string())?;
    let tracked_bytes = db.media_tracked_bytes(own_pubkey).map_err(|e| e.to_string())?;
    let wot_bytes = db.media_others_bytes(own_pubkey).map_err(|e| e.to_string())?;
    let tracked_limit_bytes = (config.storage_tracked_media_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    let wot_limit_bytes = (config.storage_wot_media_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    Ok(MediaStats {
        total_bytes,
        file_count,
        limit_bytes: tracked_limit_bytes + wot_limit_bytes,
        tracked_bytes,
        tracked_limit_bytes,
        wot_bytes,
        wot_limit_bytes,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnMediaItem {
    pub hash: String,
    pub url: String,
    pub local_path: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub downloaded_at: u64,
}

#[tauri::command]
async fn get_own_media(state: State<'_, AppState>) -> Result<Vec<OwnMediaItem>, String> {
    tracing::debug!("[cmd:get_own_media] called");
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    if own_pubkey.is_empty() {
        return Err("Not initialized — no pubkey set".into());
    }

    let records = state.db().get_own_media(&own_pubkey).map_err(|e| e.to_string())?;
    tracing::info!("[cmd:get_own_media] returning {} own media items", records.len());

    let home = dirs::home_dir().unwrap_or_default();
    Ok(records.into_iter().map(|(hash, url, mime_type, size_bytes, downloaded_at)| {
        let local_path = home.join(".nostrito/media")
            .join(&hash[..2])
            .join(&hash)
            .to_string_lossy()
            .to_string();
        OwnMediaItem {
            hash,
            url,
            local_path,
            mime_type,
            size_bytes,
            downloaded_at: downloaded_at as u64,
        }
    }).collect())
}

#[tauri::command]
async fn get_profile_media(pubkey: String, state: State<'_, AppState>) -> Result<Vec<OwnMediaItem>, String> {
    tracing::debug!("[cmd:get_profile_media] called for pubkey={}...", &pubkey[..pubkey.len().min(8)]);

    let records = state.db().get_profile_media(&pubkey).map_err(|e| e.to_string())?;
    tracing::info!("[cmd:get_profile_media] returning {} media items for {}...", records.len(), &pubkey[..pubkey.len().min(8)]);

    let home = dirs::home_dir().unwrap_or_default();
    Ok(records.into_iter().map(|(hash, url, mime_type, size_bytes, downloaded_at)| {
        let local_path = home.join(".nostrito/media")
            .join(&hash[..2])
            .join(&hash)
            .to_string_lossy()
            .to_string();
        OwnMediaItem {
            hash,
            url,
            local_path,
            mime_type,
            size_bytes,
            downloaded_at: downloaded_at as u64,
        }
    }).collect())
}

// ── Profile Fetch Types ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfileFetchResult {
    pub events_fetched: u64,
    pub has_profile: bool,
}


/// Core profile fetch logic — reusable from both the command and background refresh.
async fn do_fetch_profile(
    pubkey: &str,
    db: &std::sync::Arc<Database>,
    wot: &std::sync::Arc<crate::wot::WotGraph>,
    config: &std::sync::Arc<tokio::sync::RwLock<AppConfig>>,
) -> Result<ProfileFetchResult, String> {
    use nostr_sdk::prelude::*;

    tracing::info!("[cmd:fetch_profile] pubkey={}…", &pubkey[..pubkey.len().min(12)]);

    let cfg = config.read().await;
    let relay_urls = cfg.outbound_relays.clone();
    drop(cfg);

    if relay_urls.is_empty() {
        return Err("No relays configured".into());
    }

    let mut all_events: Vec<Event> = Vec::new();

    // Metadata + contacts filter
    let meta_filter = Filter::new()
        .kinds(vec![Kind::Metadata, Kind::ContactList])
        .authors(vec![PublicKey::from_hex(pubkey).map_err(|e| format!("Invalid pubkey: {}", e))?]);

    // Recent events filter
    let events_filter = Filter::new()
        .kinds(vec![Kind::TextNote, Kind::Repost, Kind::LongFormTextNote])
        .authors(vec![PublicKey::from_hex(pubkey).map_err(|e| format!("Invalid pubkey: {}", e))?])
        .limit(100);

    for url in &relay_urls {
        let client = Client::default();
        match client.add_relay(url.as_str()).await {
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("[fetch_profile] Failed to add relay {}: {}", url, e);
                continue;
            }
        }
        client.connect().await;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        // Subscribe and collect with a simple timeout approach
        let mut notifications = client.notifications();
        let sub_id = match client.subscribe(vec![meta_filter.clone(), events_filter.clone()], None).await {
            Ok(output) => output.val,
            Err(e) => {
                tracing::warn!("[fetch_profile] Subscribe failed on {}: {}", url, e);
                client.disconnect().await.ok();
                continue;
            }
        };

        let deadline = tokio::time::sleep(std::time::Duration::from_secs(15));
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                result = notifications.recv() => {
                    match result {
                        Ok(RelayPoolNotification::Event { event, .. }) => {
                            if !all_events.iter().any(|e| e.id == event.id) {
                                all_events.push(*event);
                            }
                        }
                        Ok(RelayPoolNotification::Message { message, .. }) => {
                            if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                _ = &mut deadline => {
                    tracing::warn!("[fetch_profile] Timeout on {}, got {} events so far", url, all_events.len());
                    break;
                }
            }
        }

        client.unsubscribe(sub_id).await;
        client.disconnect().await.ok();

        tracing::info!("[fetch_profile] Got {} events from {}", all_events.len(), url);

        // If we got metadata + contacts, skip remaining relays
        let has_meta = all_events.iter().any(|e| e.kind == Kind::Metadata && e.pubkey.to_hex() == pubkey);
        let has_contacts = all_events.iter().any(|e| e.kind == Kind::ContactList && e.pubkey.to_hex() == pubkey);
        if has_meta && has_contacts && all_events.len() >= 10 {
            break;
        }
    }

    // Store events
    let mut stored_count: u64 = 0;
    let mut has_profile = false;

    // Sort newest-first for replaceable events
    all_events.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    for event in &all_events {
        let tags_json = serde_json::to_string(
            &event.tags.iter().map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<String>>()).collect::<Vec<Vec<String>>>()
        ).unwrap_or_else(|_| "[]".to_string());

        match db.store_event(
            &event.id.to_hex(),
            &event.pubkey.to_hex(),
            event.created_at.as_u64() as i64,
            event.kind.as_u16() as u32,
            &tags_json,
            &event.content.to_string(),
            &event.sig.to_string(),
        ) {
            Ok(true) => stored_count += 1,
            Ok(false) => {} // duplicate
            Err(e) => tracing::warn!("[fetch_profile] Failed to store event: {}", e),
        }

        // Update WoT graph for contact lists
        if event.kind == Kind::ContactList {
            let follows: Vec<String> = event.tags.iter()
                .filter(|t| {
                    let slice = t.as_slice();
                    slice.len() >= 2 && slice[0] == "p"
                })
                .map(|t| t.as_slice()[1].to_string())
                .collect();

            let pk_hex = event.pubkey.to_hex();
            let ev_id = event.id.to_hex();
            let updated = wot.update_follows(
                &pk_hex,
                &follows,
                Some(ev_id.clone()),
                Some(event.created_at.as_u64() as i64),
            );
            if updated {
                let batch = vec![storage::FollowUpdateBatch {
                    pubkey: &pk_hex,
                    follows: &follows,
                    event_id: Some(&ev_id),
                    created_at: Some(event.created_at.as_u64() as i64),
                }];
                db.update_follows_batch(&batch).ok();
            }
        }

        if event.kind == Kind::Metadata {
            has_profile = true;
        }
    }

    tracing::info!(
        "[cmd:fetch_profile] Done: {} events fetched, {} stored, has_profile={}",
        all_events.len(), stored_count, has_profile
    );

    Ok(ProfileFetchResult {
        events_fetched: all_events.len() as u64,
        has_profile,
    })
}

/// One-shot targeted fetch for a specific pubkey from all connected relays.
#[tauri::command]
async fn fetch_profile(pubkey: String, state: State<'_, AppState>) -> Result<ProfileFetchResult, String> {
    let db = state.db();
    do_fetch_profile(&pubkey, &db, &state.wot_graph, &state.config).await
}

#[tauri::command]
async fn get_profile_with_refresh(
    pubkey: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ProfileInfo>, String> {
    // 1. Return cached profile immediately
    let profiles = state.db().get_profiles(&[pubkey.clone()]).map_err(|e| e.to_string())?;
    let cached = profiles.into_iter().find(|p| p.pubkey == pubkey);

    // 2. Check if we need a background refresh
    let fetched_at = state.db().get_profile_fetched_at(&pubkey).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();
    let twelve_hours = 12 * 60 * 60;
    let needs_refresh = match fetched_at {
        Some(ts) => (now - ts) > twelve_hours,
        None => true,
    };

    if needs_refresh {
        // 3. Spawn background fetch — don't block the response
        let pk = pubkey.clone();
        let db = state.db();
        let wot = state.wot_graph.clone();
        let config = state.config.clone();
        let handle = app_handle.clone();

        tokio::spawn(async move {
            tracing::info!("[profile_refresh] Background fetch for {}...", &pk[..pk.len().min(12)]);

            // Get old profile for comparison
            let old_profile_json = db.get_profiles(&[pk.clone()])
                .ok()
                .and_then(|ps| ps.into_iter().find(|p| p.pubkey == pk))
                .and_then(|p| serde_json::to_string(&p).ok());

            match do_fetch_profile(&pk, &db, &wot, &config).await {
                Ok(_) => {
                    let now = chrono::Utc::now().timestamp();
                    db.set_profile_fetched_at(&pk, now).ok();

                    // Check if any profile field changed
                    let new_profile_json = db.get_profiles(&[pk.clone()])
                        .ok()
                        .and_then(|ps| ps.into_iter().find(|p| p.pubkey == pk))
                        .and_then(|p| serde_json::to_string(&p).ok());

                    if old_profile_json != new_profile_json {
                        handle.emit("profile-updated", &pk).ok();
                    }
                }
                Err(e) => {
                    tracing::warn!("[profile_refresh] Failed for {}: {}", &pk[..pk.len().min(12)], e);
                }
            }
        });
    }

    Ok(cached)
}

#[tauri::command]
async fn check_browser_integration() -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let cert_path = dirs::home_dir()
            .ok_or("no home")?
            .join(".nostrito/certs/localhost.pem");
        return Ok(cert_path.exists());
    }
    #[cfg(mobile)]
    Ok(false)
}

// ── Mobile secret storage (file-based, app-private sandbox) ─────────

#[cfg(mobile)]
mod mobile_secrets {
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn secrets_path() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("nostrito")
            .join(".secrets.json")
    }

    fn load_all() -> HashMap<String, String> {
        std::fs::read_to_string(secrets_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_all(secrets: &HashMap<String, String>) {
        let path = secrets_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if let Ok(json) = serde_json::to_string(secrets) {
            std::fs::write(&path, json).ok();
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        let mut m = load_all();
        m.insert(format!("{}:{}", service, key), value.to_string());
        save_all(&m);
        Ok(())
    }

    pub fn get(service: &str, key: &str) -> Option<String> {
        load_all().get(&format!("{}:{}", service, key)).cloned()
    }

    pub fn delete(service: &str, key: &str) {
        let mut m = load_all();
        m.remove(&format!("{}:{}", service, key));
        save_all(&m);
    }
}

// ── nsec Keychain Helpers ────────────────────────────────────────────

#[cfg(desktop)]
fn save_nsec_to_keychain(npub: &str, nsec: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("nostrito", npub).map_err(|e| format!("Keychain error: {}", e))?;
    entry.set_password(nsec).map_err(|e| format!("Failed to save to keychain: {}", e))
}

#[cfg(mobile)]
fn save_nsec_to_keychain(npub: &str, nsec: &str) -> Result<(), String> {
    mobile_secrets::set("nostrito", npub, nsec)
}

#[cfg(desktop)]
fn load_nsec_from_keychain(npub: &str) -> Option<String> {
    let entry = keyring::Entry::new("nostrito", npub).ok()?;
    entry.get_password().ok()
}

#[cfg(mobile)]
fn load_nsec_from_keychain(npub: &str) -> Option<String> {
    mobile_secrets::get("nostrito", npub)
}

#[cfg(desktop)]
fn delete_nsec_from_keychain(npub: &str) {
    if let Ok(entry) = keyring::Entry::new("nostrito", npub) {
        entry.delete_credential().ok();
    }
}

#[cfg(mobile)]
fn delete_nsec_from_keychain(npub: &str) {
    mobile_secrets::delete("nostrito", npub);
}

// ── NIP-46 Bunker Keychain Helpers ─────────────────────────────────

#[cfg(desktop)]
fn save_bunker_to_keychain(npub: &str, bunker_uri: &str, app_keys_nsec: &str) -> Result<(), String> {
    let uri_entry = keyring::Entry::new("nostrito-bunker-uri", npub)
        .map_err(|e| format!("Keychain error: {}", e))?;
    uri_entry.set_password(bunker_uri)
        .map_err(|e| format!("Failed to save bunker URI to keychain: {}", e))?;

    let keys_entry = keyring::Entry::new("nostrito-app-keys", npub)
        .map_err(|e| format!("Keychain error: {}", e))?;
    keys_entry.set_password(app_keys_nsec)
        .map_err(|e| format!("Failed to save app keys to keychain: {}", e))?;

    Ok(())
}

#[cfg(mobile)]
fn save_bunker_to_keychain(npub: &str, bunker_uri: &str, app_keys_nsec: &str) -> Result<(), String> {
    mobile_secrets::set("nostrito-bunker-uri", npub, bunker_uri)?;
    mobile_secrets::set("nostrito-app-keys", npub, app_keys_nsec)
}

#[cfg(desktop)]
fn load_bunker_from_keychain(npub: &str) -> Option<(String, String)> {
    let uri_entry = keyring::Entry::new("nostrito-bunker-uri", npub).ok()?;
    let uri = uri_entry.get_password().ok()?;
    let keys_entry = keyring::Entry::new("nostrito-app-keys", npub).ok()?;
    let keys_nsec = keys_entry.get_password().ok()?;
    Some((uri, keys_nsec))
}

#[cfg(mobile)]
fn load_bunker_from_keychain(npub: &str) -> Option<(String, String)> {
    let uri = mobile_secrets::get("nostrito-bunker-uri", npub)?;
    let keys_nsec = mobile_secrets::get("nostrito-app-keys", npub)?;
    Some((uri, keys_nsec))
}

#[cfg(desktop)]
fn delete_bunker_from_keychain(npub: &str) {
    if let Ok(entry) = keyring::Entry::new("nostrito-bunker-uri", npub) {
        entry.delete_credential().ok();
    }
    if let Ok(entry) = keyring::Entry::new("nostrito-app-keys", npub) {
        entry.delete_credential().ok();
    }
}

#[cfg(mobile)]
fn delete_bunker_from_keychain(npub: &str) {
    mobile_secrets::delete("nostrito-bunker-uri", npub);
    mobile_secrets::delete("nostrito-app-keys", npub);
}

#[tauri::command]
fn nsec_to_npub(nsec: String) -> Result<String, String> {
    use nostr_sdk::prelude::*;
    let secret_key = SecretKey::from_bech32(nsec.trim())
        .map_err(|e| format!("Invalid nsec: {}", e))?;
    let keys = Keys::new(secret_key);
    keys.public_key().to_bech32().map_err(|e| format!("Failed to encode npub: {}", e))
}

#[tauri::command]
async fn set_nsec(nsec: String, app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use nostr_sdk::prelude::*;

    let nsec_trimmed = nsec.trim();

    // Decode nsec to secret key
    let secret_key = SecretKey::from_bech32(nsec_trimmed)
        .map_err(|e| format!("Invalid nsec: {}", e))?;

    // Derive public key
    let keys = Keys::new(secret_key);
    let derived_hex = keys.public_key().to_hex();

    // Verify matches current hex_pubkey
    let config = state.config.read().await;
    let current_hex = config.hex_pubkey.clone().ok_or("No pubkey set")?;
    let current_npub = config.npub.clone().ok_or("No npub set")?;
    drop(config);

    if derived_hex != current_hex {
        return Err("nsec doesn't match your npub".into());
    }

    // Save to keychain
    save_nsec_to_keychain(&current_npub, nsec_trimmed)?;

    // Cache in memory
    {
        let mut config = state.config.write().await;
        config.nsec = Some(nsec_trimmed.to_string());
        config.signing_mode = "nsec".to_string();
    }

    app_handle.emit("signing-mode-changed", "nsec").ok();
    tracing::info!("[cmd:set_nsec] nsec saved for {}...", &current_hex[..8]);
    Ok(())
}

#[tauri::command]
async fn clear_nsec(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.read().await;
    if let Some(ref npub) = config.npub {
        delete_nsec_from_keychain(npub);
    }
    drop(config);

    {
        let mut config = state.config.write().await;
        config.nsec = None;
    }

    app_handle.emit("signing-mode-changed", "read-only").ok();
    tracing::info!("[cmd:clear_nsec] nsec cleared");
    Ok(())
}

#[tauri::command]
async fn get_signing_mode(state: State<'_, AppState>) -> Result<String, String> {
    let config = state.config.read().await;
    if config.nsec.is_some() {
        return Ok("nsec".to_string());
    }
    let mode = config.signing_mode.clone();
    drop(config);

    if mode == "bunker" || mode == "connect" {
        // Verify the signer is actually alive
        let nip46 = state.nip46_signer.read().await;
        if nip46.is_some() {
            return Ok(mode);
        }
    }
    Ok("read-only".to_string())
}

#[tauri::command]
async fn publish_dm(
    content: String,
    recipient_pubkey: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    tracing::info!("[cmd:publish_dm] sending DM to {}...", &recipient_pubkey[..12.min(recipient_pubkey.len())]);

    let recipient_pk = PublicKey::from_hex(&recipient_pubkey)
        .map_err(|e| format!("Invalid recipient pubkey: {}", e))?;
    tracing::info!("[cmd:publish_dm] step 1: parsed recipient pk");

    // Encrypt content with NIP-04
    let config = state.config.read().await;
    let nsec = config.nsec.clone();
    let signing_mode = config.signing_mode.clone();
    drop(config);
    tracing::info!("[cmd:publish_dm] step 2: got config, signing_mode={}, has_nsec={}", signing_mode, nsec.is_some());

    let use_nsec = nsec.is_some();
    let encrypted = if use_nsec {
        tracing::info!("[cmd:publish_dm] step 3a: encrypting locally with nsec");
        let secret_key = SecretKey::from_bech32(nsec.as_ref().unwrap())
            .map_err(|e| format!("Invalid nsec: {}", e))?;
        let enc = nip04::encrypt(&secret_key, &recipient_pk, &content)
            .map_err(|e| format!("NIP-04 encryption failed: {}", e))?;
        tracing::info!("[cmd:publish_dm] step 3a: encrypted OK, len={}", enc.len());
        enc
    } else {
        tracing::info!("[cmd:publish_dm] step 3b: encrypting via NIP-46");
        let signer_opt = {
            let guard = state.nip46_signer.read().await;
            guard.clone()
        };
        match signer_opt {
            Some(signer) => {
                signer.nip04_encrypt(recipient_pk, content.clone())
                    .await
                    .map_err(|e| format!("Remote NIP-04 encryption failed: {}", e))?
            }
            None => return Err("No signer available — cannot send DMs in read-only mode".into()),
        }
    };
    tracing::info!("[cmd:publish_dm] step 4: content encrypted, building event");

    let tags = vec![
        Tag::public_key(recipient_pk),
    ];
    let builder = EventBuilder::new(Kind::EncryptedDirectMessage, &encrypted, tags);
    let signed = sign_build_publish_store(builder, &state).await?;
    let dm_id = signed.id.to_hex();
    tracing::info!("[cmd:publish_dm] published DM {}", &dm_id[..12.min(dm_id.len())]);
    Ok(dm_id)
}

#[tauri::command]
async fn decrypt_dm(content: String, sender_pubkey: String, state: State<'_, AppState>) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    let sender_pk = PublicKey::from_hex(&sender_pubkey)
        .map_err(|e| format!("Invalid sender pubkey: {}", e))?;

    // Try local nsec first (fast path)
    {
        let config = state.config.read().await;
        if let Some(ref nsec_str) = config.nsec {
            let secret_key = SecretKey::from_bech32(nsec_str)
                .map_err(|e| format!("Invalid nsec: {}", e))?;
            let decrypted = nip04::decrypt(&secret_key, &sender_pk, &content)
                .map_err(|e| format!("Decryption failed: {}", e))?;
            return Ok(decrypted);
        }
    }

    // Try NIP-46 remote signer (clone to release lock before await)
    let signer_opt = {
        let guard = state.nip46_signer.read().await;
        guard.clone()
    };
    if let Some(signer) = signer_opt {
        tracing::debug!("[decrypt_dm] using NIP-46 signer (encryption={:?}, signer_pk={}...)",
            signer.encryption(), &signer.signer_public_key().to_hex()[..12]);
        let decrypted = signer.nip04_decrypt(sender_pk, content)
            .await
            .map_err(|e| format!("Remote decryption failed: {}", e))?;
        return Ok(decrypted);
    }

    Err("No signer available — read-only mode".into())
}

// ── NIP-46 Commands ────────────────────────────────────────────────

#[tauri::command]
async fn connect_bunker(
    bunker_uri: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    tracing::info!("[cmd:connect_bunker] Parsing bunker URI...");

    let uri = NostrConnectURI::parse(bunker_uri.trim())
        .map_err(|e| format!("Invalid bunker URI: {}", e))?;

    if !uri.is_bunker() {
        return Err("Expected a bunker:// URI. For nostrconnect://, use the Nostr Connect flow.".into());
    }

    // Generate ephemeral app keys for NIP-46 communication
    let app_keys = Keys::generate();
    let app_keys_nsec = app_keys.secret_key().to_bech32()
        .map_err(|e| format!("Failed to encode app keys: {}", e))?;

    // Connect to bunker (sends connect request, waits for ack — up to 60s)
    let signer = crate::nip46::Nip46Client::connect_bunker(&uri, app_keys, std::time::Duration::from_secs(60))
        .await
        .map_err(|e| format!("Bunker connection failed: {}", e))?;

    // The signer_public_key IS the user's npub for bunker connections
    let user_pk = signer.signer_public_key();
    let npub = user_pk.to_bech32()
        .map_err(|e| format!("Failed to encode npub: {}", e))?;

    // Get bunker URI for reconnection (may differ from input if relays changed)
    let reconnect_uri = signer.bunker_uri().await.to_string();
    let encryption = signer.encryption();

    tracing::info!("[cmd:connect_bunker] saving to keychain: npub={}, uri={}..., encryption={:?}",
        &npub[..npub.len().min(16)], &reconnect_uri[..reconnect_uri.len().min(60)], encryption);

    // Save to keychain for reconnection on restart
    save_bunker_to_keychain(&npub, &reconnect_uri, &app_keys_nsec)?;
    // Save encryption preference
    {
        let db = state.db();
        let enc_str = match encryption { crate::nip46::Nip46Encryption::Nip44 => "nip44", _ => "nip04" };
        db.set_config("nip46_encryption", enc_str).ok();
    }

    // Store signer in app state
    {
        let mut nip46 = state.nip46_signer.write().await;
        *nip46 = Some(signer);
    }

    // Update config
    {
        let mut config = state.config.write().await;
        config.signing_mode = "bunker".to_string();
        config.nsec = None;
    }

    app_handle.emit("signing-mode-changed", "bunker").ok();
    tracing::info!("[cmd:connect_bunker] Connected to bunker, npub={}", &npub[..npub.len().min(16)]);
    Ok(npub)
}

#[tauri::command]
async fn generate_nostr_connect_uri(
    relay_url: String,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    let relay = nostr_sdk::prelude::Url::parse(&relay_url)
        .map_err(|e| format!("Invalid relay URL: {}", e))?;

    // Generate ephemeral app keys
    let app_keys = Keys::generate();
    let app_keys_nsec = app_keys.secret_key().to_bech32()
        .map_err(|e| format!("Failed to encode app keys: {}", e))?;

    let uri = NostrConnectURI::client(app_keys.public_key(), vec![relay], "Nostrito");
    let uri_str = uri.to_string();

    tracing::info!("[cmd:generate_nostr_connect_uri] Generated URI for relay {}", relay_url);

    // Return both the URI and the app keys nsec (frontend needs both for the await step)
    Ok(serde_json::json!({
        "uri": uri_str,
        "app_keys_nsec": app_keys_nsec
    }).to_string())
}

#[tauri::command]
async fn await_nostr_connect(
    nostr_connect_uri: String,
    app_keys_nsec: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    tracing::info!("[cmd:await_nostr_connect] Waiting for remote signer...");

    let uri = NostrConnectURI::parse(&nostr_connect_uri)
        .map_err(|e| format!("Invalid URI: {}", e))?;

    let secret_key = SecretKey::from_bech32(&app_keys_nsec)
        .map_err(|e| format!("Invalid app keys: {}", e))?;
    let app_keys = Keys::new(secret_key);

    // Connect via Nostr Connect (blocks until remote signer connects, up to 120s)
    let signer = crate::nip46::Nip46Client::connect_nostrconnect(&uri, app_keys, std::time::Duration::from_secs(120))
        .await
        .map_err(|e| format!("Nostr Connect failed: {}", e))?;

    let user_pk = signer.signer_public_key();
    let npub = user_pk.to_bech32()
        .map_err(|e| format!("Failed to encode npub: {}", e))?;

    // Get bunker URI for reconnection
    let reconnect_uri = signer.bunker_uri().await.to_string();
    let encryption = signer.encryption();

    tracing::info!("[cmd:await_nostr_connect] saving to keychain: npub={}, uri={}..., encryption={:?}",
        &npub[..npub.len().min(16)], &reconnect_uri[..reconnect_uri.len().min(60)], encryption);

    // Save to keychain
    save_bunker_to_keychain(&npub, &reconnect_uri, &app_keys_nsec)?;
    // Save encryption preference
    {
        let db = state.db();
        let enc_str = match encryption { crate::nip46::Nip46Encryption::Nip44 => "nip44", _ => "nip04" };
        db.set_config("nip46_encryption", enc_str).ok();
    }

    // Store signer
    {
        let mut nip46 = state.nip46_signer.write().await;
        *nip46 = Some(signer);
    }

    // Update config
    {
        let mut config = state.config.write().await;
        config.signing_mode = "connect".to_string();
        config.nsec = None;
    }

    app_handle.emit("signing-mode-changed", "connect").ok();
    tracing::info!("[cmd:await_nostr_connect] Connected via Nostr Connect, npub={}", &npub[..npub.len().min(16)]);
    Ok(npub)
}

#[tauri::command]
async fn disconnect_bunker(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Take signer from state and shut it down
    {
        let mut nip46 = state.nip46_signer.write().await;
        if let Some(signer) = nip46.take() {
            if let Err(e) = signer.shutdown().await {
                tracing::warn!("[cmd:disconnect_bunker] Shutdown error (non-fatal): {}", e);
            }
        }
    }

    // Delete from keychain
    {
        let config = state.config.read().await;
        if let Some(ref npub) = config.npub {
            delete_bunker_from_keychain(npub);
        }
    }

    // Update config
    {
        let mut config = state.config.write().await;
        config.signing_mode = "read-only".to_string();
    }

    app_handle.emit("signing-mode-changed", "read-only").ok();
    tracing::info!("[cmd:disconnect_bunker] Remote signer disconnected");
    Ok(())
}

// ── Wallet Keychain Helpers ───────────────────────────────────────────

#[cfg(desktop)]
fn save_wallet_to_keychain(npub: &str, data: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("nostrito-wallet", npub)
        .map_err(|e| format!("Keychain error: {}", e))?;
    entry
        .set_password(data)
        .map_err(|e| format!("Failed to save wallet to keychain: {}", e))
}

#[cfg(mobile)]
fn save_wallet_to_keychain(npub: &str, data: &str) -> Result<(), String> {
    mobile_secrets::set("nostrito-wallet", npub, data)
}

#[cfg(desktop)]
fn load_wallet_from_keychain(npub: &str) -> Option<String> {
    let entry = keyring::Entry::new("nostrito-wallet", npub).ok()?;
    entry.get_password().ok()
}

#[cfg(mobile)]
fn load_wallet_from_keychain(npub: &str) -> Option<String> {
    mobile_secrets::get("nostrito-wallet", npub)
}

#[cfg(desktop)]
fn delete_wallet_from_keychain(npub: &str) {
    if let Ok(entry) = keyring::Entry::new("nostrito-wallet", npub) {
        entry.delete_credential().ok();
    }
}

#[cfg(mobile)]
fn delete_wallet_from_keychain(npub: &str) {
    mobile_secrets::delete("nostrito-wallet", npub);
}

// ── Wallet Tauri Commands ────────────────────────────────────────────

#[tauri::command]
async fn wallet_connect_lnbits(
    url: String,
    admin_key: String,
    state: State<'_, AppState>,
) -> Result<wallet::WalletInfo, String> {
    let url = url.trim_end_matches('/').to_string();

    // Test connection
    let (alias, _balance) = wallet::lnbits::get_info(&url, &admin_key).await?;

    // Save to keychain
    let config = state.config.read().await;
    if let Some(ref npub) = config.npub {
        let data = serde_json::json!({
            "type": "lnbits",
            "url": url,
            "admin_key": admin_key,
        });
        save_wallet_to_keychain(npub, &data.to_string())?;
    }
    drop(config);

    // Save wallet type to DB config
    let db = state.db();
    db.set_config("wallet_type", "lnbits")
        .map_err(|e| format!("DB error: {}", e))?;
    db.set_config("wallet_lnbits_url", &url)
        .map_err(|e| format!("DB error: {}", e))?;

    // Store in app state
    let mut wallet_guard = state.wallet.write().await;
    *wallet_guard = Some(wallet::WalletState {
        provider: wallet::WalletProvider::LNbits {
            url: url.clone(),
            admin_key: admin_key.clone(),
        },
        wallet_type: "lnbits".to_string(),
        alias: Some(alias.clone()),
    });

    Ok(wallet::WalletInfo {
        wallet_type: "lnbits".to_string(),
        connected: true,
        alias: Some(alias),
    })
}

#[tauri::command]
async fn wallet_connect_nwc(
    nwc_uri: String,
    state: State<'_, AppState>,
) -> Result<wallet::WalletInfo, String> {
    let (client, alias) = wallet::nwc_provider::connect(&nwc_uri).await?;

    // Save to keychain
    let config = state.config.read().await;
    if let Some(ref npub) = config.npub {
        let data = serde_json::json!({
            "type": "nwc",
            "nwc_uri": nwc_uri,
        });
        save_wallet_to_keychain(npub, &data.to_string())?;
    }
    drop(config);

    // Save wallet type to DB config
    let db = state.db();
    db.set_config("wallet_type", "nwc")
        .map_err(|e| format!("DB error: {}", e))?;

    // Store in app state
    let mut wallet_guard = state.wallet.write().await;
    *wallet_guard = Some(wallet::WalletState {
        provider: wallet::WalletProvider::Nwc { client },
        wallet_type: "nwc".to_string(),
        alias: alias.clone(),
    });

    Ok(wallet::WalletInfo {
        wallet_type: "nwc".to_string(),
        connected: true,
        alias,
    })
}

#[tauri::command]
async fn wallet_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    // Shutdown provider
    let mut wallet_guard = state.wallet.write().await;
    if let Some(ws) = wallet_guard.take() {
        if let wallet::WalletProvider::Nwc { client } = ws.provider {
            let _ = client.shutdown().await;
        }
    }

    // Clear keychain
    let config = state.config.read().await;
    if let Some(ref npub) = config.npub {
        delete_wallet_from_keychain(npub);
    }
    drop(config);

    // Clear DB config
    let db = state.db();
    db.set_config("wallet_type", "").ok();
    db.set_config("wallet_lnbits_url", "").ok();

    Ok(())
}

#[tauri::command]
async fn wallet_get_status(state: State<'_, AppState>) -> Result<Option<wallet::WalletInfo>, String> {
    let wallet_guard = state.wallet.read().await;
    Ok(wallet_guard.as_ref().map(|ws| wallet::WalletInfo {
        wallet_type: ws.wallet_type.clone(),
        connected: true,
        alias: ws.alias.clone(),
    }))
}

#[tauri::command]
async fn wallet_get_balance(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let wallet_guard = state.wallet.read().await;
    let ws = wallet_guard.as_ref().ok_or("No wallet connected")?;

    let balance = match &ws.provider {
        wallet::WalletProvider::LNbits { url, admin_key } => {
            wallet::lnbits::get_balance(url, admin_key).await?
        }
        wallet::WalletProvider::Nwc { client } => {
            wallet::nwc_provider::get_balance(client).await?
        }
    };

    Ok(serde_json::json!({ "balance": balance }))
}

#[tauri::command]
async fn wallet_pay_invoice(
    bolt11: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let wallet_guard = state.wallet.read().await;
    let ws = wallet_guard.as_ref().ok_or("No wallet connected")?;

    let preimage = match &ws.provider {
        wallet::WalletProvider::LNbits { url, admin_key } => {
            wallet::lnbits::pay_invoice(url, admin_key, &bolt11).await?
        }
        wallet::WalletProvider::Nwc { client } => {
            wallet::nwc_provider::pay_invoice(client, &bolt11).await?
        }
    };

    Ok(serde_json::json!({ "preimage": preimage }))
}

#[tauri::command]
async fn wallet_make_invoice(
    amount: u64,
    memo: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let wallet_guard = state.wallet.read().await;
    let ws = wallet_guard.as_ref().ok_or("No wallet connected")?;

    let (bolt11, payment_hash) = match &ws.provider {
        wallet::WalletProvider::LNbits { url, admin_key } => {
            wallet::lnbits::make_invoice(url, admin_key, amount, memo.as_deref()).await?
        }
        wallet::WalletProvider::Nwc { client } => {
            wallet::nwc_provider::make_invoice(client, amount, memo.as_deref()).await?
        }
    };

    Ok(serde_json::json!({ "bolt11": bolt11, "payment_hash": payment_hash }))
}

#[tauri::command]
async fn wallet_list_transactions(
    limit: u32,
    offset: u32,
    state: State<'_, AppState>,
) -> Result<Vec<wallet::WalletTransaction>, String> {
    let wallet_guard = state.wallet.read().await;
    let ws = wallet_guard.as_ref().ok_or("No wallet connected")?;

    let mut txs = match &ws.provider {
        wallet::WalletProvider::LNbits { url, admin_key } => {
            wallet::lnbits::list_transactions(url, admin_key, limit, offset).await?
        }
        wallet::WalletProvider::Nwc { client } => {
            wallet::nwc_provider::list_transactions(client, limit, offset).await?
        }
    };

    // Link transactions to zap events
    let db = state.db();
    if let Ok(zaps) = db.query_events_by_kind(9735, 500) {
        for tx in &mut txs {
            if tx.payment_hash.is_empty() {
                continue;
            }
            for (event_id, tags_json) in &zaps {
                if let Ok(tags) = serde_json::from_str::<Vec<Vec<String>>>(tags_json) {
                    for tag in &tags {
                        if tag.len() >= 2 && tag[0] == "bolt11" {
                            if let Ok(decoded) = wallet::bolt11::decode(&tag[1]) {
                                if decoded.payment_hash.as_deref() == Some(&tx.payment_hash) {
                                    tx.linked_zap_event = Some(event_id.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(txs)
}

#[tauri::command]
fn wallet_decode_bolt11(invoice: String) -> Result<wallet::DecodedInvoice, String> {
    wallet::bolt11::decode(&invoice)
}

#[tauri::command]
async fn wallet_provision(state: State<'_, AppState>) -> Result<wallet::WalletInfo, String> {
    let config = state.config.read().await;
    let nsec = config.nsec.clone().ok_or("No nsec available — read-only mode")?;
    let hex_pubkey = config.hex_pubkey.clone().ok_or("No pubkey set")?;
    let npub = config.npub.clone().ok_or("No npub set")?;
    drop(config);

    // Auto-provision wallet
    let (admin_key, _wallet_id, instance_url) =
        wallet::provision::provision_wallet(None, &nsec, &hex_pubkey).await?;

    // Connect using the same flow as wallet_connect_lnbits
    let (alias, _balance) = wallet::lnbits::get_info(&instance_url, &admin_key).await?;

    // Save to keychain
    let data = serde_json::json!({
        "type": "lnbits",
        "url": instance_url,
        "admin_key": admin_key,
    });
    save_wallet_to_keychain(&npub, &data.to_string())?;

    // Save wallet type to DB config
    let db = state.db();
    db.set_config("wallet_type", "lnbits")
        .map_err(|e| format!("DB error: {}", e))?;
    db.set_config("wallet_lnbits_url", &instance_url)
        .map_err(|e| format!("DB error: {}", e))?;

    // Store in app state
    let mut wallet_guard = state.wallet.write().await;
    *wallet_guard = Some(wallet::WalletState {
        provider: wallet::WalletProvider::LNbits {
            url: instance_url,
            admin_key,
        },
        wallet_type: "lnbits".to_string(),
        alias: Some(alias.clone()),
    });

    Ok(wallet::WalletInfo {
        wallet_type: "lnbits".to_string(),
        connected: true,
        alias: Some(alias),
    })
}

// ── Signing helper / Reaction / Author Articles / Profile Relay Fetch ─────────────

async fn sign_build_publish_store(
    builder: nostr_sdk::prelude::EventBuilder,
    state: &State<'_, AppState>,
) -> Result<nostr_sdk::prelude::Event, String> {
    use nostr_sdk::prelude::*;

    let config = state.config.read().await;
    let nsec = config.nsec.clone();
    let relays = config.outbound_relays.clone();
    let hex_pubkey = config.hex_pubkey.clone();
    let signing_mode = config.signing_mode.clone();
    drop(config);

    tracing::info!("[publish] signing_mode={}, has_nsec={}, has_pubkey={}, outbound_relays={}",
        signing_mode, nsec.is_some(), hex_pubkey.is_some(), relays.len());

    // Use signing_mode to decide path, NOT nsec.is_some() — nsec may linger
    // in keychain even after switching to bunker/connect.
    let use_nsec = signing_mode == "nsec" && nsec.is_some();

    let signed = if use_nsec {
        let nsec_str = nsec.unwrap();
        tracing::info!("[publish] signing with local nsec");
        let secret_key = SecretKey::from_bech32(&nsec_str)
            .map_err(|e| format!("Invalid nsec: {}", e))?;
        let keys = Keys::new(secret_key);
        let event = builder.to_event(&keys)
            .map_err(|e| format!("Failed to sign event: {}", e))?;
        tracing::info!("[publish] signed locally: kind={}, id={}", event.kind.as_u16(), &event.id.to_hex()[..12]);
        event
    } else {
        let pubkey_hex = hex_pubkey.ok_or("No signing key configured (no nsec, no pubkey)")?;
        tracing::info!("[publish] using NIP-46 remote signing (mode={}) for pubkey={}...",
            signing_mode, &pubkey_hex[..12.min(pubkey_hex.len())]);

        let pubkey = PublicKey::from_hex(&pubkey_hex)
            .map_err(|e| format!("Invalid hex pubkey: {}", e))?;
        let unsigned = builder.to_unsigned_event(pubkey);

        // Log the full unsigned event for debugging
        let unsigned_json = serde_json::json!({
            "id": unsigned.id.map(|id| id.to_hex()),
            "pubkey": unsigned.pubkey.to_hex(),
            "created_at": unsigned.created_at.as_u64(),
            "kind": unsigned.kind.as_u16(),
            "tags": unsigned.tags.iter().map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<String>>()).collect::<Vec<Vec<String>>>(),
            "content": &unsigned.content[..unsigned.content.len().min(100)],
        });
        tracing::info!("[publish] unsigned event: {}", unsigned_json);

        // Clone signer and drop lock (same pattern as working decrypt_dm)
        let mut signer = {
            let guard = state.nip46_signer.read().await;
            match guard.clone() {
                Some(s) => {
                    tracing::info!("[publish] NIP-46 signer cloned (encryption={:?}), sending sign_event...",
                        s.encryption());
                    s
                }
                None => {
                    tracing::error!("[publish] NIP-46 signer is None! signing_mode={}", signing_mode);
                    return Err("NIP-46 signer not connected. Reconnect your bunker in settings.".to_string());
                }
            }
        };
        // Lock is now dropped

        match signer.sign_event(unsigned).await {
            Ok(event) => {
                tracing::info!("[publish] NIP-46 signed successfully: kind={}, id={}, final_encryption={:?}",
                    event.kind.as_u16(), &event.id.to_hex()[..12], signer.encryption());
                // Write back the signer with updated encryption preference
                {
                    let mut guard = state.nip46_signer.write().await;
                    *guard = Some(signer);
                }
                event
            }
            Err(e) => {
                tracing::error!("[publish] NIP-46 sign_event failed: {}", e);
                return Err(format!("Remote signer failed: {}", e));
            }
        }
    };

    // Publish to outbound relays
    tracing::info!("[publish] publishing to {} outbound relays...", relays.len());
    let client = Client::default();
    for url in &relays {
        client.add_relay(url.as_str()).await.ok();
    }
    // Connect and wait briefly for at least some relays to be ready
    client.connect().await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Send with a timeout so it doesn't hang forever
    match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.send_event(signed.clone())
    ).await {
        Ok(Ok(output)) => {
            tracing::info!("[publish] broadcast complete: event {} sent (success={}, failed={})",
                &signed.id.to_hex()[..12], output.success.len(), output.failed.len());
        }
        Ok(Err(e)) => {
            tracing::error!("[publish] broadcast failed: {}", e);
            // Don't fail — event is signed and stored locally, will be broadcast later
            tracing::warn!("[publish] event stored locally, will retry broadcast on next sync");
        }
        Err(_) => {
            tracing::warn!("[publish] broadcast timed out after 10s, event stored locally");
        }
    }
    client.disconnect().await.ok();

    // Store locally
    let tags_json = serde_json::to_string(
        &signed.tags.iter()
            .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<String>>())
            .collect::<Vec<Vec<String>>>()
    ).unwrap_or_else(|_| "[]".to_string());

    match state.db().store_event(
        &signed.id.to_hex(),
        &signed.pubkey.to_hex(),
        signed.created_at.as_u64() as i64,
        signed.kind.as_u16() as u32,
        &tags_json,
        &signed.content.to_string(),
        &signed.sig.to_string(),
    ) {
        Ok(stored) => tracing::info!("[publish] stored locally: new={}", stored),
        Err(e) => tracing::warn!("[publish] local store failed (non-fatal): {}", e),
    }

    Ok(signed)
}

#[tauri::command]
async fn publish_reaction(
    event_id: String,
    event_pubkey: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    let tags = vec![
        Tag::parse(&["e", &event_id]).map_err(|e| format!("bad e-tag: {}", e))?,
        Tag::parse(&["p", &event_pubkey]).map_err(|e| format!("bad p-tag: {}", e))?,
    ];
    let builder = EventBuilder::new(Kind::Reaction, "+", tags);
    let signed = sign_build_publish_store(builder, &state).await?;
    let reaction_id = signed.id.to_hex();
    tracing::info!("[cmd:publish_reaction] published reaction {} for event {}", &reaction_id[..12.min(reaction_id.len())], &event_id[..12.min(event_id.len())]);
    Ok(reaction_id)
}

#[tauri::command]
async fn publish_note(
    content: String,
    reply_to: Option<String>,
    reply_to_pubkey: Option<String>,
    root_id: Option<String>,
    root_pubkey: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    if content.trim().is_empty() {
        return Err("Note content cannot be empty".to_string());
    }

    let mut tags: Vec<Tag> = Vec::new();

    if let Some(ref reply_id) = reply_to {
        if let Some(ref rid) = root_id {
            tags.push(Tag::parse(&["e", rid, "", "root"]).map_err(|e| format!("bad root e-tag: {}", e))?);
            tags.push(Tag::parse(&["e", reply_id, "", "reply"]).map_err(|e| format!("bad reply e-tag: {}", e))?);
        } else {
            tags.push(Tag::parse(&["e", reply_id, "", "root"]).map_err(|e| format!("bad e-tag: {}", e))?);
        }
        if let Some(ref rp) = root_pubkey {
            tags.push(Tag::parse(&["p", rp]).map_err(|e| format!("bad p-tag: {}", e))?);
        }
        if let Some(ref rp) = reply_to_pubkey {
            if root_pubkey.as_deref() != Some(rp.as_str()) {
                tags.push(Tag::parse(&["p", rp]).map_err(|e| format!("bad p-tag: {}", e))?);
            }
        }
    }

    let builder = EventBuilder::new(Kind::TextNote, &content, tags);
    let signed = sign_build_publish_store(builder, &state).await?;
    let note_id = signed.id.to_hex();
    tracing::info!("[cmd:publish_note] published note {}", &note_id[..12.min(note_id.len())]);
    Ok(note_id)
}

#[tauri::command]
async fn publish_article(
    title: String,
    content: String,
    summary: Option<String>,
    d_tag: Option<String>,
    image: Option<String>,
    hashtags: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use nostr_sdk::prelude::*;

    if title.trim().is_empty() || content.trim().is_empty() {
        return Err("Title and content are required".to_string());
    }

    let slug = d_tag.unwrap_or_else(|| {
        title.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    });

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let mut tags: Vec<Tag> = vec![
        Tag::parse(&["d", &slug]).unwrap(),
        Tag::parse(&["title", &title]).unwrap(),
        Tag::parse(&["published_at", &now.to_string()]).unwrap(),
    ];
    if let Some(ref s) = summary {
        tags.push(Tag::parse(&["summary", s]).unwrap());
    }
    if let Some(ref img) = image {
        tags.push(Tag::parse(&["image", img]).unwrap());
    }
    if let Some(ref ht) = hashtags {
        for t in ht {
            tags.push(Tag::parse(&["t", t]).unwrap());
        }
    }

    let builder = EventBuilder::new(Kind::from(30023), &content, tags);
    let signed = sign_build_publish_store(builder, &state).await?;
    let article_id = signed.id.to_hex();
    tracing::info!("[cmd:publish_article] published article '{}' ({})", &title, &article_id[..12.min(article_id.len())]);
    Ok(article_id)
}

#[tauri::command]
async fn get_author_articles(
    pubkey: String,
    exclude_event_id: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<NostrEvent>, String> {
    let db = state.db();
    let kinds = [30023u32];
    let authors = [pubkey.clone()];
    let rows = db.query_events(None, Some(&authors), Some(&kinds), None, None, limit.unwrap_or(10))
        .map_err(|e| format!("Failed to query articles: {}", e))?;

    // Deduplicate by d-tag (keep newest)
    let mut best: std::collections::HashMap<String, NostrEvent> = std::collections::HashMap::new();
    for row in rows {
        let tags: Vec<Vec<String>> = serde_json::from_str(&row.4).unwrap_or_default();
        let d_tag = tags.iter()
            .find(|t| t.len() >= 2 && t[0] == "d")
            .map(|t| t[1].clone())
            .unwrap_or_default();
        let key = format!("{}:{}", pubkey, d_tag);
        let ev = NostrEvent {
            id: row.0,
            pubkey: row.1,
            created_at: row.2 as u64,
            kind: row.3 as u32,
            tags,
            content: row.5,
            sig: row.6,
        };

        // Skip excluded event
        if let Some(ref excl) = exclude_event_id {
            if &ev.id == excl { continue; }
        }

        let existing = best.get(&key);
        if existing.is_none() || ev.created_at > existing.unwrap().created_at {
            best.insert(key, ev);
        }
    }

    let mut articles: Vec<NostrEvent> = best.into_values().collect();
    articles.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    articles.truncate(limit.unwrap_or(10) as usize);
    Ok(articles)
}

#[tauri::command]
async fn fetch_profiles_from_relay(
    pubkeys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ProfileInfo>, String> {
    use nostr_sdk::prelude::*;

    if pubkeys.is_empty() {
        return Ok(vec![]);
    }

    // Filter to only pubkeys NOT already in DB (or with empty profiles)
    let db = state.db();
    let existing = db.get_profiles(&pubkeys).map_err(|e| e.to_string())?;
    let existing_with_data: std::collections::HashSet<String> = existing.iter()
        .filter(|p| p.name.is_some() || p.display_name.is_some() || p.picture.is_some())
        .map(|p| p.pubkey.clone())
        .collect();

    let missing: Vec<String> = pubkeys.into_iter()
        .filter(|pk| !existing_with_data.contains(pk))
        .collect();

    if missing.is_empty() {
        return Ok(vec![]);
    }

    tracing::info!("[cmd:fetch_profiles_from_relay] fetching {} missing profiles from relays", missing.len());

    let config = state.config.read().await;
    let mut relay_urls = config.outbound_relays.clone();
    drop(config);

    // Add purplepag.es as a primary source for profile metadata
    let purplepages = "wss://purplepag.es".to_string();
    if !relay_urls.contains(&purplepages) {
        relay_urls.insert(0, purplepages);
    }

    let authors: Vec<PublicKey> = missing.iter()
        .filter_map(|pk| PublicKey::from_hex(pk).ok())
        .collect();

    if authors.is_empty() {
        return Ok(vec![]);
    }

    let filter = Filter::new()
        .kinds(vec![Kind::Metadata])
        .authors(authors);

    let client = Client::default();
    for url in &relay_urls[..relay_urls.len().min(3)] {
        if let Ok(_) = client.add_relay(url.as_str()).await {
            client.connect_relay(url.as_str()).await.ok();
        }
    }

    let mut notifications = client.notifications();
    let sub_id = match client.subscribe(vec![filter], None).await {
        Ok(output) => output.val,
        Err(e) => {
            client.disconnect().await.ok();
            return Err(format!("Subscribe failed: {}", e));
        }
    };

    let mut fetched_events: Vec<Event> = Vec::new();
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(10));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = notifications.recv() => {
                match result {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if event.kind == Kind::Metadata {
                            fetched_events.push(*event);
                        }
                    }
                    Ok(RelayPoolNotification::Message { message, .. }) => {
                        if matches!(&message, RelayMessage::EndOfStoredEvents(_)) {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            _ = &mut deadline => break,
        }
    }

    client.unsubscribe(sub_id).await;
    client.disconnect().await.ok();

    // Store fetched metadata events
    for event in &fetched_events {
        let tags_json = serde_json::to_string(
            &event.tags.iter()
                .map(|t| t.as_slice().iter().map(|s| s.to_string()).collect::<Vec<String>>())
                .collect::<Vec<Vec<String>>>()
        ).unwrap_or_else(|_| "[]".to_string());

        db.store_event(
            &event.id.to_hex(),
            &event.pubkey.to_hex(),
            event.created_at.as_u64() as i64,
            event.kind.as_u16() as u32,
            &tags_json,
            &event.content.to_string(),
            &event.sig.to_string(),
        ).ok();
    }

    // Return newly cached profiles
    let fetched_pks: Vec<String> = fetched_events.iter().map(|e| e.pubkey.to_hex()).collect();
    if fetched_pks.is_empty() {
        return Ok(vec![]);
    }
    db.get_profiles(&fetched_pks).map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_zap(
    recipient_pubkey: String,
    event_id: String,
    lud16: String,
    amount_sats: u64,
    comment: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = state.config.read().await;
    let nsec = config.nsec.clone().ok_or("No nsec available — read-only mode")?;
    let relays = config.outbound_relays.clone();
    drop(config);

    // Resolve LNURL
    let params = wallet::zap::resolve_lnurl(&lud16).await?;

    let amount_msats = amount_sats * 1000;
    if amount_msats < params.min_sendable {
        return Err(format!("Amount too low (min {} sats)", params.min_sendable / 1000));
    }
    if amount_msats > params.max_sendable {
        return Err(format!("Amount too high (max {} sats)", params.max_sendable / 1000));
    }

    // Build zap request (kind:9734) if recipient supports nostr zaps
    let zap_request_json = if params.allows_nostr {
        Some(wallet::zap::build_zap_request(
            &nsec,
            &recipient_pubkey,
            &event_id,
            amount_msats,
            comment.as_deref().unwrap_or(""),
            &relays,
        )?)
    } else {
        None
    };

    // Fetch invoice from LNURL callback
    let bolt11 = if let Some(ref zap_json) = zap_request_json {
        wallet::zap::fetch_zap_invoice(&params.callback, amount_msats, zap_json).await?
    } else {
        // No nostr zap support — just get a regular invoice
        let separator = if params.callback.contains('?') { "&" } else { "?" };
        let url = format!("{}{}amount={}", params.callback, separator, amount_msats);
        let resp = reqwest::Client::new()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("LNURL callback failed: {}", e))?;
        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("LNURL callback parse error: {}", e))?;
        data["pr"]
            .as_str()
            .ok_or("No invoice in LNURL callback response")?
            .to_string()
    };

    // Pay the invoice via connected wallet
    let wallet_guard = state.wallet.read().await;
    let ws = wallet_guard.as_ref().ok_or("No wallet connected")?;

    let preimage = match &ws.provider {
        wallet::WalletProvider::LNbits { url, admin_key } => {
            wallet::lnbits::pay_invoice(url, admin_key, &bolt11).await?
        }
        wallet::WalletProvider::Nwc { client } => {
            wallet::nwc_provider::pay_invoice(client, &bolt11).await?
        }
    };

    Ok(serde_json::json!({ "preimage": preimage }))
}

// ── App Entry ──────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set up dual logging: console (INFO+) and rotating file (nostrito.log)
    {
        use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

        let log_dir = dirs::home_dir()
            .or_else(|| dirs::data_dir())
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
            .or_else(|| {
                let p = PathBuf::from("/data/data/lat.nostrito/files");
                if p.exists() || std::fs::create_dir_all(&p).is_ok() { Some(p) } else { None }
            })
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join(".nostrito");

        let env_filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,nostrito_lib=info,nostrito_lib::sync=debug"));

        // Try to set up file logging; skip if directory can't be created (e.g. sandboxed mobile)
        if std::fs::create_dir_all(&log_dir).is_ok() {
            let file_appender = tracing_appender::rolling::daily(&log_dir, "nostrito.log");
            let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);
            std::mem::forget(_guard);

            tracing_subscriber::registry()
                .with(env_filter)
                .with(
                    fmt::layer()
                        .with_target(true)
                        .with_ansi(true),
                )
                .with(
                    fmt::layer()
                        .with_target(true)
                        .with_ansi(false)
                        .with_writer(file_writer),
                )
                .init();
        } else {
            // Console-only logging (mobile fallback)
            tracing_subscriber::registry()
                .with(env_filter)
                .with(
                    fmt::layer()
                        .with_target(true)
                        .with_ansi(false),
                )
                .init();
        }
    }

    tracing::info!("[init] Starting nostrito");

    // Determine data directory
    let data_dir = dirs::data_dir()
        .or_else(|| dirs::home_dir())
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .or_else(|| {
            // Android fallback: app-private internal storage
            let android_path = PathBuf::from("/data/data/lat.nostrito/files");
            if android_path.exists() || std::fs::create_dir_all(&android_path).is_ok() {
                Some(android_path)
            } else {
                None
            }
        })
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nostrito");
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        fatal_exit(&format!("Failed to create data directory {}: {}", data_dir.display(), e));
    }

    // Open lobby DB to check for saved npub
    let lobby_path = lobby_db_path(&data_dir);
    tracing::info!("[init] lobby_db_path={}", lobby_path.display());
    let lobby_db = match Database::open(&lobby_path) {
        Ok(db) => db,
        Err(e) => {
            fatal_exit(&format!("Failed to open lobby database {}: {}", lobby_path.display(), e));
        }
    };

    // If there's a saved npub, open the per-npub database
    let db = if let Ok(Some(ref npub)) = lobby_db.get_config("npub") {
        let user_path = db_path_for_npub(&data_dir, npub);
        tracing::info!("[init] Found saved npub={}, per-user db={}", npub, user_path.display());

        if !user_path.exists() && lobby_db.event_count().unwrap_or(0) > 0 {
            // Migrate: copy lobby DB as the per-user DB (one-time migration)
            tracing::info!("[init] Migrating lobby DB → per-user DB");
            drop(lobby_db);
            if let Err(e) = std::fs::copy(&lobby_path, &user_path) {
                fatal_exit(&format!("Failed to copy lobby DB to {}: {}", user_path.display(), e));
            }
            Arc::new(Database::open(&user_path).unwrap_or_else(|e| {
                fatal_exit(&format!("Failed to open per-user database {}: {}", user_path.display(), e));
            }))
        } else {
            drop(lobby_db);
            Arc::new(Database::open(&user_path).unwrap_or_else(|e| {
                fatal_exit(&format!("Failed to open per-user database {}: {}", user_path.display(), e));
            }))
        }
    } else {
        tracing::info!("[init] No saved npub, using lobby DB");
        Arc::new(lobby_db)
    };

    tracing::info!("[init] Database opened successfully");

    // Initialize WoT graph
    let wot_graph = Arc::new(WotGraph::new());

    // Load existing graph from DB
    if let Err(e) = db.load_graph(&wot_graph) {
        tracing::warn!("Failed to load graph from DB: {}", e);
    }

    let stats = wot_graph.stats();
    tracing::info!(
        "Loaded WoT graph: {} nodes, {} edges",
        stats.node_count,
        stats.edge_count
    );

    // Load saved config
    let mut config = AppConfig::default();
    if let Ok(Some(npub)) = db.get_config("npub") {
        tracing::info!("[init] Loaded npub from DB: {}", &npub);
        config.npub = Some(npub);
    }
    if let Ok(Some(hex)) = db.get_config("hex_pubkey") {
        tracing::info!("[init] Loaded hex_pubkey from DB: {}...", &hex[..std::cmp::min(8, hex.len())]);
        config.hex_pubkey = Some(hex);
    }
    if let Ok(Some(relays_csv)) = db.get_config("outbound_relays") {
        let relays: Vec<String> = relays_csv
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| resolve_relay_alias(s).to_string())
            .collect();
        if !relays.is_empty() {
            tracing::info!("[init] Loaded {} relays from DB: {:?}", relays.len(), relays);
            config.outbound_relays = relays;
        } else {
            tracing::warn!(
                "[init] DB has outbound_relays key but parsed to empty list (raw: {:?}). \
                 Using defaults: {:?}",
                relays_csv, config.outbound_relays
            );
        }
    } else {
        tracing::info!(
            "[init] No outbound_relays in DB — using defaults: {:?}",
            config.outbound_relays
        );
    }
    // Load sync tuning config
    if let Ok(Some(v)) = db.get_config("sync_lookback_days") { if let Ok(n) = v.parse::<u32>() { config.sync_lookback_days = n; } }
    if let Ok(Some(v)) = db.get_config("sync_batch_size") { if let Ok(n) = v.parse::<u32>() { config.sync_batch_size = n; } }
    if let Ok(Some(v)) = db.get_config("sync_events_per_batch") { if let Ok(n) = v.parse::<u32>() { config.sync_events_per_batch = n; } }
    if let Ok(Some(v)) = db.get_config("sync_batch_pause_secs") { if let Ok(n) = v.parse::<u32>() { config.sync_batch_pause_secs = n; } }
    if let Ok(Some(v)) = db.get_config("sync_relay_min_interval_secs") { if let Ok(n) = v.parse::<u32>() { config.sync_relay_min_interval_secs = n; } }
    if let Ok(Some(v)) = db.get_config("sync_wot_batch_size") { if let Ok(n) = v.parse::<u32>() { config.sync_wot_batch_size = n; } }
    if let Ok(Some(v)) = db.get_config("sync_wot_events_per_batch") { if let Ok(n) = v.parse::<u32>() { config.sync_wot_events_per_batch = n; } }
    if let Ok(Some(v)) = db.get_config("max_event_age_days") { if let Ok(n) = v.parse::<u32>() { config.max_event_age_days = n; } }
    if let Ok(Some(v)) = db.get_config("sync_wot_notes_per_cycle") { if let Ok(n) = v.parse::<u32>() { config.sync_wot_notes_per_cycle = n; } }
    if let Ok(Some(v)) = db.get_config("offline_mode") { config.offline_mode = v == "true"; }
    if let Ok(Some(v)) = db.get_config("storage_own_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_own_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_tracked_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_tracked_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_wot_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_wot_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("wot_event_retention_days") { if let Ok(n) = v.parse::<u32>() { config.wot_event_retention_days = n; } }
    if let Ok(Some(v)) = db.get_config("thread_retention_days") { if let Ok(n) = v.parse::<u32>() { config.thread_retention_days = n; } }

    // Load additional settings that are now persisted by save_settings
    if let Ok(Some(v)) = db.get_config("relay_port") { if let Ok(n) = v.parse::<u16>() { config.relay_port = n; } }
    if let Ok(Some(v)) = db.get_config("max_storage_mb") { if let Ok(n) = v.parse::<u32>() { config.max_storage_mb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_others_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_others_gb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("wot_max_depth") { if let Ok(n) = v.parse::<u32>() { config.wot_max_depth = n; } }
    if let Ok(Some(v)) = db.get_config("sync_interval_secs") { if let Ok(n) = v.parse::<u32>() { config.sync_interval_secs = n; } }
    // Load signing credentials from system keychain.
    // If a bunker is stored, prefer it over nsec (bunker setup clears nsec
    // from in-memory config but the old nsec may still be in the keychain).
    if let Some(ref npub) = config.npub {
        tracing::info!("[init] Checking keychain for npub={}", npub);
        let bunker_data = load_bunker_from_keychain(npub);
        let has_bunker = bunker_data.is_some();
        if let Some((ref uri, _)) = bunker_data {
            tracing::info!("[init] Found bunker in keychain: uri={}...", &uri[..uri.len().min(60)]);
        } else {
            tracing::info!("[init] No bunker found in keychain for this npub");
        }
        let has_nsec = load_nsec_from_keychain(npub).is_some();
        tracing::info!("[init] Keychain: has_bunker={}, has_nsec={}", has_bunker, has_nsec);

        if !has_bunker {
            if let Some(nsec) = load_nsec_from_keychain(npub) {
                tracing::info!("[init] Using nsec from keychain");
                config.nsec = Some(nsec);
                config.signing_mode = "nsec".to_string();
            }
        } else {
            tracing::info!("[init] Bunker credentials found, skipping nsec (will reconnect bunker)");
            config.nsec = None;
            config.signing_mode = "read-only".to_string(); // will be updated after bunker reconnect
        }
    } else {
        tracing::info!("[init] No npub configured, skipping keychain checks");
    }

    tracing::info!("[init] Config: npub={:?}, relays={:?}, port={}, signing={}", config.npub, config.outbound_relays, config.relay_port, if config.nsec.is_some() { "nsec" } else { "read-only" });

    // ── STARTUP LOG ──
    {
        let event_count = db.event_count().unwrap_or(0);
        let wot_stats = wot_graph.stats();
        let follows_count = config.hex_pubkey.as_ref()
            .and_then(|pk| wot_graph.get_follows(pk))
            .map(|f| f.len())
            .unwrap_or(0);
        // Normalize any npub entries in tracked_profiles to hex
        match db.normalize_tracked_profiles() {
            Ok(n) if n > 0 => tracing::info!("[init] normalized {} tracked profile(s) from npub to hex", n),
            Err(e) => tracing::warn!("[init] tracked profile normalization failed: {}", e),
            _ => {}
        }
        let tracked_pubkeys = db.get_tracked_pubkeys().unwrap_or_default();
        let tracked_count = tracked_pubkeys.len();
        if !tracked_pubkeys.is_empty() {
            let previews: Vec<String> = tracked_pubkeys.iter().map(|pk| format!("{}...", &pk[..pk.len().min(16)])).collect();
            tracing::info!("[init] tracked pubkeys ({}): {:?}", tracked_count, previews);
        }
        let npub_display = config.npub.as_deref().unwrap_or("(not set)");
        let relay_list: Vec<&str> = config.outbound_relays.iter().map(|s| s.as_str()).collect();

        tracing::info!(
            "\n[NOSTRITO STARTUP]\n  npub: {}\n  relays configured: {} → {:?}\n  own events in DB: {}\n  follows: {}\n  tracked profiles: {}\n  wot peers: {}\n  cycle interval: {}s",
            npub_display,
            relay_list.len(), relay_list,
            event_count,
            follows_count,
            tracked_count,
            wot_stats.node_count,
            config.sync_interval_secs,
        );
    }

    let app_state = AppState {
        wot_graph,
        db: parking_lot::RwLock::new(db),
        config: Arc::new(RwLock::new(config)),
        data_dir,
        sync_cancel: Arc::new(RwLock::new(None)),
        sync_tier: Arc::new(AtomicU8::new(0)),
        sync_stats: Arc::new(RwLock::new(SyncStats::default())),
        relay_cancel: Arc::new(RwLock::new(None)),
        start_time: std::time::Instant::now(),
        wallet: wallet::new_shared_wallet_state(),
        nip46_signer: Arc::new(RwLock::new(None)),
    };

    // Install rustls ring crypto provider before any TLS code runs
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            let state = app.state::<AppState>();
            let config = state.config.clone();
            let wot_graph = state.wot_graph.clone();
            let db = state.db();
            let sync_tier = state.sync_tier.clone();
            let sync_stats = state.sync_stats.clone();
            let sync_cancel = state.sync_cancel.clone();
            let app_handle = app.handle().clone();

            // Restore wallet connection from keychain
            {
                let wallet_state = state.wallet.clone();
                let wallet_config = state.config.clone();
                tauri::async_runtime::spawn(async move {
                    let cfg = wallet_config.read().await;
                    if let Some(ref npub) = cfg.npub {
                        if let Some(data) = load_wallet_from_keychain(npub) {
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                                match parsed["type"].as_str() {
                                    Some("lnbits") => {
                                        let url = parsed["url"].as_str().unwrap_or("").to_string();
                                        let admin_key = parsed["admin_key"].as_str().unwrap_or("").to_string();
                                        if !url.is_empty() && !admin_key.is_empty() {
                                            let alias = wallet::lnbits::get_info(&url, &admin_key)
                                                .await
                                                .ok()
                                                .map(|(a, _)| a);
                                            let mut guard = wallet_state.write().await;
                                            *guard = Some(wallet::WalletState {
                                                provider: wallet::WalletProvider::LNbits { url, admin_key },
                                                wallet_type: "lnbits".to_string(),
                                                alias,
                                            });
                                            tracing::info!("[wallet] Restored LNbits connection from keychain");
                                        }
                                    }
                                    Some("nwc") => {
                                        if let Some(uri) = parsed["nwc_uri"].as_str() {
                                            match wallet::nwc_provider::connect(uri).await {
                                                Ok((client, alias)) => {
                                                    let mut guard = wallet_state.write().await;
                                                    *guard = Some(wallet::WalletState {
                                                        provider: wallet::WalletProvider::Nwc { client },
                                                        wallet_type: "nwc".to_string(),
                                                        alias,
                                                    });
                                                    tracing::info!("[wallet] Restored NWC connection from keychain");
                                                }
                                                Err(e) => {
                                                    tracing::warn!("[wallet] Failed to restore NWC: {}", e);
                                                }
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                });
            }

            // Reconnect NIP-46 bunker signer from keychain
            {
                let nip46_for_reconnect = state.nip46_signer.clone();
                let config_for_reconnect = state.config.clone();

                tauri::async_runtime::spawn(async move {
                    let cfg = config_for_reconnect.read().await;
                    tracing::info!("[init:bunker-reconnect] signing_mode={}, npub={:?}",
                        cfg.signing_mode, cfg.npub.as_deref().map(|s| &s[..s.len().min(16)]));
                    if cfg.signing_mode == "nsec" {
                        tracing::info!("[init:bunker-reconnect] skipping — using local nsec");
                        return;
                    }
                    let npub = match cfg.npub.as_ref() {
                        Some(n) => n.clone(),
                        None => {
                            tracing::info!("[init:bunker-reconnect] skipping — no npub");
                            return;
                        }
                    };
                    drop(cfg);

                    let bunker_data = load_bunker_from_keychain(&npub);
                    tracing::info!("[init:bunker-reconnect] keychain lookup for {}: found={}",
                        &npub[..npub.len().min(16)], bunker_data.is_some());
                    if let Some((bunker_uri_str, app_keys_nsec)) = bunker_data {
                        use nostr_sdk::prelude::*;
                        tracing::info!("[init] Attempting NIP-46 reconnection: uri={}...", &bunker_uri_str[..bunker_uri_str.len().min(60)]);

                        let parse_result = (|| -> Result<(NostrConnectURI, Keys), String> {
                            let uri = NostrConnectURI::parse(&bunker_uri_str)
                                .map_err(|e| format!("Invalid bunker URI: {}", e))?;
                            let secret_key = SecretKey::from_bech32(&app_keys_nsec)
                                .map_err(|e| format!("Invalid app keys: {}", e))?;
                            Ok((uri, Keys::new(secret_key)))
                        })();

                        match parse_result {
                            Ok((uri, app_keys)) => {
                                let signer_pk = match uri.signer_public_key() {
                                    Some(pk) => pk,
                                    None => {
                                        tracing::warn!("[init] Bunker URI has no signer public key");
                                        return;
                                    }
                                };
                                let secret = uri.secret();
                                let relays = uri.relays();

                                // Load stored encryption preference (default NIP-04)
                                let encryption = crate::nip46::Nip46Encryption::Nip04; // default
                                // Note: we can't access db here easily since it's in a spawned task
                                // The encryption is re-detected on first failed request anyway

                                tracing::info!("[init] reconnecting: signer_pk={}..., encryption={:?}, relays={}, has_secret={}",
                                    &signer_pk.to_hex()[..12], encryption, relays.len(), secret.is_some());
                                match crate::nip46::Nip46Client::reconnect(signer_pk, relays, app_keys, secret, encryption, std::time::Duration::from_secs(60)).await {
                                    Ok(signer) => {
                                        let mode = if bunker_uri_str.starts_with("bunker://") { "bunker" } else { "connect" };
                                        {
                                            let mut nip46 = nip46_for_reconnect.write().await;
                                            *nip46 = Some(signer);
                                        }
                                        {
                                            let mut cfg = config_for_reconnect.write().await;
                                            cfg.signing_mode = mode.to_string();
                                        }
                                        tracing::info!("[init] NIP-46 bunker reconnected (mode={})", mode);
                                    }
                                    Err(e) => {
                                        tracing::warn!("[init] NIP-46 bunker reconnection failed: {}", e);
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!("[init] Failed to parse stored bunker credentials: {}", e);
                            }
                        }
                    }
                });
            }

            // Auto-resume sync and relay if previously configured
            let relay_cancel_setup = state.relay_cancel.clone();
            let db_relay = state.db();

            tauri::async_runtime::spawn(async move {
                let cfg = config.read().await;
                if let Some(ref hex_pubkey) = cfg.hex_pubkey {
                    let relays = cfg.outbound_relays.clone();
                    let hex: String = hex_pubkey.clone();
                    let port = cfg.relay_port;
                    let allowed = cfg.hex_pubkey.clone();
                    let offline = cfg.offline_mode;
                    drop(cfg);

                    if offline {
                        tracing::info!("[init] Offline mode active — skipping sync engine auto-resume for {}", &hex[..8]);
                    } else {
                        tracing::info!("Auto-resuming sync for {}...", &hex[..8]);

                        let cfg2 = config.read().await;
                        let tracked_media_gb = cfg2.storage_tracked_media_gb;
                        let wot_media_gb = cfg2.storage_wot_media_gb;
                        let max_age_days = cfg2.max_event_age_days;
                        let sync_config = SyncConfig {
                            lookback_days: cfg2.sync_lookback_days,
                            batch_size: cfg2.sync_batch_size,
                            events_per_batch: cfg2.sync_events_per_batch,
                            batch_pause_secs: cfg2.sync_batch_pause_secs,
                            relay_min_interval_secs: cfg2.sync_relay_min_interval_secs,
                            wot_batch_size: cfg2.sync_wot_batch_size,
                            wot_events_per_batch: cfg2.sync_wot_events_per_batch,
                            cycle_interval_secs: cfg2.sync_interval_secs,
                            wot_notes_per_cycle: cfg2.sync_wot_notes_per_cycle,
                            thread_retention_days: cfg2.thread_retention_days,
                        };
                        drop(cfg2);
                        let cancel = start_sync_engine(
                            wot_graph,
                            db,
                            relays,
                            hex,
                            sync_tier,
                            sync_stats,
                            app_handle.clone(),
                            tracked_media_gb,
                            wot_media_gb,
                            sync_config,
                            max_age_days,
                        );
                        *sync_cancel.write().await = Some(cancel);
                    }

                    // Auto-setup mkcert (desktop only — needs OS trust store)
                    #[cfg(desktop)]
                    {
                        let cert_check = dirs::home_dir()
                            .unwrap_or_default()
                            .join(".nostrito/certs/localhost.pem");
                        if !cert_check.exists() {
                            tracing::info!("[mkcert] Certs missing — setting up browser integration automatically");
                            let app_clone = app_handle.clone();
                            match tokio::task::spawn_blocking(move || run_mkcert_setup(&app_clone)).await {
                                Ok(Ok(_)) => tracing::info!("[mkcert] Browser integration ready"),
                                Ok(Err(e)) => tracing::warn!("[mkcert] Setup failed (non-fatal): {}", e),
                                Err(e) => tracing::warn!("[mkcert] Task panicked (non-fatal): {}", e),
                            }
                        }
                    }

                    // Auto-start relay (TLS on desktop if certs available, plain WS everywhere)
                    let relay_ct = CancellationToken::new();
                    let relay_ct_clone = relay_ct.clone();
                    let outbound_tx = spawn_outbound_broadcaster(config.clone(), app_handle.clone());

                    let cert_path = dirs::home_dir()
                        .unwrap_or_default()
                        .join(".nostrito/certs/localhost.pem");
                    let key_path = dirs::home_dir()
                        .unwrap_or_default()
                        .join(".nostrito/certs/localhost-key.pem");

                    if cert_path.exists() && key_path.exists() {
                        let tls_cancel = relay_ct_clone.clone();
                        let tls_db = db_relay.clone();
                        let tls_allowed = allowed.clone();
                        let tls_outbound = outbound_tx.clone();
                        tracing::info!("[relay] Auto-starting TLS relay on wss://127.0.0.1:{}", port);
                        tokio::spawn(async move {
                            if let Err(e) = relay::run_relay_tls(
                                port, cert_path, key_path, tls_db, tls_allowed, tls_cancel, Some(tls_outbound),
                            )
                            .await
                            {
                                tracing::error!("TLS relay auto-start error: {}", e);
                            }
                        });
                        let plain_port = port + 1;
                        tracing::info!("[relay] Auto-starting plain relay on ws://127.0.0.1:{} (browser fallback)", plain_port);
                        tokio::spawn(async move {
                            if let Err(e) =
                                relay::run_relay(plain_port, db_relay, allowed, relay_ct_clone, Some(outbound_tx)).await
                            {
                                tracing::error!("Plain relay auto-start error: {}", e);
                            }
                        });
                    } else {
                        tracing::info!("[relay] Auto-starting plain relay on ws://127.0.0.1:{}", port);
                        tokio::spawn(async move {
                            if let Err(e) =
                                relay::run_relay(port, db_relay, allowed, relay_ct_clone, Some(outbound_tx)).await
                            {
                                tracing::error!("Relay auto-start error: {}", e);
                            }
                        });
                    }
                    *relay_cancel_setup.write().await = Some(relay_ct);

                    tracing::info!("Sync auto-resumed successfully");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            init_nostrito,
            get_wot,
            get_follows,
            get_profiles_batch,
            get_wot_distance,
            get_wot_hop_distances,
            get_feed,
            get_event,
            get_note_replies,
            get_note_reactions,
            get_note_zaps,
            get_thread_events,
            get_interaction_counts,
            fetch_thread_from_relays,
            fetch_global_feed,
            fetch_wot_articles,
            save_event,
            bookmark_media,
            unbookmark_media,
            is_media_bookmarked,
            get_bookmarked_media,
            find_event_for_media,
            delete_media_files,
            fetch_events_by_ids,
            search_events,
            search_global,
            get_storage_stats,
            get_ownership_storage_stats,
            prune_wot_data,
            get_storage_estimate,
            get_settings,
            save_settings,
            start_sync,
            stop_sync,
            set_offline_mode,
            start_relay,
            stop_relay,
            get_uptime,
            reset_app_data,
            change_account,
            get_activity_data,
            get_relay_status,
            get_kind_counts,
            get_dm_events,
            get_profiles,
            search_profiles,
            get_own_profile,
            setup_browser_integration,
            check_browser_integration,
            get_media_stats,
            get_own_media,
            get_profile_media,
            restart_sync,
            reset_sync_cursors,
            get_followers,
            is_tracked_profile,
            is_pubkey_muted_cmd,
            mute_pubkey,
            unmute_pubkey,
            hex_to_npub,
            track_profile,
            untrack_profile,
            get_tracked_profiles,
            get_tracked_profiles_detail,
            get_kind_counts_for_category,
            get_media_breakdown_for_category,
            get_events_for_category,
            get_media_for_category,
            get_event_media_for_category,
            requeue_profile_media,
            download_tracked_media,
            fetch_profile,
            get_profile_with_refresh,
            nsec_to_npub,
            set_nsec,
            clear_nsec,
            get_signing_mode,
            decrypt_dm,
            connect_bunker,
            generate_nostr_connect_uri,
            await_nostr_connect,
            disconnect_bunker,
            get_addressable_event,
            wallet_connect_lnbits,
            wallet_connect_nwc,
            wallet_disconnect,
            wallet_get_status,
            wallet_get_balance,
            wallet_pay_invoice,
            wallet_make_invoice,
            wallet_list_transactions,
            wallet_decode_bolt11,
            wallet_provision,
            send_zap,
            publish_reaction,
            publish_note,
            publish_dm,
            publish_article,
            get_author_articles,
            fetch_profiles_from_relay,
            fetch_profile_content_from_relays,
            fetch_note_context_from_relays,
            fetch_addressable_event_from_relays,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            fatal_exit(&format!("Fatal error running nostrito: {}", e));
        });
}
