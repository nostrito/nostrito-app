mod relay;
mod search;
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
use sync::{resolve_relay_url as resolve_relay_alias, SyncConfig, SyncEngine, SyncStats};
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
    // Per-category storage limits
    pub storage_own_media_gb: f64,
    pub storage_tracked_media_gb: f64,
    pub storage_wot_media_gb: f64,
    pub wot_event_retention_days: u32,
    // Sync tuning
    pub sync_lookback_days: u32,
    pub sync_batch_size: u32,
    pub sync_events_per_batch: u32,
    pub sync_batch_pause_secs: u32,
    pub sync_relay_min_interval_secs: u32,
    pub sync_wot_batch_size: u32,
    pub sync_wot_events_per_batch: u32,
    pub max_event_age_days: u32,
    /// Cached nsec (loaded from system keychain on startup)
    pub nsec: Option<String>,
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
            ],
            auto_start: true,
            storage_others_gb: 5.0,
            storage_media_gb: 2.0,
            storage_own_media_gb: 5.0,
            storage_tracked_media_gb: 3.0,
            storage_wot_media_gb: 2.0,
            wot_event_retention_days: 30,
            sync_lookback_days: 30,
            sync_batch_size: 50,
            sync_events_per_batch: 50,
            sync_batch_pause_secs: 7,
            sync_relay_min_interval_secs: 3,
            sync_wot_batch_size: 5,
            sync_wot_events_per_batch: 15,
            max_event_age_days: 30,
            nsec: None,
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

