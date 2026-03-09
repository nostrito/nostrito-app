mod relay;
mod storage;
mod sync;
mod wot;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use storage::{Database, ProfileInfo};
use sync::{SyncEngine, SyncStats, SyncTier};
use wot::WotGraph;

// ── App State ──────────────────────────────────────────────────────

pub struct AppState {
    pub wot_graph: Arc<WotGraph>,
    pub db: Arc<Database>,
    pub config: Arc<RwLock<AppConfig>>,
    pub db_path: PathBuf,
    pub sync_cancel: Arc<RwLock<Option<CancellationToken>>>,
    pub sync_tier: Arc<AtomicU8>,
    pub sync_stats: Arc<RwLock<SyncStats>>,
    pub relay_cancel: Arc<RwLock<Option<CancellationToken>>>,
    pub start_time: std::time::Instant,
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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            npub: None,
            hex_pubkey: None,
            relay_port: 4869,
            max_storage_mb: 500,
            wot_max_depth: 3,
            sync_interval_secs: 300,
            outbound_relays: vec![
                "wss://relay.damus.io".into(),
                "wss://nos.lol".into(),
                "wss://relay.nostr.band".into(),
            ],
            auto_start: true,
            storage_others_gb: 5.0,
            storage_media_gb: 2.0,
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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WotStatus {
    pub root_pubkey: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub nodes_with_follows: usize,
}

#[derive(Debug, Serialize, Deserialize)]
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
    pub wot_only: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageStats {
    pub total_events: u64,
    pub db_size_bytes: u64,
    pub oldest_event: u64,
    pub newest_event: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub npub: String,
    pub relay_port: u16,
    pub max_storage_mb: u32,
    pub wot_max_depth: u32,
    pub sync_interval_secs: u32,
    pub outbound_relays: Vec<String>,
    pub auto_start: bool,
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
    let events_stored = state.db.event_count().unwrap_or(0);

    tracing::info!("[cmd:get_status] relay_running={}, events={}, wot_nodes={}, sync_tier={}", relay_running, events_stored, stats.node_count, current_tier);

    Ok(AppStatus {
        initialized: config.npub.is_some(),
        npub: config.npub.clone(),
        relay_running,
        relay_port: config.relay_port,
        events_stored,
        wot_nodes: stats.node_count,
        wot_edges: stats.edge_count,
        sync_status: if sync_running {
            match SyncTier::from(current_tier) {
                SyncTier::Critical => "syncing (tier 1: critical)".into(),
                SyncTier::Important => "syncing (tier 2: recent events)".into(),
                SyncTier::Background => "syncing (tier 3: WoT crawl)".into(),
                SyncTier::Archive => "syncing (tier 4: archive)".into(),
                SyncTier::Idle => "idle".into(),
            }
        } else {
            "idle".into()
        },
        sync_tier: current_tier,
        sync_stats,
    })
}

#[tauri::command]
async fn init_nostrito(
    npub: String,
    relays: Vec<String>,
    storage_others_gb: Option<f64>,
    storage_media_gb: Option<f64>,
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

    // Update config
    {
        let mut config = state.config.write().await;
        config.npub = Some(npub.clone());
        config.hex_pubkey = Some(hex_pubkey.clone());
        if !relays.is_empty() {
            config.outbound_relays = relays.clone();
        }
        if let Some(gb) = storage_others_gb {
            config.storage_others_gb = gb;
        }
        if let Some(gb) = storage_media_gb {
            config.storage_media_gb = gb;
        }
    }

    // Persist to DB
    state
        .db
        .set_config("npub", &npub)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    state
        .db
        .set_config("hex_pubkey", &hex_pubkey)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    if !relays.is_empty() {
        state
            .db
            .set_config("outbound_relays", &relays.join(","))
            .map_err(|e| format!("Failed to save relays: {}", e))?;
    }

    // Load existing graph from DB
    state
        .db
        .load_graph(&state.wot_graph)
        .map_err(|e| format!("Failed to load graph: {}", e))?;

    // Start tiered sync engine
    let config = state.config.read().await;
    let sync_engine = Arc::new(SyncEngine::new(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
        hex_pubkey.clone(),
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle,
    ));

    let cancel = sync_engine.start();
    *state.sync_cancel.write().await = Some(cancel);

    // Auto-setup mkcert if certs don't exist (first launch)
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

    // Auto-start relay (TLS if certs available)
    {
        let config = state.config.read().await;
        let port = config.relay_port;
        let allowed = config.hex_pubkey.clone();
        drop(config);

        let db_relay = state.db.clone();
        let relay_cancel = CancellationToken::new();
        let relay_cancel_clone = relay_cancel.clone();

        let cert_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".nostrito/certs/localhost.pem");
        let key_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".nostrito/certs/localhost-key.pem");

