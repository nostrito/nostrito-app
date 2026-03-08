/** Dashboard — main overview. All data from backend, no hardcoded mock. */

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

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface SyncProgress {
  tier: number;
  fetched: number;
  total: number;
  relay: string;
}

interface RelayStatusInfo {
  url: string;
  name: string;
  connected: boolean;
  latency_ms: number | null;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;
let unlistenProgress: UnlistenFn | null = null;
let unlistenTierComplete: UnlistenFn | null = null;

const AVATAR_CLASSES = ["av1", "av2", "av3", "av4", "av5", "av6", "av7"];

function avatarClass(pubkey: string): string {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  return AVATAR_CLASSES[Math.abs(hash) % AVATAR_CLASSES.length];
}

function shortPubkey(pk: string): string {
  if (pk.length > 12) return pk.slice(0, 6) + "..." + pk.slice(-4);
  return pk;
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderEventCard(event: NostrEvent): string {
  const initial = event.pubkey.charAt(0).toUpperCase();
  const kindTag = event.kind === 1 ? "note" : event.kind === 30023 ? "long-form" : `k:${event.kind}`;
  const kindClass = event.kind === 1 ? "ev-kind-note" : event.kind === 30023 ? "ev-kind-long" : "ev-kind-note";

  return `
    <div class="event-card">
      <div class="ev-avatar ${avatarClass(event.pubkey)}">${initial}</div>
      <div class="ev-content">
        <div class="ev-meta">
          <span class="ev-npub">${shortPubkey(event.pubkey)}</span>
          <span class="ev-kind-tag ${kindClass}">${kindTag}</span>
          <span class="ev-time">${timeAgo(event.created_at)}</span>
        </div>
        <div class="ev-text">${escapeHtml(event.content.slice(0, 280))}${event.content.length > 280 ? "..." : ""}</div>
        <div class="ev-actions">
          <button class="ev-action"><span class="icon">💬</span> 0</button>
          <button class="ev-action"><span class="icon">🔁</span> 0</button>
          <button class="ev-action"><span class="icon">⚡</span> 0</button>
        </div>
      </div>
    </div>
  `;
}

/** Build activity bars from real hourly data (24 entries from backend) */
function renderActivityBars(data: number[]): string {
  const maxVal = Math.max(...data, 1); // avoid div-by-zero
  return data
    .map((val, i) => {
      const pct = Math.max((val / maxVal) * 100, 4);
      const isRecent = i >= 20;
      const cls = isRecent ? " recent" : "";
      const bg = isRecent ? "var(--accent)" : "rgba(124,58,237,0.2)";
      return `<div class="dash-activity-bar${cls}" style="height:${pct}%;background:${bg}"></div>`;
    })
    .join("");
}

/** Render the relay list from real configured relays */
function renderRelayItems(relays: RelayStatusInfo[]): string {
  if (relays.length === 0) {
    return `<div style="color:var(--text-muted);font-size:0.8rem;padding:4px 0">No relays configured</div>`;
  }
  return relays
    .map((r) => {
      const dotClass = r.connected ? "on" : "";
      const latency = r.latency_ms != null ? `${r.latency_ms}ms` : "—";
      return `<div class="sync-relay-item"><div class="relay-dot ${dotClass}"></div><span class="relay-name">${escapeHtml(r.name)}</span><span class="relay-latency">${latency}</span></div>`;
    })
    .join("");
}

async function loadActivityChart(): Promise<void> {
  try {
    const data = await invoke<number[]>("get_activity_data");
    const barsEl = document.querySelector(".dash-activity-bars");
    if (barsEl) {
      barsEl.innerHTML = renderActivityBars(data);
    }
  } catch (_) {
    // If backend doesn't support it yet, show flat bars
    const flat = new Array(24).fill(0);
    const barsEl = document.querySelector(".dash-activity-bars");
    if (barsEl) barsEl.innerHTML = renderActivityBars(flat);
  }
}

async function loadRelayStatus(): Promise<void> {
  try {
    const relays = await invoke<RelayStatusInfo[]>("get_relay_status");
    const container = document.getElementById("sync-tier-3-detail");
    if (container) {
      container.innerHTML = renderRelayItems(relays);
    }
  } catch (_) {}
}

async function loadStats(): Promise<void> {
  try {
    const status = await invoke<AppStatus>("get_status");
    let uptime = 0;
    try {
      uptime = await invoke<number>("get_uptime");
    } catch (_) {}

    const uptimeStr =
      uptime > 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        : uptime > 60
          ? `${Math.floor(uptime / 60)}m`
          : `${uptime}s`;

    setTextContent("dash-events", status.events_stored.toLocaleString());
    setTextContent("dash-wot-peers", status.wot_nodes.toLocaleString());
    setTextContent("dash-media", "—");
    setTextContent("dash-sync-rate", status.sync_tier > 0 ? "~syncing" : "idle");
    setTextContent("dash-uptime", uptimeStr);

    // Relay badge — show URL when running
    const relayUrl = `ws://localhost:${status.relay_port}`;
    const badge = document.getElementById("dash-relay-badge");
    if (badge) {
      if (status.relay_running) {
        badge.innerHTML = `<span class="status-dot"></span> ${relayUrl}`;
        badge.className = "status-badge";
      } else {
        badge.innerHTML = `○ Offline`;
        badge.className = "status-badge offline";
      }
    }

    // Update titlebar to show relay URL
    const titleEl = document.getElementById("titlebar-title");
    if (titleEl) {
      titleEl.textContent = status.relay_running
        ? `nostrito — ${relayUrl}`
        : `nostrito — Dashboard`;
    }

    // Sync tiers
    const ct = status.sync_tier;
    for (let t = 1; t <= 4; t++) {
      const badgeEl = document.getElementById(`sync-tier-${t}-badge`);
      if (badgeEl) {
        if (t === ct) {
          badgeEl.className = "sync-tier-badge fast";
          badgeEl.textContent = "FAST";
        } else if (t < ct) {
          badgeEl.className = "sync-tier-badge done";
          badgeEl.textContent = "✓";
        } else {
          badgeEl.className = "sync-tier-badge idle";
          badgeEl.textContent = "IDLE";
        }
      }
    }

    // Sync detail
    const s = status.sync_stats;
    const details: Record<number, string> = {};
    if (s.tier1_fetched > 0) details[1] = `${s.tier1_fetched} events`;
    if (s.tier2_fetched > 0) details[2] = `${s.tier2_fetched} events`;
    if (s.tier3_fetched > 0) details[3] = `${s.tier3_fetched} follow lists`;
    if (s.tier4_fetched > 0) details[4] = `${s.tier4_fetched} items`;
    for (let t = 1; t <= 4; t++) {
      const el = document.getElementById(`sync-tier-${t}-detail`);
      if (el && el.id !== "sync-tier-3-detail") {
        // tier 3 detail is the relay list, handled separately
        el.textContent = details[t] || (t <= ct ? "complete" : "—");
      }
    }
  } catch (e) {
    console.error("[dashboard] Failed to load stats:", e);
  }
}

async function loadFeed(): Promise<void> {
  try {
    const events = await invoke<NostrEvent[]>("get_feed", {
      filter: { limit: 20 },
    });
    const feedEl = document.getElementById("dash-feed-list");
    if (feedEl) {
      if (events.length === 0) {
        feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">No events yet — syncing will populate your feed.</div>`;
      } else {
        feedEl.innerHTML = events.map(renderEventCard).join("");
      }
    }
  } catch (_) {}
}

function setTextContent(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export async function renderDashboard(container: HTMLElement): Promise<void> {
  if (pollInterval) clearInterval(pollInterval);
  if (unlistenProgress) unlistenProgress();
  if (unlistenTierComplete) unlistenTierComplete();

  container.className = "main-content";
  container.innerHTML = `
    <!-- Header -->
    <div class="dash-header">
      <div class="dash-header-left">
        <span class="dash-header-name">🌶️ nostrito</span>
        <span class="status-badge" id="dash-relay-badge"><span class="status-dot"></span> Live</span>
      </div>
    </div>

    <!-- Stats row -->
    <div class="dash-stats">
      <div class="dash-stat"><div class="dash-stat-val" id="dash-events">—</div><div class="dash-stat-label">Events Synced</div></div>
      <div class="dash-stat"><div class="dash-stat-val" id="dash-wot-peers">—</div><div class="dash-stat-label">WoT Peers</div></div>
      <div class="dash-stat"><div class="dash-stat-val" id="dash-media">—</div><div class="dash-stat-label">Media Cached</div></div>
      <div class="dash-stat"><div class="dash-stat-val" id="dash-sync-rate">—</div><div class="dash-stat-label">Sync Rate</div></div>
      <div class="dash-stat"><div class="dash-stat-val" id="dash-uptime">—</div><div class="dash-stat-label">Uptime</div></div>
    </div>

    <!-- Activity chart — populated from backend -->
    <div class="dash-activity">
      <div class="dash-activity-label">Last 24h activity</div>
      <div class="dash-activity-bars"></div>
    </div>

    <!-- Body: feed + sidebar -->
    <div class="dash-body">
      <div class="dash-feed" id="dash-feed-list">
        <div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">Loading...</div>
      </div>
      <div class="dash-sidebar">
        <div class="sync-engine-header">Sync Engine</div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 1 — Profile & Follows</span>
            <span class="sync-tier-badge idle" id="sync-tier-1-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-tier-1-detail">—</div>
        </div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 2 — Recent Events</span>
            <span class="sync-tier-badge idle" id="sync-tier-2-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-tier-2-detail">—</div>
        </div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 3 — Relays</span>
            <span class="sync-tier-badge idle" id="sync-tier-3-badge" style="display:none">IDLE</span>
          </div>
          <div style="padding-top:4px" id="sync-tier-3-detail">
            <!-- Populated from get_relay_status -->
          </div>
        </div>
        <div class="sync-tier dimmed">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 4 — Fallback</span>
            <span class="sync-tier-badge idle" id="sync-tier-4-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-tier-4-detail">—</div>
        </div>
        <div class="blossom-section">
          <div class="blossom-title">🌸 Blossom</div>
          <div class="blossom-detail">Media caching coming soon</div>
        </div>
      </div>
    </div>
  `;

  unlistenProgress = await listen<SyncProgress>("sync:progress", () => loadStats());
  unlistenTierComplete = await listen<{ tier: number }>("sync:tier_complete", () => {
    loadStats();
    loadFeed();
  });

  await Promise.all([loadStats(), loadFeed(), loadActivityChart(), loadRelayStatus()]);
  pollInterval = setInterval(() => {
    loadStats();
    loadFeed();
    loadActivityChart();
    loadRelayStatus();
  }, 15000);
}
