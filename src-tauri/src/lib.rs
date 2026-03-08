mod relay;
mod storage;
mod sync;
mod wot;

use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct AppStatus {
    pub initialized: bool,
    pub npub: Option<String>,
    pub relay_running: bool,
    pub relay_port: u16,
    pub events_stored: u64,
    pub wot_size: u64,
    pub sync_status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WotStatus {
    pub root_pubkey: String,
    pub total_trusted: u64,
    pub max_depth: u32,
    pub last_updated: u64,
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

// ── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
async fn get_status() -> Result<AppStatus, String> {
    Ok(AppStatus {
        initialized: false,
        npub: None,
        relay_running: false,
        relay_port: 4869,
        events_stored: 0,
        wot_size: 0,
        sync_status: "idle".into(),
    })
}

#[tauri::command]
async fn init_nostrito(npub: String) -> Result<(), String> {
    tracing::info!("Initializing nostrito with npub: {}", npub);
    // TODO: Validate npub, initialize DB, start relay, begin WoT crawl
    Ok(())
}

#[tauri::command]
async fn get_wot() -> Result<WotStatus, String> {
    Ok(WotStatus {
        root_pubkey: String::new(),
        total_trusted: 0,
        max_depth: 2,
        last_updated: 0,
    })
}

#[tauri::command]
async fn get_feed(filter: FeedFilter) -> Result<Vec<NostrEvent>, String> {
    let _ = filter;
    // TODO: Query storage with filter
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
async fn get_settings() -> Result<Settings, String> {
    Ok(Settings {
        npub: String::new(),
        relay_port: 4869,
        max_storage_mb: 500,
        wot_max_depth: 2,
        sync_interval_secs: 300,
        outbound_relays: vec![
            "wss://relay.damus.io".into(),
            "wss://nos.lol".into(),
        ],
        auto_start: true,
    })
}

#[tauri::command]
async fn save_settings(settings: Settings) -> Result<(), String> {
    tracing::info!("Saving settings: {:?}", settings);
    // TODO: Persist settings to DB/file
    Ok(())
}

// ── App Entry ──────────────────────────────────────────────────────

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            init_nostrito,
            get_wot,
            get_feed,
            get_storage_stats,
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nostrito");
}
