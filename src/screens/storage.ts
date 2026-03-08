/** Storage — database stats view matching reference design */

import { invoke } from "@tauri-apps/api/core";

interface StorageStats {
  total_events: number;
  db_size_bytes: number;
  oldest_event: number;
  newest_event: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(ts: number): string {
  if (ts === 0) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

export async function renderStorage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="storage-page-inner">
      <div class="storage-usage-bar">
        <div class="storage-usage-title" id="storage-title">Storage Usage</div>
        <div class="storage-usage-visual">
          <div class="storage-seg storage-seg-notes" style="width:50%"></div>
          <div class="storage-seg storage-seg-meta" style="width:15%"></div>
          <div class="storage-seg storage-seg-other" style="width:5%"></div>
        </div>
        <div class="storage-legend">
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--accent)"></div><span id="legend-events">Events</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:#60a5fa"></div><span>Metadata</span></div>
          <div class="storage-legend-item"><div class="storage-legend-dot" style="background:var(--green)"></div><span>Other</span></div>
        </div>
      </div>

      <div class="kind-grid">
        <div class="kind-card">
          <div class="kind-card-top"><span class="kind-icon">📝</span><span class="kind-name">Notes</span><span class="kind-count" id="kind-1">—</span></div>
          <span class="kind-meta">kind 1</span>
        </div>
        <div class="kind-card">
          <div class="kind-card-top"><span class="kind-icon">📰</span><span class="kind-name">Long-form</span><span class="kind-count" id="kind-30023">—</span></div>
          <span class="kind-meta">kind 30023</span>
        </div>
        <div class="kind-card">
          <div class="kind-card-top"><span class="kind-icon">🔁</span><span class="kind-name">Reposts</span><span class="kind-count" id="kind-6">—</span></div>
          <span class="kind-meta">kind 6</span>
        </div>
        <div class="kind-card">
          <div class="kind-card-top"><span class="kind-icon">❤️</span><span class="kind-name">Reactions</span><span class="kind-count" id="kind-7">—</span></div>
          <span class="kind-meta">kind 7</span>
        </div>
        <div class="kind-card">
          <div class="kind-card-top"><span class="kind-icon">👤</span><span class="kind-name">Contacts</span><span class="kind-count" id="kind-3">—</span></div>
          <span class="kind-meta">kind 3</span>
        </div>
        <div class="kind-card">
          <div class="kind-card-top"><span class="kind-icon">🏷️</span><span class="kind-name">Metadata</span><span class="kind-count" id="kind-0">—</span></div>
          <span class="kind-meta">kind 0</span>
        </div>
      </div>

      <div style="font-size:0.82rem;color:var(--text-dim);font-family:var(--mono);" id="storage-range">
        Event range: loading...
      </div>
    </div>
  `;

  try {
    const stats = await invoke<StorageStats>("get_storage_stats");
    const titleEl = document.getElementById("storage-title");
    const rangeEl = document.getElementById("storage-range");
    const legendEl = document.getElementById("legend-events");

    if (titleEl) titleEl.textContent = `Storage Usage — ${formatBytes(stats.db_size_bytes)} · ${stats.total_events.toLocaleString()} events`;
    if (rangeEl) rangeEl.textContent = `Event range: ${formatDate(stats.oldest_event)} — ${formatDate(stats.newest_event)}`;
    if (legendEl) legendEl.textContent = `Events (${stats.total_events.toLocaleString()})`;
  } catch (e) {
    console.error("[storage]", e);
  }
}
