/** Core Nostr types for nostrito */

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  /** NIP-01 tag filters: #e, #p, etc. */
  [key: `#${string}`]: string[] | undefined;
}

export interface RelayInfo {
  url: string;
  status: "connected" | "connecting" | "disconnected" | "error";
  eventsStored?: number;
}

export interface WotEntry {
  pubkey: string;
  trustDistance: number;
  displayName?: string;
  nip05?: string;
}

export interface WotStatus {
  rootPubkey: string;
  totalTrusted: number;
  maxDepth: number;
  lastUpdated: number;
  entries: WotEntry[];
}

export interface AppStatus {
  initialized: boolean;
  npub: string | null;
  relay_running: boolean;
  relay_port: number;
  events_stored: number;
  wot_nodes: number;
  wot_edges: number;
  sync_status: string;
  sync_tier: number;
  sync_stats: SyncStats;
  media_stored: number;
  offline_mode: boolean;
  relayRunning?: boolean;
  relayPort?: number;
  eventsStored?: number;
  wotSize?: number;
  syncStatus?: "idle" | "syncing" | "error";
}

export interface SyncStats {
  tier1_fetched: number;
  tracked_fetched: number;
  tier2_fetched: number;
  tier3_fetched: number;
  tier4_fetched: number;
  current_tier: number;
  current_layer: string;
  pass_pubkeys_done: number;
  pass_pubkeys_total: number;
}

export interface SyncProgress {
  tier: number;
  fetched: number;
  total: number;
  relay: string;
}

export interface StoredEventNotification {
  kind: number;
  pubkey: string;
  content: string;
}

export interface RelayStatusInfo {
  url: string;
  name: string;
  connected: boolean;
  latency_ms: number | null;
}

export interface FeedFilter {
  kinds?: number[];
  limit?: number;
  since?: number;
  wotOnly?: boolean;
}

export interface StorageStats {
  totalEvents: number;
  dbSizeBytes: number;
  eventsByKind: Record<number, number>;
  oldestEvent: number;
  newestEvent: number;
}

export interface Settings {
  npub: string;
  relay_port: number;
  max_storage_mb: number;
  storage_others_gb: number;
  storage_media_gb: number;
  storage_own_media_gb: number;
  storage_tracked_media_gb: number;
  storage_wot_media_gb: number;
  wot_event_retention_days: number;
  wot_max_depth: number;
  sync_interval_secs: number;
  outbound_relays: string[];
  auto_start: boolean;
  sync_lookback_days: number;
  sync_batch_size: number;
  sync_events_per_batch: number;
  sync_batch_pause_secs: number;
  sync_relay_min_interval_secs: number;
  sync_wot_batch_size: number;
  sync_wot_events_per_batch: number;
  max_event_age_days: number;
  sync_fof_content: boolean;
  relayPort?: number;
  maxStorageMb?: number;
  syncIntervalSecs?: number;
  autoStart?: boolean;
}

export interface MediaItem {
  hash: string;
  url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  downloaded_at: number;
}

export interface Conversation {
  partnerPubkey: string;
  messages: NostrEvent[];
  lastTimestamp: number;
}

export type Screen = "wizard" | "dashboard" | "feed" | "dms" | "wot" | "storage" | "settings" | "my-media";
