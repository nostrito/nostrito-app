import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge } from "../components/Badge";
import { formatBytes } from "../utils/format";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OwnershipStorageStats {
  own_events_count: number;
  own_media_bytes: number;
  tracked_events_count: number;
  tracked_media_bytes: number;
  wot_events_count: number;
  wot_media_bytes: number;
  total_events: number;
  db_size_bytes: number;
}

interface StorageStats {
  total_events: number;
  db_size_bytes: number;
  oldest_event: number;
  newest_event: number;
}

interface KindCountsResult {
  counts: Record<string, number>;
}

interface KindCategory {
  label: string;
  emoji: string;
  kinds: number[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const KIND_CATEGORIES: KindCategory[] = [
  { label: "Notes",      emoji: "\u{1F4DD}", kinds: [1] },
  { label: "Reposts",    emoji: "\u{1F501}", kinds: [6] },
  { label: "Reactions",  emoji: "\u{2764}\u{FE0F}", kinds: [7] },
  { label: "Profiles",   emoji: "\u{1F464}", kinds: [0] },
  { label: "Contacts",   emoji: "\u{1F465}", kinds: [3] },
  { label: "Articles",   emoji: "\u{1F4C4}", kinds: [30023] },
  { label: "Zaps",       emoji: "\u{26A1}",  kinds: [9735] },
  { label: "DMs",        emoji: "\u{1F512}", kinds: [4, 1059] },
];

/* ------------------------------------------------------------------ */
/*  Helper: aggregate kind counts into categorised rows               */
/* ------------------------------------------------------------------ */

interface KindRow {
  label: string;
  emoji: string;
  count: number;
}

function aggregateKindRows(counts: Record<string, number>): KindRow[] {
  const remaining = new Map<number, number>();
  for (const [k, v] of Object.entries(counts)) {
    remaining.set(Number(k), v);
  }

  const rows: KindRow[] = [];

  for (const cat of KIND_CATEGORIES) {
    let total = 0;
    for (const k of cat.kinds) {
      total += remaining.get(k) || 0;
      remaining.delete(k);
    }
    if (total > 0) {
      rows.push({ label: cat.label, emoji: cat.emoji, count: total });
    }
  }

  // Other -- everything not categorised
  let otherCount = 0;
  for (const v of remaining.values()) otherCount += v;
  if (otherCount > 0) {
    rows.push({ label: "Other", emoji: "\u{1F4E6}", count: otherCount });
  }

  // Sort descending by count
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Storage: React.FC = () => {
  /* --- state -------------------------------------------------------- */
  const [ownershipStats, setOwnershipStats] = useState<OwnershipStorageStats | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [kindCounts, setKindCounts] = useState<Record<string, number> | null>(null);
  const [ownershipError, setOwnershipError] = useState(false);
  const [kindError, setKindError] = useState(false);

  /* --- data loading ------------------------------------------------- */
  useEffect(() => {
    invoke<OwnershipStorageStats>("get_ownership_storage_stats")
      .then(setOwnershipStats)
      .catch((e) => {
        console.error("[storage] get_ownership_storage_stats failed:", e);
        setOwnershipError(true);
      });

    invoke<StorageStats>("get_storage_stats")
      .then(setStorageStats)
      .catch(() => {});

    invoke<KindCountsResult>("get_kind_counts")
      .then((r) => setKindCounts(r.counts))
      .catch((e) => {
        console.error("[storage] get_kind_counts failed:", e);
        setKindError(true);
      });
  }, []);

  /* --- derived values ----------------------------------------------- */
  const title = useMemo(() => {
    if (ownershipError) return "Storage Usage \u2014 no data";
    if (!ownershipStats) return "Storage Usage \u2014 calculating...";
    return `Storage Usage \u2014 ${ownershipStats.total_events.toLocaleString()} events \u00B7 ${formatBytes(ownershipStats.db_size_bytes)}`;
  }, [ownershipStats, ownershipError]);

  const { ownPct, trackedPct, wotPct } = useMemo(() => {
    if (!ownershipStats) return { ownPct: 0, trackedPct: 0, wotPct: 0 };
    const total = ownershipStats.total_events || 1;
    const own = (ownershipStats.own_events_count / total) * 100;
    const tracked = (ownershipStats.tracked_events_count / total) * 100;
    const wot = Math.max(0, 100 - own - tracked);
    return { ownPct: own, trackedPct: tracked, wotPct: wot };
  }, [ownershipStats]);

  const eventRange = useMemo(() => {
    if (!storageStats) return null;
    const oldest =
      storageStats.oldest_event > 0
        ? new Date(storageStats.oldest_event * 1000).toLocaleDateString()
        : "\u2014";
    const newest =
      storageStats.newest_event > 0
        ? new Date(storageStats.newest_event * 1000).toLocaleDateString()
        : "\u2014";
    return `Event range: ${oldest} \u2192 ${newest}`;
  }, [storageStats]);

  const kindRows = useMemo(() => {
    if (!kindCounts) return null;
    return aggregateKindRows(kindCounts);
  }, [kindCounts]);

  const maxKindCount = useMemo(() => {
    if (!kindRows || kindRows.length === 0) return 0;
    return kindRows[0].count;
  }, [kindRows]);

  /* --- render ------------------------------------------------------- */
  return (
    <div className="storage-page-inner">
      {/* ---- Usage bar ---- */}
      <div className="storage-usage-bar">
        <div className="storage-usage-title">{title}</div>
        <div className="storage-usage-visual">
          <div
            className="storage-seg"
            style={{ width: `${ownPct}%`, background: "var(--accent)" }}
          />
          <div
            className="storage-seg"
            style={{ width: `${trackedPct}%`, background: "var(--purple)" }}
          />
          <div
            className="storage-seg"
            style={{ width: `${wotPct}%`, background: "var(--blue)" }}
          />
        </div>
        <div className="storage-legend">
          <div className="storage-legend-item">
            <div className="storage-legend-dot" style={{ background: "var(--accent)" }} />
            <span>Own Events</span>
          </div>
          <div className="storage-legend-item">
            <div className="storage-legend-dot" style={{ background: "var(--purple)" }} />
            <span>Tracked Profiles</span>
          </div>
          <div className="storage-legend-item">
            <div className="storage-legend-dot" style={{ background: "var(--blue)" }} />
            <span>WoT Profiles</span>
          </div>
        </div>
      </div>

      {/* ---- Ownership grid ---- */}
      <div className="ownership-grid">
        {/* Own Events */}
        <div className="ownership-card own">
          <div className="ownership-card-header">
            <span className="ownership-card-label">Own Events</span>
            <Badge text="YOU" className="ownership-card-badge" variant="own" />
          </div>
          <div className="ownership-card-body">
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? ownershipStats.own_events_count.toLocaleString() : "\u2014"}
              </span>
              <span className="ownership-stat-label">events</span>
            </div>
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? formatBytes(ownershipStats.own_media_bytes) : "\u2014"}
              </span>
              <span className="ownership-stat-label">media</span>
            </div>
          </div>
          <div className="ownership-card-footer">
            Always kept &mdash; never pruned &middot; &infin; unlimited
          </div>
        </div>

        {/* Tracked Profiles */}
        <div className="ownership-card tracked">
          <div className="ownership-card-header">
            <span className="ownership-card-label">Tracked Profiles</span>
            <Badge text="TRACKED" className="ownership-card-badge" variant="tracked" />
          </div>
          <div className="ownership-card-body">
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? ownershipStats.tracked_events_count.toLocaleString() : "\u2014"}
              </span>
              <span className="ownership-stat-label">events</span>
            </div>
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? formatBytes(ownershipStats.tracked_media_bytes) : "\u2014"}
              </span>
              <span className="ownership-stat-label">media</span>
            </div>
          </div>
          <div className="ownership-card-footer">
            Always kept &mdash; never pruned
          </div>
        </div>

