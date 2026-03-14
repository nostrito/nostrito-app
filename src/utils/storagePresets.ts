// ── Storage Estimation Constants ─────────────────────────────────
// Conservative estimates derived from real Nostr event sizes.

const AVG_EVENT_BYTES: Record<string, number> = {
  textNote: 500, // kind:1 — JSON envelope + sig + tags
  reaction: 200, // kind:7 — minimal content
  metadata: 1000, // kind:0 — name, picture, about, etc.
  contactList: 50, // kind:3 — ~50 bytes per follow entry
  repost: 300, // kind:6
  article: 5000, // kind:30023 — long-form content
};

const AVG_MEDIA_BYTES: Record<string, number> = {
  image: 500_000, // ~500 KB JPEG
  video: 5_000_000, // ~5 MB short clip
  audio: 2_000_000, // ~2 MB
};

/** Average events posted per active user per day (notes + reactions + reposts). */
const EVENTS_PER_USER_PER_DAY = 3;

/** Fraction of events that include media. */
const MEDIA_FRACTION = 0.15;

/** SQLite storage overhead (indices, WAL, page alignment). */
const SQLITE_OVERHEAD = 1.15;

/**
 * WoT notes fetched per sync cycle (default 50, 5-min cycle = ~14,400/day max).
 * In practice only a small random sample of the WoT universe is fetched.
 */
const WOT_NOTES_PER_CYCLE = 50;
const CYCLES_PER_DAY = 288; // 5-min cycles

// ── Types ────────────────────────────────────────────────────────

export interface MediaTypes {
  images: boolean;
  videos: boolean;
  audio: boolean;
}

export interface RetentionOverride {
  minEvents: number;
  windowDays: number;
}

export interface StoragePreset {
  label: string;
  description: string;
  estimatedGb: { low: number; typical: number };
  othersEventsGb: number;
  trackedMediaGb: number;
  wotMediaGb: number;
  wotRetentionDays: number;
  maxEventAgeDays: number;
  mediaTypes: MediaTypes;
  retentionOverrides: {
    follows: RetentionOverride;
    fof: RetentionOverride;
    hop3: RetentionOverride;
    others: RetentionOverride;
  };
}

export interface StorageEstimate {
  totalGb: number;
  eventsGb: number;
  mediaGb: number;
  eventsPerDay: number;
  growthGbPerMonth: number;
}

// ── Presets ──────────────────────────────────────────────────────

export const STORAGE_PRESETS: Record<string, StoragePreset> = {
  minimal: {
    label: "Minimal",
    description: "Your data + close follows only. Low disk usage.",
    estimatedGb: { low: 1, typical: 2 },
    othersEventsGb: 1,
    trackedMediaGb: 1,
    wotMediaGb: 0,
    wotRetentionDays: 7,
    maxEventAgeDays: 7,
    mediaTypes: { images: true, videos: false, audio: false },
    retentionOverrides: {
      follows: { minEvents: 20, windowDays: 7 },
      fof: { minEvents: 5, windowDays: 3 },
      hop3: { minEvents: 2, windowDays: 1 },
      others: { minEvents: 3, windowDays: 1 },
    },
  },
  balanced: {
    label: "Balanced",
    description: "30 days of WoT data + media. Good for most users.",
    estimatedGb: { low: 5, typical: 10 },
    othersEventsGb: 5,
    trackedMediaGb: 3,
    wotMediaGb: 2,
    wotRetentionDays: 30,
    maxEventAgeDays: 30,
    mediaTypes: { images: true, videos: true, audio: true },
    retentionOverrides: {
      follows: { minEvents: 50, windowDays: 30 },
      fof: { minEvents: 10, windowDays: 7 },
      hop3: { minEvents: 3, windowDays: 2 },
      others: { minEvents: 5, windowDays: 3 },
    },
  },
  archive: {
    label: "Archive",
    description: "Long retention, full media. For power users.",
    estimatedGb: { low: 20, typical: 50 },
    othersEventsGb: 20,
    trackedMediaGb: 10,
    wotMediaGb: 10,
    wotRetentionDays: 365,
    maxEventAgeDays: 365,
    mediaTypes: { images: true, videos: true, audio: true },
    retentionOverrides: {
      follows: { minEvents: 200, windowDays: 365 },
      fof: { minEvents: 50, windowDays: 90 },
      hop3: { minEvents: 10, windowDays: 30 },
      others: { minEvents: 10, windowDays: 14 },
    },
  },
};

