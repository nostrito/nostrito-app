#![allow(dead_code)]
use serde::{Deserialize, Serialize};

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

/// Lightweight notification emitted for each newly stored event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredEventNotification {
    pub id: String,
    pub kind: u32,
    pub pubkey: String,
    pub content: String,
    /// Which sync layer produced this event ("0", "0.5", "1", "2", "3", or "")
    pub layer: String,
    /// Media URLs extracted from event content (images, videos, etc.)
    pub media_urls: Vec<String>,
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
    /// Unique pubkeys covered so far in the current content pass.
    pub pass_pubkeys_done: u64,
    /// Total pubkeys in the current content pass.
    pub pass_pubkeys_total: u64,
    /// Relays completed in the current content pass.
    pub pass_relays_done: u64,
    /// Total relays to query in the current content pass.
    pub pass_relays_total: u64,
    /// Number of direct follows (for Layer 1 display).
    pub follows_count: u64,
    /// Human-readable phase name: "Own Data", "Discovery", "Content Fetch",
    /// "Thread Context", "WoT Crawl", or "" (idle).
    pub current_phase: String,
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
    /// How many notes to fetch from WoT peers each cycle (0 = disabled).
    pub wot_notes_per_cycle: u32,
    /// How many days to keep re-fetching threads the user interacted with.
    pub thread_retention_days: u32,
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
            // Budget of WoT (FoF) notes to fetch per cycle. Kept low because
            // the WoT graph can contain tens of thousands of peers; fetching
            // all of them would be slow and bandwidth-heavy. A small sample
            // each cycle gradually builds a picture of the broader network.
            wot_notes_per_cycle: 50,
            thread_retention_days: 30,
        }
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
        "nos.lol" => "wss://nos.lol",
        "snort" => "wss://relay.snort.social",
        "coracle" => "wss://relay.coracle.social",
        "nostr.wine" => "wss://nostr.wine",
        "relay.nostr.band" => "wss://relay.nostr.band",
        "amethyst" => "wss://nostr.band",
        "yakihonne" => "wss://relay.yakihonne.com",
        "nostr.land" => "wss://nostr.land",
        "relay.nostr.bg" => "wss://relay.nostr.bg",
        "relay.noswhere.com" => "wss://relay.noswhere.com",
        "purplepag.es" => "wss://purplepag.es",
        "wot.utxo.one" => "wss://wot.utxo.one",
        _ => alias,
    }
}

// ── Sync Phases ──────────────────────────────────────────────────

/// The four phases of a v2 sync cycle, executed in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum SyncPhase {
    OwnData = 1,
    Discovery = 2,
    ContentFetch = 3,
    ThreadContext = 4,
}

impl SyncPhase {
    pub fn label(&self) -> &'static str {
        match self {
            Self::OwnData => "Own Data",
            Self::Discovery => "Discovery",
            Self::ContentFetch => "Content Fetch",
            Self::ThreadContext => "Thread Context",
        }
    }
}

// ── Retention Tiers ──────────────────────────────────────────────

/// Retention tier based on WoT hop distance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RetentionTier {
    /// Hop 0 — own pubkey. Keep everything forever.
    Own,
    /// Explicitly tracked profiles. Keep everything forever.
    Tracked,
    /// Hop 1 — direct follows.
    Follows,
    /// Hop 2 — follows of follows.
    FollowsOfFollows,
    /// Hop 3 — three hops out.
    Hop3,
    /// Hop 4+ or not in WoT.
    Others,
}

impl RetentionTier {
    /// DB key used in the `retention_config` table.
    pub fn config_key(&self) -> Option<&'static str> {
        match self {
            Self::Follows => Some("follows"),
            Self::FollowsOfFollows => Some("fof"),
            Self::Hop3 => Some("hop3"),
            Self::Others => Some("others"),
            _ => None, // Own and Tracked have no configurable limits
        }
    }

    /// Default minimum events to keep per user.
    pub fn default_min_events(&self) -> Option<u32> {
        match self {
            Self::Follows => Some(50),
            Self::FollowsOfFollows => Some(10),
            Self::Hop3 => Some(3),
            Self::Others => Some(5),
            _ => None,
        }
    }

    /// Default time window in seconds.
    pub fn default_time_window_secs(&self) -> Option<u64> {
        match self {
            Self::Follows => Some(2_592_000),         // 30 days
            Self::FollowsOfFollows => Some(604_800),  // 7 days
            Self::Hop3 => Some(172_800),              // 2 days
            Self::Others => Some(259_200),             // 3 days
            _ => None,
        }
    }
}

// ── Relay Direction & Source ─────────────────────────────────────

/// NIP-65 relay direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelayDirection {
    Read,
    Write,
    Both,
}

impl RelayDirection {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Both => "both",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "read" => Self::Read,
            "write" => Self::Write,
            _ => Self::Both,
        }
    }
}

/// How we discovered a user's relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RelaySource {
    /// Lowest priority
    Kind3Hint = 0,
    Nip05 = 1,
    /// Highest priority
    Nip65 = 2,
}

impl RelaySource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Kind3Hint => "kind3_hint",
            Self::Nip05 => "nip05",
            Self::Nip65 => "nip65",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "kind3_hint" => Some(Self::Kind3Hint),
            "nip05" => Some(Self::Nip05),
            "nip65" => Some(Self::Nip65),
            _ => None,
        }
    }
}

// ── Event Source ─────────────────────────────────────────────────

/// How an event arrived in our local store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventSource {
    Sync,
    /// Phase 1 own-data backup. Kind:5 deletions are stored but not executed.
    OwnBackup,
    ThreadContext,
    Search,
}

