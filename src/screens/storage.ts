/** Storage — database stats view. All data from backend commands. */

import { invoke } from "@tauri-apps/api/core";

interface StorageStats {
  total_events: number;
  db_size_bytes: number;
  oldest_event: number;
  newest_event: number;
}

interface KindCounts {
  counts: Record<string, number>;
}

export function renderStorage(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="storage-page-inner">
      <div class="storage-usage-bar">
        <div class="storage-usage-title" id="storage-title">Storage Usage — calculating...</div>
        <div class="storage-usage-visual">
          <div class="storage-seg storage-seg-notes" id="seg-notes" style="width:0%"></div>
          <div class="storage-seg storage-seg-media" id="seg-media" style="width:0%"></div>
          <div class="storage-seg storage-seg-meta" id="seg-meta" style="width:0%"></div>
          <div class="storage-seg storage-seg-other" id="seg-other" style="width:0%"></div>
        </div>
        <div class="storage-legend">
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--accent)"></div><span id="legend-notes">Notes</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--purple)"></div><span id="legend-media">Media</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--blue)"></div><span id="legend-meta">Metadata</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--green)"></div><span id="legend-other">Other</span></div>
        </div>
      </div>
      <div class="kind-grid-page" id="kind-grid">
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">📝</span><span class="kind-name">Notes</span><span class="kind-count" id="kc-1">—</span></div><span class="kind-meta">kind 1</span></div>
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">📰</span><span class="kind-name">Long-form</span><span class="kind-count" id="kc-30023">—</span></div><span class="kind-meta">kind 30023</span></div>
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">⚡</span><span class="kind-name">Zaps</span><span class="kind-count" id="kc-9735">—</span></div><span class="kind-meta">kind 9735</span></div>
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">🔁</span><span class="kind-name">Reposts</span><span class="kind-count" id="kc-6">—</span></div><span class="kind-meta">kind 6</span></div>
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">❤️</span><span class="kind-name">Reactions</span><span class="kind-count" id="kc-7">—</span></div><span class="kind-meta">kind 7</span></div>
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">🏷️</span><span class="kind-name">Metadata</span><span class="kind-count" id="kc-0">—</span></div><span class="kind-meta">kind 0</span></div>
        <div class="kind-card-p"><div class="kind-card-top"><span class="kind-icon">👥</span><span class="kind-name">Contacts</span><span class="kind-count" id="kc-3">—</span></div><span class="kind-meta">kind 3</span></div>
      </div>
      <div id="storage-db-info" style="font-size:0.8rem;color:var(--text-muted);margin-top:12px">
      </div>
    </div>
  `;

  loadStorageStats();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

async function loadStorageStats(): Promise<void> {
  try {
    // Get real storage stats
    const stats = await invoke<StorageStats>("get_storage_stats");

    const titleEl = document.getElementById("storage-title");
    if (titleEl) {
      titleEl.textContent = `Storage Usage — ${stats.total_events.toLocaleString()} events · ${formatBytes(stats.db_size_bytes)}`;
    }

    // Get real kind counts
    try {
      const kindData = await invoke<KindCounts>("get_kind_counts");
      const counts = kindData.counts;

      // Populate kind cards
      const kindIds = ["0", "1", "3", "6", "7", "9735", "30023"];
      for (const k of kindIds) {
        const el = document.getElementById(`kc-${k}`);
        if (el) {
          const count = counts[k] || 0;
          el.textContent = count.toLocaleString();
        }
      }

      // Compute storage bar segments from real data
      const total = stats.total_events || 1;
      const notes = (counts["1"] || 0) / total * 100;
      const meta = (counts["0"] || 0) / total * 100;
      const contacts = (counts["3"] || 0) / total * 100;
      const other = Math.max(0, 100 - notes - meta - contacts);

      const segNotes = document.getElementById("seg-notes");
      const segMedia = document.getElementById("seg-media");
      const segMeta = document.getElementById("seg-meta");
      const segOther = document.getElementById("seg-other");
      if (segNotes) segNotes.style.width = `${notes}%`;
      if (segMedia) segMedia.style.width = `${contacts}%`; // reuse for contacts
      if (segMeta) segMeta.style.width = `${meta}%`;
      if (segOther) segOther.style.width = `${other}%`;
    } catch (_) {
      // Kind counts not available yet
    }

    // Show DB info
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
  } catch (_) {
    const titleEl = document.getElementById("storage-title");
    if (titleEl) titleEl.textContent = "Storage Usage — no data";
  }
}