        if cert_path.exists() && key_path.exists() {
            tracing::info!("[relay] Starting TLS relay on wss://127.0.0.1:{}", port);
            tokio::spawn(async move {
                if let Err(e) =
                    relay::run_relay_tls(port, cert_path, key_path, db_relay, allowed, relay_cancel_clone)
                        .await
                {
                    tracing::error!("TLS relay error: {}", e);
                }
            });
        } else {
            tracing::info!("[relay] Starting plain relay on ws://127.0.0.1:{}", port);
            tokio::spawn(async move {
                if let Err(e) = relay::run_relay(port, db_relay, allowed, relay_cancel_clone).await {
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

    let sync_engine = Arc::new(SyncEngine::new(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
        hex_pubkey,
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle,
    ));

    let cancel = sync_engine.start();
    *state.sync_cancel.write().await = Some(cancel);

    Ok(())
}

#[tauri::command]
async fn stop_sync(state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:stop_sync] called");
    let cancel = state.sync_cancel.write().await.take();
    if let Some(cancel) = cancel {
        cancel.cancel();
        state.sync_tier.store(SyncTier::Idle as u8, Ordering::Relaxed);
        tracing::info!("Sync engine stopped");
    }
    Ok(())
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

    let events = state
        .db
        .query_events(None, None, kinds, filter.since, None, limit)
        .map_err(|e| {
            tracing::error!("[cmd:get_feed] query failed: {}", e);
            format!("Failed to query events: {}", e)
        })?;

    tracing::info!("[cmd:get_feed] returning {} events", events.len());

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
async fn get_storage_stats(state: State<'_, AppState>) -> Result<StorageStats, String> {
    tracing::debug!("[cmd:get_storage_stats] called");
    let total_events = state.db.event_count().map_err(|e| e.to_string())?;
    let db_size_bytes = state.db.db_size_bytes().map_err(|e| e.to_string())?;
    let (oldest_event, newest_event) = state.db.event_time_range().map_err(|e| e.to_string())?;

    tracing::info!("[cmd:get_storage_stats] events={}, db_size={} bytes, range={}..{}", total_events, db_size_bytes, oldest_event, newest_event);

    Ok(StorageStats {
        total_events,
        db_size_bytes,
        oldest_event,
        newest_event,
    })
}

#[tauri::command]
async fn start_relay(state: State<'_, AppState>) -> Result<(), String> {
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

    let db = state.db.clone();
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();

    let cert_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".nostrito/certs/localhost.pem");
    let key_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".nostrito/certs/localhost-key.pem");

    if cert_path.exists() && key_path.exists() {
        tracing::info!("[relay] Starting TLS relay on wss://127.0.0.1:{}", port);
        tokio::spawn(async move {
            if let Err(e) =
                relay::run_relay_tls(port, cert_path, key_path, db, allowed_pubkey, cancel_clone)
                    .await
            {
                tracing::error!("TLS relay error: {}", e);
            }
        });
    } else {
        tracing::info!("[relay] Starting plain relay on ws://127.0.0.1:{}", port);
        tokio::spawn(async move {
            if let Err(e) = relay::run_relay(port, db, allowed_pubkey, cancel_clone).await {
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
            .store(SyncTier::Idle as u8, Ordering::Relaxed);
    }

    // Stop relay if running
    if let Some(cancel) = state.relay_cancel.write().await.take() {
        cancel.cancel();
    }

    // Clear database
    state
        .db
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

#[tauri::command]
async fn get_activity_data(state: State<'_, AppState>) -> Result<Vec<u64>, String> {
    tracing::debug!("[cmd:get_activity_data] called");
    let counts = state.db.get_hourly_counts(24).map_err(|e| e.to_string())?;
    let total: u64 = counts.iter().sum();
    tracing::debug!("[cmd:get_activity_data] 24h total={}", total);
    Ok(counts)
}

#[tauri::command]
async fn get_relay_status(state: State<'_, AppState>) -> Result<Vec<RelayStatusInfo>, String> {
    tracing::debug!("[cmd:get_relay_status] called");
    let config = state.config.read().await;
    tracing::debug!("[cmd:get_relay_status] returning {} relays", config.outbound_relays.len());
    Ok(config
        .outbound_relays
        .iter()
        .map(|url| {
            let name = url
                .replace("wss://", "")
                .replace("ws://", "")
                .replace("relay.", "")
                .trim_end_matches('/')
                .to_string();
            RelayStatusInfo {
                url: url.clone(),
                name,
                connected: true, // reflects configured status; real connectivity TBD
                latency_ms: None, // TODO: measure actual latency
            }
        })
        .collect())
}

#[tauri::command]
async fn get_kind_counts(state: State<'_, AppState>) -> Result<KindCounts, String> {
    tracing::debug!("[cmd:get_kind_counts] called");
    let counts = state.db.get_kind_counts().map_err(|e| e.to_string())?;
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
    let events = state
        .db
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
        wot_max_depth: config.wot_max_depth,
        sync_interval_secs: config.sync_interval_secs,
        outbound_relays: config.outbound_relays.clone(),
        auto_start: config.auto_start,
    })
}

#[tauri::command]
async fn save_settings(settings: Settings, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:save_settings] called — port={}, relays={:?}, wot_depth={}, sync_interval={}s", settings.relay_port, settings.outbound_relays, settings.wot_max_depth, settings.sync_interval_secs);
    let mut config = state.config.write().await;
    config.relay_port = settings.relay_port;
    config.max_storage_mb = settings.max_storage_mb;
    config.wot_max_depth = settings.wot_max_depth;
    config.sync_interval_secs = settings.sync_interval_secs;
    config.outbound_relays = settings.outbound_relays;
    config.auto_start = settings.auto_start;
    Ok(())
}

#[tauri::command]
async fn get_profiles(
    pubkeys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ProfileInfo>, String> {
    tracing::debug!("[cmd:get_profiles] called for {} pubkeys", pubkeys.len());
    state
        .db
        .get_profiles(&pubkeys)
        .map_err(|e| format!("Failed to get profiles: {}", e))
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

    let profiles = state
        .db
        .get_profiles(&[hex_pubkey])
        .map_err(|e| format!("Failed to get own profile: {}", e))?;

    Ok(profiles.into_iter().next())
}

// ── Browser Integration (mkcert TLS) ───────────────────────────────

/// Core mkcert setup logic — synchronous, reusable by both auto-setup and manual command.
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
async fn setup_browser_integration(app: tauri::AppHandle) -> Result<String, String> {
    let app_clone = app.clone();
    let result = tokio::task::spawn_blocking(move || run_mkcert_setup(&app_clone))
        .await
        .map_err(|e| format!("Task failed: {}", e))??;

    // Signal frontend to restart relay with TLS
    app.emit("relay:restart_required", ()).ok();

    Ok(result)
}

#[tauri::command]
async fn check_browser_integration() -> Result<bool, String> {
    let cert_path = dirs::home_dir()
        .ok_or("no home")?
        .join(".nostrito/certs/localhost.pem");
    Ok(cert_path.exists())
}

// ── App Entry ──────────────────────────────────────────────────────

pub fn run() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_target(true)
        .init();

    tracing::info!("[init] Starting nostrito");

    // Determine DB path
    let db_path = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nostrito")
        .join("nostrito.db");

    // Create parent directory
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("Failed to create data directory");
    }

    tracing::info!("[init] db_path={}", db_path.display());

    // Initialize database
    let db = Arc::new(Database::open(&db_path).expect("Failed to open database"));
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
        let relays: Vec<String> = relays_csv.split(',').map(|s| s.to_string()).collect();
        if !relays.is_empty() {
            tracing::info!("[init] Loaded {} relays from DB: {:?}", relays.len(), relays);
            config.outbound_relays = relays;
        }
    }
    tracing::info!("[init] Config: npub={:?}, relays={:?}, port={}", config.npub, config.outbound_relays, config.relay_port);

    let app_state = AppState {
        wot_graph,
        db,
        config: Arc::new(RwLock::new(config)),
        db_path,
        sync_cancel: Arc::new(RwLock::new(None)),
        sync_tier: Arc::new(AtomicU8::new(0)),
        sync_stats: Arc::new(RwLock::new(SyncStats::default())),
        relay_cancel: Arc::new(RwLock::new(None)),
        start_time: std::time::Instant::now(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .setup(|app| {
            let state = app.state::<AppState>();
            let config = state.config.clone();
            let wot_graph = state.wot_graph.clone();
            let db = state.db.clone();
            let sync_tier = state.sync_tier.clone();
            let sync_stats = state.sync_stats.clone();
            let sync_cancel = state.sync_cancel.clone();
            let app_handle = app.handle().clone();

            // Auto-resume sync and relay if previously configured
            let relay_cancel_setup = state.relay_cancel.clone();
            let db_relay = state.db.clone();

            tauri::async_runtime::spawn(async move {
                let cfg = config.read().await;
                if let Some(ref hex_pubkey) = cfg.hex_pubkey {
                    let relays = cfg.outbound_relays.clone();
                    let hex: String = hex_pubkey.clone();
                    let port = cfg.relay_port;
                    let allowed = cfg.hex_pubkey.clone();
                    drop(cfg);

                    tracing::info!("Auto-resuming sync for {}...", &hex[..8]);

                    let sync_engine = Arc::new(SyncEngine::new(
                        wot_graph,
                        db,
                        relays,
                        hex,
                        sync_tier,
                        sync_stats,
                        app_handle.clone(),
                    ));

                    let cancel = sync_engine.start();
                    *sync_cancel.write().await = Some(cancel);

                    // Auto-setup mkcert if certs don't exist
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

                    // Auto-start relay (TLS if certs available)
                    let relay_ct = CancellationToken::new();
                    let relay_ct_clone = relay_ct.clone();

                    let cert_path = dirs::home_dir()
                        .unwrap_or_default()
                        .join(".nostrito/certs/localhost.pem");
                    let key_path = dirs::home_dir()
                        .unwrap_or_default()
                        .join(".nostrito/certs/localhost-key.pem");

                    if cert_path.exists() && key_path.exists() {
                        tracing::info!("[relay] Auto-starting TLS relay on wss://127.0.0.1:{}", port);
                        tokio::spawn(async move {
                            if let Err(e) = relay::run_relay_tls(
                                port, cert_path, key_path, db_relay, allowed, relay_ct_clone,
                            )
                            .await
                            {
                                tracing::error!("TLS relay auto-start error: {}", e);
                            }
                        });
                    } else {
                        tracing::info!("[relay] Auto-starting plain relay on ws://127.0.0.1:{}", port);
                        tokio::spawn(async move {
                            if let Err(e) =
                                relay::run_relay(port, db_relay, allowed, relay_ct_clone).await
                            {
                                tracing::error!("Relay auto-start error: {}", e);
                            }
                        });
                    }
                    *relay_cancel_setup.write().await = Some(relay_ct);

                    tracing::info!("Sync and relay auto-resumed successfully");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            init_nostrito,
            get_wot,
            get_wot_distance,
            get_feed,
            get_storage_stats,
            get_settings,
            save_settings,
            start_sync,
            stop_sync,
            start_relay,
            stop_relay,
            get_uptime,
            reset_app_data,
            get_activity_data,
            get_relay_status,
            get_kind_counts,
            get_dm_events,
            get_profiles,
            get_own_profile,
            setup_browser_integration,
            check_browser_integration,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nostrito");
}
