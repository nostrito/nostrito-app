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
  relayRunning: boolean;
  relayPort: number;
  eventsStored: number;
  wotSize: number;
  syncStatus: "idle" | "syncing" | "error";
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
  relayPort: number;
  maxStorageMb: number;
  wotMaxDepth: number;
  syncIntervalSecs: number;
  outboundRelays: string[];
  autoStart: boolean;
}

export type Screen = "wizard" | "dashboard" | "feed" | "wot" | "storage" | "settings";
