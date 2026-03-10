/** Storage — ownership-based breakdown view. All data from backend commands. */

import { invoke } from "@tauri-apps/api/core";
import { iconBlossom } from "../utils/icons";

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

export function renderStorage(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="storage-page-inner">
      <div class="storage-usage-bar">
        <div class="storage-usage-title" id="storage-title">Storage Usage — calculating...</div>
        <div class="storage-usage-visual">
          <div class="storage-seg" id="seg-own" style="width:0%;background:var(--accent)"></div>
          <div class="storage-seg" id="seg-tracked" style="width:0%;background:var(--purple)"></div>
          <div class="storage-seg" id="seg-wot" style="width:0%;background:var(--blue)"></div>
        </div>
        <div class="storage-legend">
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--accent)"></div><span>Own Events</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--purple)"></div><span>Tracked Profiles</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--blue)"></div><span>WoT Profiles</span></div>
        </div>
      </div>

      <div class="ownership-grid" id="ownership-grid">
        <!-- Own Events -->
        <div class="ownership-card own">
          <div class="ownership-card-header">
            <span class="ownership-card-label">Own Events</span>
            <span class="ownership-card-badge own">YOU</span>
          </div>
          <div class="ownership-card-body">
            <div class="ownership-stat">
              <span class="ownership-stat-value" id="own-events-count">—</span>
              <span class="ownership-stat-label">events</span>
            </div>
            <div class="ownership-stat">
              <span class="ownership-stat-value" id="own-media-size">—</span>
              <span class="ownership-stat-label">media</span>
            </div>
          </div>
          <div class="ownership-card-footer">Always kept — never pruned</div>
        </div>

        <!-- Tracked Profiles -->
        <div class="ownership-card tracked">
          <div class="ownership-card-header">
            <span class="ownership-card-label">Tracked Profiles</span>
            <span class="ownership-card-badge tracked">TRACKED</span>
          </div>
          <div class="ownership-card-body">
            <div class="ownership-stat">
              <span class="ownership-stat-value" id="tracked-events-count">—</span>
              <span class="ownership-stat-label">events</span>
            </div>
            <div class="ownership-stat">
              <span class="ownership-stat-value" id="tracked-media-size">—</span>
              <span class="ownership-stat-label">media</span>
            </div>
          </div>
          <div class="ownership-card-footer">Always kept — never pruned</div>
        </div>

        <!-- WoT Profiles -->
        <div class="ownership-card wot">
          <div class="ownership-card-header">
            <span class="ownership-card-label">WoT Profiles</span>
            <span class="ownership-card-badge wot">WOT</span>
          </div>
          <div class="ownership-card-body">
            <div class="ownership-stat">
              <span class="ownership-stat-value" id="wot-events-count">—</span>
              <span class="ownership-stat-label">events</span>
            </div>
            <div class="ownership-stat">
              <span class="ownership-stat-value" id="wot-media-size">—</span>
              <span class="ownership-stat-label">cached media</span>
            </div>
          </div>
          <div class="ownership-card-footer">Subject to retention limits</div>
        </div>
      </div>

      <div class="storage-media-section" id="storage-media-section" style="margin-top:20px">
        <div class="storage-usage-title"><span class="icon">${iconBlossom()}</span> Blossom Media Cache (Total)</div>
        <div class="storage-usage-visual" style="margin:8px 0">
          <div class="storage-seg" id="media-seg-fill" style="width:0%;background:var(--purple)"></div>
        </div>
        <div style="display:flex;gap:24px;font-size:0.82rem;color:var(--text-dim);margin-top:6px;flex-wrap:wrap">
          <span><span id="media-file-count">—</span> files</span>
          <span><span id="media-size-used">—</span> used</span>
          <span>limit: <span id="media-size-limit">—</span></span>
        </div>
      </div>

      <div id="storage-db-info" style="font-size:0.8rem;color:var(--text-muted);margin-top:12px"></div>

      <div class="kind-breakdown-separator"></div>

      <div class="kind-breakdown-section" id="kind-breakdown-section">
        <div class="kind-breakdown-title">Event Breakdown</div>
        <div class="kind-breakdown-list" id="kind-breakdown-list">
          <div style="font-size:0.8rem;color:var(--text-muted)">Loading...</div>
        </div>
      </div>
    </div>
  `;

  loadOwnershipStats();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

async function loadOwnershipStats(): Promise<void> {
  try {
    const stats = await invoke<OwnershipStorageStats>("get_ownership_storage_stats");

    // Title
    const titleEl = document.getElementById("storage-title");
    if (titleEl) {
      titleEl.textContent = `Storage Usage — ${stats.total_events.toLocaleString()} events · ${formatBytes(stats.db_size_bytes)}`;
    }

    // Own
    const ownCountEl = document.getElementById("own-events-count");
    const ownMediaEl = document.getElementById("own-media-size");
    if (ownCountEl) ownCountEl.textContent = stats.own_events_count.toLocaleString();
    if (ownMediaEl) ownMediaEl.textContent = formatBytes(stats.own_media_bytes);

    // Tracked
    const trackedCountEl = document.getElementById("tracked-events-count");
    const trackedMediaEl = document.getElementById("tracked-media-size");
    if (trackedCountEl) trackedCountEl.textContent = stats.tracked_events_count.toLocaleString();
    if (trackedMediaEl) trackedMediaEl.textContent = formatBytes(stats.tracked_media_bytes);

    // WoT
    const wotCountEl = document.getElementById("wot-events-count");
    const wotMediaEl = document.getElementById("wot-media-size");
    if (wotCountEl) wotCountEl.textContent = stats.wot_events_count.toLocaleString();
    if (wotMediaEl) wotMediaEl.textContent = formatBytes(stats.wot_media_bytes);

    // Usage bar segments
    const total = stats.total_events || 1;
    const ownPct = (stats.own_events_count / total) * 100;
    const trackedPct = (stats.tracked_events_count / total) * 100;
    const wotPct = Math.max(0, 100 - ownPct - trackedPct);

    const segOwn = document.getElementById("seg-own");
    const segTracked = document.getElementById("seg-tracked");
    const segWot = document.getElementById("seg-wot");
    if (segOwn) segOwn.style.width = `${ownPct}%`;
    if (segTracked) segTracked.style.width = `${trackedPct}%`;
    if (segWot) segWot.style.width = `${wotPct}%`;

  } catch (e) {
    const titleEl = document.getElementById("storage-title");
    if (titleEl) titleEl.textContent = "Storage Usage — no data";
    console.error("[storage] get_ownership_storage_stats failed:", e);
  }

  // Media cache stats (total)
  try {
    const media = await invoke<{ total_bytes: number; file_count: number; limit_bytes: number }>("get_media_stats");
    const countEl = document.getElementById("media-file-count");
    const usedEl = document.getElementById("media-size-used");
    const limitEl = document.getElementById("media-size-limit");
    const fillEl = document.getElementById("media-seg-fill");
    if (countEl) countEl.textContent = media.file_count.toLocaleString();
    if (usedEl) usedEl.textContent = formatBytes(media.total_bytes);
    if (limitEl) limitEl.textContent = formatBytes(media.limit_bytes);
    const pct = media.limit_bytes > 0 ? Math.min(100, (media.total_bytes / media.limit_bytes) * 100) : 0;
    if (fillEl) fillEl.style.width = `${pct}%`;
  } catch (_) {}

  // DB info (event time range)
  try {
    const stats = await invoke<{ total_events: number; db_size_bytes: number; oldest_event: number; newest_event: number }>("get_storage_stats");
    const dbInfo = document.getElementById("storage-db-info");
    if (dbInfo) {
      const oldest = stats.oldest_event > 0
        ? new Date(stats.oldest_event * 1000).toLocaleDateString()
        : "—";
      const newest = stats.newest_event > 0
        ? new Date(stats.newest_event * 1000).toLocaleDateString()
        : "—";
      dbInfo.textContent = `Event range: ${oldest} → ${newest}`;
    }
  } catch (_) {}

  // Kind breakdown
  try {
    const kindData = await invoke<{ counts: Record<string, number> }>("get_kind_counts");
    renderKindBreakdown(kindData.counts);
  } catch (e) {
    console.error("[storage] get_kind_counts failed:", e);
    const listEl = document.getElementById("kind-breakdown-list");
    if (listEl) listEl.innerHTML = `<div style="font-size:0.8rem;color:var(--text-muted)">Unable to load breakdown</div>`;
  }
}

interface KindCategory {
  label: string;
  emoji: string;
  kinds: number[];
}

const KIND_CATEGORIES: KindCategory[] = [
  { label: "Notes",     emoji: "📝", kinds: [1] },
  { label: "Reposts",   emoji: "🔁", kinds: [6] },
  { label: "Reactions",  emoji: "❤️", kinds: [7] },
  { label: "Profiles",  emoji: "👤", kinds: [0] },
  { label: "Contacts",  emoji: "👥", kinds: [3] },
  { label: "Articles",  emoji: "📄", kinds: [30023] },
  { label: "Zaps",      emoji: "⚡", kinds: [9735] },
  { label: "DMs",       emoji: "🔒", kinds: [4, 1059] },
];

function renderKindBreakdown(counts: Record<string, number>): void {
  const listEl = document.getElementById("kind-breakdown-list");
  if (!listEl) return;

  // Aggregate counts into categories
  const remaining = new Map<number, number>();
  for (const [k, v] of Object.entries(counts)) {
    remaining.set(Number(k), v);
  }

  const rows: { label: string; emoji: string; count: number }[] = [];

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

  // Other — everything not categorized
  let otherCount = 0;
  for (const v of remaining.values()) otherCount += v;
  if (otherCount > 0) {
    rows.push({ label: "Other", emoji: "📦", count: otherCount });
  }

  if (rows.length === 0) {
    listEl.innerHTML = `<div style="font-size:0.8rem;color:var(--text-muted)">No events stored</div>`;
    return;
  }

  // Sort descending by count
  rows.sort((a, b) => b.count - a.count);

  const maxCount = rows[0].count;

  listEl.innerHTML = rows.map(r => {
    const pct = maxCount > 0 ? (r.count / maxCount) * 100 : 0;
    return `
      <div class="kind-breakdown-row">
        <span class="kind-breakdown-emoji">${r.emoji}</span>
        <span class="kind-breakdown-label">${r.label}</span>
        <div class="kind-breakdown-bar-wrap">
          <div class="kind-breakdown-bar" style="width:${pct}%"></div>
        </div>
        <span class="kind-breakdown-count">${r.count.toLocaleString()}</span>
      </div>`;
  }).join("");
}