export const STORAGE_PRESET_KEYS = Object.keys(STORAGE_PRESETS) as Array<
  keyof typeof STORAGE_PRESETS
>;

// ── Estimation Function ─────────────────────────────────────────

/**
 * Estimate total storage usage for a given preset and follow count.
 *
 * The sync engine fetches:
 * - Direct follows: all their events within the retention window
 * - WoT peers: a small random sample each cycle (default ~50 notes/cycle)
 * - Others: incidental events from thread context, searches, etc.
 *
 * This estimates what the app actually stores, not the theoretical universe.
 */
export function estimateStorage(
  followsCount: number,
  presetKey: string,
): StorageEstimate {
  const preset = STORAGE_PRESETS[presetKey];
  if (!preset) {
    return { totalGb: 0, eventsGb: 0, mediaGb: 0, eventsPerDay: 0, growthGbPerMonth: 0 };
  }

  const { retentionOverrides } = preset;

  // Weighted average event size
  const avgEventBytes =
    AVG_EVENT_BYTES.textNote * 0.5 +
    AVG_EVENT_BYTES.reaction * 0.3 +
    AVG_EVENT_BYTES.repost * 0.1 +
    AVG_EVENT_BYTES.article * 0.02 +
    AVG_EVENT_BYTES.metadata * 0.08;

  // Direct follows: each posts ~3 events/day, we keep all within window
  const followsEventsPerDay = followsCount * EVENTS_PER_USER_PER_DAY;
  const followsRetainedEvents = followsEventsPerDay * retentionOverrides.follows.windowDays;
  const followsBytes = followsRetainedEvents * avgEventBytes * SQLITE_OVERHEAD;

  // WoT peers: the sync engine fetches a budget of ~50 notes per cycle
  // Not all cycles produce unique events, so assume ~60% hit rate
  const wotEventsPerDay = Math.min(WOT_NOTES_PER_CYCLE * CYCLES_PER_DAY * 0.6, 5000);
  // But pruning caps per-user retention, so actual stored is limited
  const wotRetainedEvents = wotEventsPerDay * Math.min(retentionOverrides.fof.windowDays, 7);
  const wotBytes = wotRetainedEvents * avgEventBytes * SQLITE_OVERHEAD;

  // Others: incidental events (thread context, searches) — small
  const othersEventsPerDay = 50; // rough estimate
  const othersRetainedEvents = othersEventsPerDay * retentionOverrides.others.windowDays;
  const othersBytes = othersRetainedEvents * avgEventBytes * SQLITE_OVERHEAD;

  const totalEventBytes = followsBytes + wotBytes + othersBytes;
  const eventsGb = totalEventBytes / (1024 * 1024 * 1024);

  // Media: capped by preset GB limits
  const mediaGb = preset.wotMediaGb + preset.trackedMediaGb;

  const totalGb = eventsGb + mediaGb;

  // Daily growth (what the sync engine actually pulls in per day)
  const eventsPerDay = followsEventsPerDay + wotEventsPerDay + othersEventsPerDay;
  const dailyEventBytes = eventsPerDay * avgEventBytes * SQLITE_OVERHEAD;
  // Media grows until it hits the cap, then LRU eviction kicks in
  const dailyMediaBytes = followsCount * EVENTS_PER_USER_PER_DAY * MEDIA_FRACTION *
    ((preset.mediaTypes.images ? AVG_MEDIA_BYTES.image * 0.7 : 0) +
     (preset.mediaTypes.videos ? AVG_MEDIA_BYTES.video * 0.2 : 0) +
     (preset.mediaTypes.audio ? AVG_MEDIA_BYTES.audio * 0.1 : 0));
  const growthGbPerMonth = ((dailyEventBytes + dailyMediaBytes) * 30) / (1024 * 1024 * 1024);

  return {
    totalGb: Math.round(totalGb * 100) / 100,
    eventsGb: Math.round(eventsGb * 100) / 100,
    mediaGb: Math.round(mediaGb * 100) / 100,
    eventsPerDay: Math.round(eventsPerDay),
    growthGbPerMonth: Math.round(growthGbPerMonth * 100) / 100,
  };
}

/**
 * Format bytes to a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