/// Start the sync engine. Returns a CancellationToken for stopping.
fn start_sync_engine(
    wot_graph: Arc<WotGraph>,
    db: Arc<Database>,
    relays: Vec<String>,
    hex_pubkey: String,
    sync_tier: Arc<AtomicU8>,
    sync_stats: Arc<RwLock<SyncStats>>,
    app_handle: tauri::AppHandle,
    media_gb: f64,
    sync_config: SyncConfig,
    max_event_age_days: u32,
) -> CancellationToken {
    let engine = Arc::new(SyncEngine::new(
        wot_graph, db, relays, hex_pubkey, sync_tier, sync_stats,
        app_handle, media_gb, sync_config, max_event_age_days,
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
            match current_tier {
                1 => "syncing (phase 1: own data)".into(),
                2 => "syncing (phase 2: discovery)".into(),
                3 => "syncing (phase 3: content)".into(),
                4 => "syncing (phase 4: media)".into(),
                _ => "idle".into(),
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
    if !resolved_relays.is_empty() {
        state
            .db
            .set_config("outbound_relays", &resolved_relays.join(","))
            .map_err(|e| format!("Failed to save relays: {}", e))?;
    }

    // Load existing graph from DB
    state
        .db
        .load_graph(&state.wot_graph)
        .map_err(|e| format!("Failed to load graph: {}", e))?;

    // Start tiered sync engine
    let config = state.config.read().await;
    let sync_config = SyncConfig {
        lookback_days: config.sync_lookback_days,
        batch_size: config.sync_batch_size,
        events_per_batch: config.sync_events_per_batch,
        batch_pause_secs: config.sync_batch_pause_secs,
        relay_min_interval_secs: config.sync_relay_min_interval_secs,
        wot_batch_size: config.sync_wot_batch_size,
        wot_events_per_batch: config.sync_wot_events_per_batch,
        cycle_interval_secs: config.sync_interval_secs,
    };
    let cancel = start_sync_engine(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
        hex_pubkey.clone(),
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle.clone(),
        config.storage_media_gb,
        sync_config,
        config.max_event_age_days,
    );
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
    let profiles = state.db.get_profiles(&pubkeys).map_err(|e| e.to_string())?;
    let map: std::collections::HashMap<String, _> = profiles.into_iter().map(|p| (p.pubkey.clone(), p)).collect();
    let result = pubkeys.iter().map(|pk| {
        if let Some(p) = map.get(pk) {
            serde_json::json!({
                "pubkey": pk,
                "name": p.name,
                "display_name": p.display_name,
                "picture": p.picture,
            })
        } else {
            serde_json::json!({ "pubkey": pk, "name": null, "display_name": null, "picture": null })
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
    };
    let cancel = start_sync_engine(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
        hex_pubkey,
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle,
        config.storage_media_gb,
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
    };

    let cancel = start_sync_engine(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
        hex_pubkey,
        state.sync_tier.clone(),
        state.sync_stats.clone(),
        app_handle.clone(),
        config.storage_media_gb,
        sync_config,
        config.max_event_age_days,
    );
    drop(config);

    *state.sync_cancel.write().await = Some(cancel);

    tracing::info!("[cmd:restart_sync] Sync restarted with new config");
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
    state.db.delete_config("tier2_history_until_articles")
        .map_err(|e| format!("Failed to reset articles cursor: {}", e))?;

    // Also reset the main history cursor so notes/reposts re-backfill too
    state.db.delete_config("tier2_history_until")
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

    let author_vec = filter.author.map(|a| vec![a]);
    let authors = author_vec.as_deref();

    let events = state
        .db
        .query_events(None, authors, kinds, filter.since, None, limit)
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

    let events = state
        .db
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
async fn get_ownership_storage_stats(state: State<'_, AppState>) -> Result<OwnershipStorageStats, String> {
    tracing::debug!("[cmd:get_ownership_storage_stats] called");
    let config = state.config.read().await;
    let own_pubkey = config.hex_pubkey.clone().unwrap_or_default();
    drop(config);

    if own_pubkey.is_empty() {
        return Err("Not initialized — no pubkey set".into());
    }

    let db = &state.db;
    let own_events_count = db.own_event_count(&own_pubkey).map_err(|e| e.to_string())?;
    let own_media_bytes = db.own_media_bytes(&own_pubkey).map_err(|e| e.to_string())?;
    let tracked_events_count = db.tracked_event_count(&own_pubkey).map_err(|e| e.to_string())?;
    let tracked_media_bytes = db.tracked_media_bytes(&own_pubkey).map_err(|e| e.to_string())?;
    let wot_events_count = db.wot_event_count(&own_pubkey).map_err(|e| e.to_string())?;
    let wot_media_bytes = db.wot_media_bytes(&own_pubkey).map_err(|e| e.to_string())?;
    let total_events = db.event_count().map_err(|e| e.to_string())?;
    let db_size_bytes = db.db_size_bytes().map_err(|e| e.to_string())?;

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
            .store(0u8, Ordering::Relaxed);
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

/// Change account: clears only identity (npub/hex_pubkey) and sync cursors,
/// keeps all event data, WoT graph edges, settings, and media intact.
/// When the user re-enters an npub that already has events in the DB,
/// the existing data is reused (fast account switching).
#[tauri::command]
async fn change_account(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!("Changing account — clearing identity, keeping event data");

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

    // Clear nsec from keychain
    {
        let config = state.config.read().await;
        if let Some(ref npub) = config.npub {
            delete_nsec_from_keychain(npub);
        }
    }

    // Clear only identity keys and sync cursors from DB config
    // Keep: outbound_relays, sync tuning params, storage settings, etc.
    let identity_keys = [
        "npub",
        "hex_pubkey",
    ];
    for key in &identity_keys {
        state
            .db
            .delete_config(key)
            .map_err(|e| format!("Failed to delete config key {}: {}", key, e))?;
    }

    // Clear sync_state (per-relay cursors) so new account starts fresh
    state
        .db
        .clear_sync_state()
        .map_err(|e| format!("Failed to clear sync_state: {}", e))?;

    // Clear v2 user cursors for fresh start
    state
        .db
        .clear_user_cursors()
        .map_err(|e| format!("Failed to clear user_cursors: {}", e))?;

    // Reset sync stats
    {
        let mut stats = state.sync_stats.write().await;
        *stats = SyncStats::default();
    }

    // Clear identity from in-memory config (keep all other settings)
    {
        let mut config = state.config.write().await;
        config.npub = None;
        config.hex_pubkey = None;
        config.nsec = None;
    }

    // Emit event to frontend to show wizard
    app_handle.emit("app:reset", ()).ok();

    tracing::info!("Account change complete — identity cleared, events preserved");
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
        storage_others_gb: config.storage_others_gb,
        storage_media_gb: config.storage_media_gb,
        storage_own_media_gb: config.storage_own_media_gb,
        storage_tracked_media_gb: config.storage_tracked_media_gb,
        storage_wot_media_gb: config.storage_wot_media_gb,
        wot_event_retention_days: config.wot_event_retention_days,
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
    config.wot_max_depth = settings.wot_max_depth;
    config.sync_interval_secs = settings.sync_interval_secs;
    // Only update relays if the new list has valid entries — never clear to empty
    let valid_relays: Vec<String> = settings.outbound_relays.iter()
        .map(|r| sync::resolve_relay_url(r).to_string())
        .filter(|r| !r.trim().is_empty())
        .collect();
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

    // Persist ALL settings to DB so they survive restart
    drop(config);
    let db = &state.db;

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
    db.set_config("storage_own_media_gb", &settings.storage_own_media_gb.to_string()).ok();
    db.set_config("storage_tracked_media_gb", &settings.storage_tracked_media_gb.to_string()).ok();
    db.set_config("storage_wot_media_gb", &settings.storage_wot_media_gb.to_string()).ok();
    db.set_config("wot_event_retention_days", &settings.wot_event_retention_days.to_string()).ok();

    // ── Restart sync engine with new settings (especially relay changes) ──
    // Without this, relay changes in Settings only take effect on app restart.
    // Cancel existing sync, then start a new engine with the fresh config.
    if let Some(cancel) = state.sync_cancel.write().await.take() {
        cancel.cancel();
        state.sync_tier.store(0u8, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
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
        };
        let cancel = start_sync_engine(
            state.wot_graph.clone(),
            state.db.clone(),
            config.outbound_relays.clone(),
            hex_pubkey.clone(),
            state.sync_tier.clone(),
            state.sync_stats.clone(),
            app_handle.clone(),
            config.storage_media_gb,
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
async fn track_profile(pubkey: String, note: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:track_profile] pubkey={}...", &pubkey[..pubkey.len().min(12)]);
    state.db.track_profile(&pubkey, note.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn untrack_profile(pubkey: String, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("[cmd:untrack_profile] pubkey={}...", &pubkey[..pubkey.len().min(12)]);
    state.db.untrack_profile(&pubkey).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_tracked_profiles(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    tracing::debug!("[cmd:get_tracked_profiles] called");
    let profiles = state.db.get_tracked_profiles().map_err(|e| e.to_string())?;
    Ok(profiles.into_iter().map(|(pubkey, tracked_at, note)| {
        serde_json::json!({
            "pubkey": pubkey,
            "tracked_at": tracked_at,
            "note": note,
        })
    }).collect())
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MediaStats {
    pub total_bytes: u64,
    pub file_count: u64,
    pub limit_bytes: u64,
}

#[tauri::command]
async fn get_media_stats(state: State<'_, AppState>) -> Result<MediaStats, String> {
    let db = &state.db;
    let config = state.config.read().await;
    let total_bytes = db.media_total_bytes().map_err(|e| e.to_string())?;
    let file_count = db.media_file_count().map_err(|e| e.to_string())?;
    let limit_bytes = (config.storage_media_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    Ok(MediaStats {
        total_bytes,
        file_count,
        limit_bytes,
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

    let records = state.db.get_own_media(&own_pubkey).map_err(|e| e.to_string())?;
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

    let records = state.db.get_profile_media(&pubkey).map_err(|e| e.to_string())?;
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfileCacheStatus {
    pub event_count: u64,
    pub has_metadata: bool,
}

#[tauri::command]
async fn get_profile_cache_status(pubkey: String, state: State<'_, AppState>) -> Result<ProfileCacheStatus, String> {
    let event_count = state.db.count_events_for_pubkey(&pubkey).map_err(|e| e.to_string())?;
    let has_metadata = state.db.has_profile_metadata(&pubkey).map_err(|e| e.to_string())?;
    Ok(ProfileCacheStatus { event_count, has_metadata })
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
    do_fetch_profile(&pubkey, &state.db, &state.wot_graph, &state.config).await
}

#[tauri::command]
async fn get_profile_with_refresh(
    pubkey: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ProfileInfo>, String> {
    // 1. Return cached profile immediately
    let profiles = state.db.get_profiles(&[pubkey.clone()]).map_err(|e| e.to_string())?;
    let cached = profiles.into_iter().find(|p| p.pubkey == pubkey);

    // 2. Check if we need a background refresh
    let fetched_at = state.db.get_profile_fetched_at(&pubkey).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();
    let twelve_hours = 12 * 60 * 60;
    let needs_refresh = match fetched_at {
        Some(ts) => (now - ts) > twelve_hours,
        None => true,
    };

    if needs_refresh {
        // 3. Spawn background fetch — don't block the response
        let pk = pubkey.clone();
        let db = state.db.clone();
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
    let cert_path = dirs::home_dir()
        .ok_or("no home")?
        .join(".nostrito/certs/localhost.pem");
    Ok(cert_path.exists())
}

// ── nsec Keychain Helpers ────────────────────────────────────────────

fn save_nsec_to_keychain(npub: &str, nsec: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("nostrito", npub).map_err(|e| format!("Keychain error: {}", e))?;
    entry.set_password(nsec).map_err(|e| format!("Failed to save to keychain: {}", e))
}

fn load_nsec_from_keychain(npub: &str) -> Option<String> {
    let entry = keyring::Entry::new("nostrito", npub).ok()?;
    entry.get_password().ok()
}

fn delete_nsec_from_keychain(npub: &str) {
    if let Ok(entry) = keyring::Entry::new("nostrito", npub) {
        entry.delete_credential().ok();
    }
}

#[tauri::command]
async fn set_nsec(nsec: String, state: State<'_, AppState>) -> Result<(), String> {
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
    }

    tracing::info!("[cmd:set_nsec] nsec saved for {}...", &current_hex[..8]);
    Ok(())
}

#[tauri::command]
async fn clear_nsec(state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.read().await;
    if let Some(ref npub) = config.npub {
        delete_nsec_from_keychain(npub);
    }
    drop(config);

    {
        let mut config = state.config.write().await;
        config.nsec = None;
    }

    tracing::info!("[cmd:clear_nsec] nsec cleared");
    Ok(())
}

#[tauri::command]
async fn get_signing_mode(state: State<'_, AppState>) -> Result<String, String> {
    let config = state.config.read().await;
    Ok(if config.nsec.is_some() { "nsec".to_string() } else { "read-only".to_string() })
}

// ── App Entry ──────────────────────────────────────────────────────

pub fn run() {
    // Set up dual logging: console (INFO+) and rotating file (~/.nostrito/nostrito.log, max ~10MB)
    {
        use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

        let log_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".nostrito");
        std::fs::create_dir_all(&log_dir).ok();

        // Rotating file appender: daily rotation, keep up to 3 files (~10MB effective cap)
        let file_appender = tracing_appender::rolling::daily(&log_dir, "nostrito.log");
        let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);
        // Leak the guard so it lives for the entire process lifetime
        std::mem::forget(_guard);

        let env_filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,nostrito_lib=info"));

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
    }

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
    if let Ok(Some(v)) = db.get_config("storage_own_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_own_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_tracked_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_tracked_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_wot_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_wot_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("wot_event_retention_days") { if let Ok(n) = v.parse::<u32>() { config.wot_event_retention_days = n; } }

    // Load additional settings that are now persisted by save_settings
    if let Ok(Some(v)) = db.get_config("relay_port") { if let Ok(n) = v.parse::<u16>() { config.relay_port = n; } }
    if let Ok(Some(v)) = db.get_config("max_storage_mb") { if let Ok(n) = v.parse::<u32>() { config.max_storage_mb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_others_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_others_gb = n; } }
    if let Ok(Some(v)) = db.get_config("storage_media_gb") { if let Ok(n) = v.parse::<f64>() { config.storage_media_gb = n; } }
    if let Ok(Some(v)) = db.get_config("wot_max_depth") { if let Ok(n) = v.parse::<u32>() { config.wot_max_depth = n; } }
    if let Ok(Some(v)) = db.get_config("sync_interval_secs") { if let Ok(n) = v.parse::<u32>() { config.sync_interval_secs = n; } }
    // Load nsec from system keychain
    if let Some(ref npub) = config.npub {
        if let Some(nsec) = load_nsec_from_keychain(npub) {
            tracing::info!("[init] Loaded nsec from keychain");
            config.nsec = Some(nsec);
        }
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
        let tracked_count = db.get_tracked_pubkeys().map(|t| t.len()).unwrap_or(0);
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
        db,
        config: Arc::new(RwLock::new(config)),
        db_path,
        sync_cancel: Arc::new(RwLock::new(None)),
        sync_tier: Arc::new(AtomicU8::new(0)),
        sync_stats: Arc::new(RwLock::new(SyncStats::default())),
        relay_cancel: Arc::new(RwLock::new(None)),
        start_time: std::time::Instant::now(),
    };

    // Install rustls ring crypto provider before any TLS code runs
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

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

                    let cfg2 = config.read().await;
                    let media_gb = cfg2.storage_media_gb;
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
                        media_gb,
                        sync_config,
                        max_age_days,
                    );
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
            get_follows,
            get_profiles_batch,
            get_wot_distance,
            get_feed,
            search_events,
            get_storage_stats,
            get_ownership_storage_stats,
            get_settings,
            save_settings,
            start_sync,
            stop_sync,
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
            get_own_profile,
            setup_browser_integration,
            check_browser_integration,
            get_media_stats,
            get_own_media,
            get_profile_media,
            restart_sync,
            track_profile,
            untrack_profile,
            get_tracked_profiles,
            fetch_profile,
            get_profile_with_refresh,
            get_profile_cache_status,
            set_nsec,
            clear_nsec,
            get_signing_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nostrito");
}
