mod relay;
mod storage;
mod sync;
mod wot;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use storage::Database;
use sync::SyncEngine;
use wot::WotGraph;

// ── App State ──────────────────────────────────────────────────────

pub struct AppState {
    pub wot_graph: Arc<WotGraph>,
    pub db: Arc<Database>,
    pub config: Arc<RwLock<AppConfig>>,
    pub db_path: PathBuf,
    pub sync_cancel: Arc<RwLock<Option<CancellationToken>>>,
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
    let config = state.config.read().await;
    let stats = state.wot_graph.stats();
    let sync_running = state.sync_cancel.read().await.is_some();

    Ok(AppStatus {
        initialized: config.npub.is_some(),
        npub: config.npub.clone(),
        relay_running: false, // relay server still stubbed
        relay_port: config.relay_port,
        events_stored: 0, // TODO: query nostr_events table
        wot_nodes: stats.node_count,
        wot_edges: stats.edge_count,
        sync_status: if sync_running {
            "running".into()
        } else {
            "idle".into()
        },
    })
}

#[tauri::command]
async fn init_nostrito(npub: String, state: State<'_, AppState>) -> Result<(), String> {
    tracing::info!("Initializing nostrito with npub: {}", npub);

    // Parse npub to hex pubkey
    let hex_pubkey = if npub.starts_with("npub1") {
        // Decode bech32 npub
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

    // Load existing graph from DB
    state
        .db
        .load_graph(&state.wot_graph)
        .map_err(|e| format!("Failed to load graph: {}", e))?;

    // Start sync engine
    let config = state.config.read().await;
    let sync_engine = Arc::new(SyncEngine::new(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
    ));

    let cancel = sync_engine.start();
    *state.sync_cancel.write().await = Some(cancel);

    tracing::info!("Nostrito initialized for {}", &hex_pubkey[..8]);
    Ok(())
}

#[tauri::command]
async fn get_wot(state: State<'_, AppState>) -> Result<WotStatus, String> {
    let config = state.config.read().await;
    let stats = state.wot_graph.stats();

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
async fn start_sync(state: State<'_, AppState>) -> Result<(), String> {
    let existing = state.sync_cancel.read().await;
    if existing.is_some() {
        return Err("Sync already running".into());
    }
    drop(existing);

    let config = state.config.read().await;
    let sync_engine = Arc::new(SyncEngine::new(
        state.wot_graph.clone(),
        state.db.clone(),
        config.outbound_relays.clone(),
    ));

    let cancel = sync_engine.start();
    *state.sync_cancel.write().await = Some(cancel);

    Ok(())
}

#[tauri::command]
async fn stop_sync(state: State<'_, AppState>) -> Result<(), String> {
    let cancel = state.sync_cancel.write().await.take();
    if let Some(cancel) = cancel {
        cancel.cancel();
        tracing::info!("Sync engine stopped");
    }
    Ok(())
}

#[tauri::command]
async fn get_feed(filter: FeedFilter) -> Result<Vec<NostrEvent>, String> {
    let _ = filter;
    // TODO: Query nostr_events table with filter
    Ok(vec![])
}

#[tauri::command]
async fn get_storage_stats() -> Result<StorageStats, String> {
    Ok(StorageStats {
        total_events: 0,
        db_size_bytes: 0,
        oldest_event: 0,
        newest_event: 0,
    })
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let config = state.config.read().await;
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
    tracing::info!("Saving settings");
    let mut config = state.config.write().await;
    config.relay_port = settings.relay_port;
    config.max_storage_mb = settings.max_storage_mb;
    config.wot_max_depth = settings.wot_max_depth;
    config.sync_interval_secs = settings.sync_interval_secs;
    config.outbound_relays = settings.outbound_relays;
    config.auto_start = settings.auto_start;
    Ok(())
}

// ── App Entry ──────────────────────────────────────────────────────

pub fn run() {
    tracing_subscriber::fmt::init();

    // Determine DB path
    let db_path = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nostrito")
        .join("nostrito.db");

    // Create parent directory
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("Failed to create data directory");
    }

    // Initialize database
    let db = Arc::new(
        Database::open(&db_path).expect("Failed to open database"),
    );

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
        config.npub = Some(npub);
    }
    if let Ok(Some(hex)) = db.get_config("hex_pubkey") {
        config.hex_pubkey = Some(hex);
    }

    let app_state = AppState {
        wot_graph,
        db,
        config: Arc::new(RwLock::new(config)),
        db_path,
        sync_cancel: Arc::new(RwLock::new(None)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running nostrito");
}
