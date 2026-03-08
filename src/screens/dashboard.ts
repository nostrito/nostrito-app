/** Dashboard — main overview screen with live stats from Rust backend */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface AppStatus {
  initialized: boolean;
  npub: string | null;
  relay_running: boolean;
  relay_port: number;
  events_stored: number;
  wot_nodes: number;
  wot_edges: number;
  sync_status: string;
  sync_tier: number;
  sync_stats: {
    tier1_fetched: number;
    tier2_fetched: number;
    tier3_fetched: number;
    tier4_fetched: number;
    current_tier: number;
  };
}

interface SyncProgress {
  tier: number;
  fetched: number;
  total: number;
  relay: string;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;
let unlistenProgress: UnlistenFn | null = null;
let unlistenTierComplete: UnlistenFn | null = null;

function tierLabel(tier: number): string {
  switch (tier) {
    case 1: return "Tier 1: Profile & follows";
    case 2: return "Tier 2: Recent events";
    case 3: return "Tier 3: WoT crawl";
    case 4: return "Tier 4: Archive";
    default: return "Idle";
  }
}

async function loadStats(): Promise<void> {
  try {
    const status = await invoke<AppStatus>("get_status");

    const elPubkeys = document.getElementById("stat-pubkeys");
    const elEvents = document.getElementById("stat-events");
    const elEdges = document.getElementById("stat-edges");
    const elSyncStatus = document.getElementById("stat-sync-status");
    const elSyncDetail = document.getElementById("stat-sync-detail");
    const elRelayStatus = document.getElementById("stat-relay-status");

    if (elPubkeys) elPubkeys.textContent = status.wot_nodes.toLocaleString();
    if (elEvents) elEvents.textContent = status.events_stored.toLocaleString();
    if (elEdges) elEdges.textContent = status.wot_edges.toLocaleString();
    if (elRelayStatus) {
      elRelayStatus.textContent = status.relay_running ? "● Running" : "○ Stopped";
      elRelayStatus.style.color = status.relay_running
        ? "var(--green)"
        : "var(--text-dim)";
    }

    if (elSyncStatus) {
      if (status.sync_tier > 0) {
        elSyncStatus.textContent = tierLabel(status.sync_tier);
        elSyncStatus.style.color = "var(--accent-light)";
      } else {
        elSyncStatus.textContent = "Idle";
        elSyncStatus.style.color = "var(--text-dim)";
      }
    }

    if (elSyncDetail) {
      const s = status.sync_stats;
      const parts: string[] = [];
      if (s.tier1_fetched > 0) parts.push(`T1: ${s.tier1_fetched}`);
      if (s.tier2_fetched > 0) parts.push(`T2: ${s.tier2_fetched}`);
      if (s.tier3_fetched > 0) parts.push(`T3: ${s.tier3_fetched}`);
      if (s.tier4_fetched > 0) parts.push(`T4: ${s.tier4_fetched}`);
      elSyncDetail.textContent = parts.length > 0
        ? `Fetched: ${parts.join(" · ")}`
        : "";
    }
  } catch (e) {
    console.error("[dashboard] Failed to load stats:", e);
  }
}

function updateSyncProgress(data: SyncProgress): void {
  const elSyncStatus = document.getElementById("stat-sync-status");
  const elSyncDetail = document.getElementById("stat-sync-detail");

  if (elSyncStatus) {
    elSyncStatus.textContent = tierLabel(data.tier);
    elSyncStatus.style.color = "var(--accent-light)";
  }
  if (elSyncDetail && data.relay) {
    elSyncDetail.textContent = `${data.fetched} fetched${data.total > 0 ? ` / ${data.total}` : ""} — ${data.relay}`;
  }
}

export async function renderDashboard(container: HTMLElement): Promise<void> {
  // Cleanup previous listeners
  if (pollInterval) clearInterval(pollInterval);
  if (unlistenProgress) unlistenProgress();
  if (unlistenTierComplete) unlistenTierComplete();

  container.innerHTML = `
    <h1 style="font-size: 24px; margin-bottom: 20px;">📊 Dashboard</h1>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Relay Status</div>
        <div id="stat-relay-status" style="font-size: 20px; font-weight: 600; margin-top: 4px; color: var(--text-dim);">○ Stopped</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Events Stored</div>
        <div id="stat-events" style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">WoT Pubkeys</div>
        <div id="stat-pubkeys" style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">WoT Edges</div>
        <div id="stat-edges" style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card" style="grid-column: span 2;">
        <div style="color: var(--text-dim); font-size: 13px;">Sync Status</div>
        <div id="stat-sync-status" style="font-size: 20px; font-weight: 600; margin-top: 4px;">Loading...</div>
        <div id="stat-sync-detail" style="color: var(--text-dim); font-size: 13px; margin-top: 4px;"></div>
      </div>
    </div>
  `;

  // Listen for real-time sync progress from Rust
  unlistenProgress = await listen<SyncProgress>("sync:progress", (event) => {
    updateSyncProgress(event.payload);
  });

  unlistenTierComplete = await listen<{ tier: number }>("sync:tier_complete", (event) => {
    const elSyncDetail = document.getElementById("stat-sync-detail");
    if (elSyncDetail) {
      elSyncDetail.textContent = `${tierLabel(event.payload.tier)} ✓ complete`;
    }
    // Refresh stats on tier completion
    loadStats();
  });

  // Initial load + poll every 5 seconds
  await loadStats();
  pollInterval = setInterval(loadStats, 5000);
}