impl EventSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::OwnBackup => "own_backup",
            Self::ThreadContext => "thread_context",
            Self::Search => "search",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "own_backup" => Self::OwnBackup,
            "thread_context" => Self::ThreadContext,
            "search" => Self::Search,
            _ => Self::Sync,
        }
    }
}

// ── Cursor Bands ─────────────────────────────────────────────────

/// Groups users by recency of their last event for batched fetching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CursorBand {
    /// Last event < 1 hour ago
    Hot,
    /// Last event 1h–24h ago
    Warm,
    /// Last event > 24h ago or no cursor
    Cold,
}

impl CursorBand {
    /// Classify a user based on the age of their last event.
    /// `age_secs` is `now - last_event_ts`.
    pub fn from_age(age_secs: Option<u64>) -> Self {
        match age_secs {
            Some(s) if s < 3_600 => Self::Hot,
            Some(s) if s < 86_400 => Self::Warm,
            _ => Self::Cold,
        }
    }
}

// ── Relay Routing ────────────────────────────────────────────────

/// A relay and the set of pubkeys we should query it for.
#[derive(Debug, Clone)]
pub struct RelayRoute {
    pub relay_url: String,
    pub pubkeys: Vec<String>,
    pub reliability_score: f64,
}

/// A complete routing plan: which relays to query for which pubkeys.
#[derive(Debug, Clone, Default)]
pub struct RoutingPlan {
    pub routes: Vec<RelayRoute>,
}

// ── Constants ────────────────────────────────────────────────────

/// Relay polite interval between requests (seconds).
pub const RELAY_MIN_INTERVAL_SECS: u64 = 3;
/// Pause between relay subscription batches (seconds).
pub const BATCH_PAUSE_SECS: u64 = 2;
/// Disconnect idle NIP-65 relays after this (seconds).
pub const IDLE_DISCONNECT_SECS: u64 = 300;
/// Safety overlap when using cursors (seconds).
pub const CURSOR_OVERLAP_SECS: u64 = 60;
/// Run WoT crawl every N sync cycles.
pub const WOT_CRAWL_FREQUENCY: u32 = 6;
/// Stop backfilling a relay after this many empty cycles.
pub const HISTORY_EXHAUSTION_CYCLES: u32 = 3;
/// Max missing thread roots to fetch per cycle.
pub const THREAD_CONTEXT_LIMIT: u32 = 500;
/// Max simultaneous WebSocket connections.
pub const MAX_CONNECTIONS: usize = 25;
/// Rate-limit NOTICE pause (seconds).
pub const RATE_LIMIT_PAUSE_SECS: u64 = 90;
/// Generic NOTICE pause (seconds).
pub const GENERIC_NOTICE_PAUSE_SECS: u64 = 5;
/// Connection backoff sequence (seconds).
pub const BACKOFF_SEQUENCE: &[u64] = &[10, 30, 60, 120, 300];

/// Hardcoded default relays.
pub const DEFAULT_RELAYS: &[&str] = &[
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://relay.nostr.band",
    "wss://nostr.wine",
];

/// Discovery relay for NIP-65 lookups.
pub const DISCOVERY_RELAY: &str = "wss://purplepag.es";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_phase_labels() {
        assert_eq!(SyncPhase::OwnData.label(), "Own Data");
        assert_eq!(SyncPhase::ThreadContext.label(), "Thread Context");
    }

    #[test]
    fn test_retention_tier_defaults() {
        assert_eq!(RetentionTier::Follows.default_min_events(), Some(50));
        assert_eq!(RetentionTier::FollowsOfFollows.default_time_window_secs(), Some(604_800));
        assert_eq!(RetentionTier::Hop3.default_min_events(), Some(3));
        assert_eq!(RetentionTier::Hop3.default_time_window_secs(), Some(172_800));
        assert_eq!(RetentionTier::Hop3.config_key(), Some("hop3"));
        assert_eq!(RetentionTier::Own.config_key(), None);
        assert_eq!(RetentionTier::Others.config_key(), Some("others"));
    }

    #[test]
    fn test_relay_source_priority() {
        assert!(RelaySource::Nip65 > RelaySource::Nip05);
        assert!(RelaySource::Nip05 > RelaySource::Kind3Hint);
    }

    #[test]
    fn test_relay_direction_roundtrip() {
        for dir in [RelayDirection::Read, RelayDirection::Write, RelayDirection::Both] {
            assert_eq!(RelayDirection::from_str(dir.as_str()), dir);
        }
    }

    #[test]
    fn test_event_source_roundtrip() {
        for src in [EventSource::Sync, EventSource::OwnBackup, EventSource::ThreadContext, EventSource::Search] {
            assert_eq!(EventSource::from_str(src.as_str()), src);
        }
    }

    #[test]
    fn test_cursor_band_classification() {
        assert_eq!(CursorBand::from_age(Some(60)), CursorBand::Hot);
        assert_eq!(CursorBand::from_age(Some(3_599)), CursorBand::Hot);
        assert_eq!(CursorBand::from_age(Some(3_600)), CursorBand::Warm);
        assert_eq!(CursorBand::from_age(Some(43_200)), CursorBand::Warm);
        assert_eq!(CursorBand::from_age(Some(86_400)), CursorBand::Cold);
        assert_eq!(CursorBand::from_age(None), CursorBand::Cold);
    }

    #[test]
    fn test_relay_route_construction() {
        let route = RelayRoute {
            relay_url: "wss://relay.damus.io".into(),
            pubkeys: vec!["abc123".into()],
            reliability_score: 0.95,
        };
        assert_eq!(route.pubkeys.len(), 1);
        assert!(route.reliability_score > 0.9);
    }
}