        {/* WoT Profiles */}
        <div className="ownership-card wot">
          <div className="ownership-card-header">
            <span className="ownership-card-label">WoT Profiles</span>
            <Badge text="WOT" className="ownership-card-badge" variant="wot" />
          </div>
          <div className="ownership-card-body">
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? ownershipStats.wot_events_count.toLocaleString() : "\u2014"}
              </span>
              <span className="ownership-stat-label">events</span>
            </div>
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? formatBytes(ownershipStats.wot_media_bytes) : "\u2014"}
              </span>
              <span className="ownership-stat-label">cached media</span>
            </div>
          </div>
          <div className="ownership-card-footer">
            Subject to retention limits
          </div>
        </div>
      </div>

      {/* ---- DB info ---- */}
      {eventRange && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 12 }}>
          {eventRange}
        </div>
      )}

      {/* ---- Kind breakdown ---- */}
      <div className="kind-breakdown-separator" />

      <div className="kind-breakdown-section">
        <div className="kind-breakdown-title">Event Breakdown</div>
        <div className="kind-breakdown-list">
          {/* Loading state */}
          {!kindCounts && !kindError && (
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Loading...</div>
          )}

          {/* Error state */}
          {kindError && (
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Unable to load breakdown
            </div>
          )}

          {/* Empty state */}
          {kindRows && kindRows.length === 0 && (
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>No events stored</div>
          )}

          {/* Breakdown rows */}
          {kindRows &&
            kindRows.length > 0 &&
            kindRows.map((row) => {
              const pct = maxKindCount > 0 ? (row.count / maxKindCount) * 100 : 0;
              return (
                <div className="kind-breakdown-row" key={row.label}>
                  <span className="kind-breakdown-emoji">{row.emoji}</span>
                  <span className="kind-breakdown-label">{row.label}</span>
                  <div className="kind-breakdown-bar-wrap">
                    <div className="kind-breakdown-bar" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="kind-breakdown-count">{row.count.toLocaleString()}</span>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
};
