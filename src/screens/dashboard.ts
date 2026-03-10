/** Dashboard — main overview. All data from backend, no hardcoded mock. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getProfiles, profileDisplayName } from "../utils/profiles";
import { iconChili } from "../utils/icons";
// Media viewer no longer needed on dashboard (compact live table instead of full cards)

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
    tracked_fetched: number;
    tier2_fetched: number;
    tier3_fetched: number;
    tier4_fetched: number;
    current_tier: number;
  };
  // Mapped to layers: tier1→layer0, tracked→layer0.5, tier2→layer1, tier3→layer2
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
let slowPollInterval: ReturnType<typeof setInterval> | null = null;
let unlistenProgress: UnlistenFn | null = null;
let unlistenTierComplete: UnlistenFn | null = null;
let dashFeedLoading = false;

const AVATAR_CLASSES = ["av1", "av2", "av3", "av4", "av5", "av6", "av7"];

function avatarClass(pubkey: string): string {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  return AVATAR_CLASSES[Math.abs(hash) % AVATAR_CLASSES.length];
}


function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// renderEventCard removed — dashboard now uses compact live event table

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
    console.log("[dashboard] Calling get_activity_data...");
    const data = await invoke<number[]>("get_activity_data");
    console.log("[dashboard] get_activity_data response:", data.length, "buckets, total:", data.reduce((a, b) => a + b, 0));
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
    console.log("[dashboard] Calling get_relay_status...");
    const relays = await invoke<RelayStatusInfo[]>("get_relay_status");
    console.log("[dashboard] get_relay_status response:", relays.length, "relays");
    const container = document.getElementById("sync-relay-detail");
    if (container) {
      container.innerHTML = renderRelayItems(relays);
    }
  } catch (_) {}
}

async function loadStats(): Promise<void> {
  try {
    console.log("[dashboard] Calling get_status...");
    const status = await invoke<AppStatus>("get_status");
    console.log("[dashboard] get_status response:", JSON.stringify(status));
    let uptime = 0;
    try {
      uptime = await invoke<number>("get_uptime");
      console.log("[dashboard] get_uptime:", uptime, "s");
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
    const relayUrl = `wss://localhost:${status.relay_port}`;
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

    // Sync layers (mapped from backend tiers)
    // Layer IDs: 0 = own, 05 = tracked, 1 = follows, 2 = WoT
    const ct = status.sync_tier;
    const layerIds = ["0", "05", "1", "2"];
    // Map layer ID to the backend tier number that drives it
    const layerToTier: Record<string, number> = { "0": 1, "05": 15, "1": 2, "2": 3 };
    for (const lid of layerIds) {
      const tier = layerToTier[lid];
      const badgeEl = document.getElementById(`sync-layer-${lid}-badge`);
      if (badgeEl) {
        if (tier === ct) {
          badgeEl.className = "sync-tier-badge fast";
          badgeEl.textContent = "FAST";
        } else if (tier < ct) {
          badgeEl.className = "sync-tier-badge done";
          badgeEl.textContent = "✓";
        } else {
          badgeEl.className = "sync-tier-badge idle";
          badgeEl.textContent = "IDLE";
        }
      }
    }

    // Sync detail per layer
    const s = status.sync_stats;
    const layerDetails: Record<string, string> = {};
    if (s.tier1_fetched > 0) layerDetails["0"] = `${s.tier1_fetched} events`;
    if ((s.tracked_fetched || 0) > 0) layerDetails["05"] = `${s.tracked_fetched} events`;
    if (s.tier2_fetched > 0) layerDetails["1"] = `${s.tier2_fetched} events`;
    if ((s.tier3_fetched || 0) + (s.tier4_fetched || 0) > 0)
      layerDetails["2"] = `${(s.tier3_fetched || 0) + (s.tier4_fetched || 0)} events`;
    for (const lid of layerIds) {
      const tier = layerToTier[lid];
      const el = document.getElementById(`sync-layer-${lid}-detail`);
      if (el) {
        el.textContent = layerDetails[lid] || (tier <= ct ? "complete" : "—");
      }
    }
  } catch (e) {
    console.error("[dashboard] Failed to load stats:", e);
  }
}

async function loadFeed(): Promise<void> {
  if (dashFeedLoading) return;
  dashFeedLoading = true;
  try {
    const rawEvents = await invoke<NostrEvent[]>("get_feed", { filter: { limit: 30 } });
    const seen = new Set<string>();
    const events = rawEvents.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    }).sort((a, b) => b.created_at - a.created_at).slice(0, 10);

    const tableEl = document.getElementById("dash-live-table");
    const countEl = document.getElementById("dash-live-count");
    if (!tableEl) return;

    if (events.length === 0) {
      tableEl.innerHTML = `<div class="dash-live-empty">Waiting for events...</div>`;
      return;
    }

    const pubkeys = [...new Set(events.map((e) => e.pubkey))];
    const profileMap = await getProfiles(pubkeys);

    if (countEl) countEl.textContent = `${events.length} events`;

    tableEl.innerHTML = events.map((e) => {
      const profile = profileMap.get(e.pubkey);
      const name = profileDisplayName(profile, e.pubkey);
      const avatar = profile?.picture
        ? `<img class="live-avatar" src="${escapeHtml(profile.picture)}" onerror="this.style.display='none'">`
        : `<div class="live-avatar live-avatar-fallback ${avatarClass(e.pubkey)}">${e.pubkey.charAt(0).toUpperCase()}</div>`;
      const kindLabel = e.kind === 1 ? 'note' : e.kind === 6 ? 'repost' : e.kind === 7 ? 'reaction' : e.kind === 4 ? 'dm' : e.kind === 0 ? 'profile' : e.kind === 3 ? 'contacts' : `k:${e.kind}`;
      const preview = e.content.replace(/https?:\/\/\S+/g, '').trim().slice(0, 60) || '—';
      return `
        <div class="dash-live-row">
          ${avatar}
          <span class="live-name">${escapeHtml(name)}</span>
          <span class="live-kind live-kind-${e.kind === 1 ? 'note' : e.kind === 6 ? 'repost' : 'other'}">${kindLabel}</span>
          <span class="live-preview">${escapeHtml(preview)}</span>
          <span class="live-time">${timeAgo(e.created_at)}</span>
        </div>
      `;
    }).join('');
  } catch (_) {
  } finally {
    dashFeedLoading = false;
  }
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
  if (slowPollInterval) clearInterval(slowPollInterval);
  if (unlistenProgress) unlistenProgress();
  if (unlistenTierComplete) unlistenTierComplete();

  container.className = "main-content";
  container.innerHTML = `
    <!-- Header -->
    <div class="dash-header">
      <div class="dash-header-left">
        <span class="dash-header-name"><span class="icon">${iconChili()}</span> nostrito</span>
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
      <div class="dash-live-events">
        <div class="dash-live-header">
          <span class="dash-live-title">Latest Events</span>
          <span class="dash-live-count" id="dash-live-count">—</span>
        </div>
        <div class="dash-live-table" id="dash-live-table">
          <div class="dash-live-empty">Waiting for events...</div>
        </div>
      </div>
      <div class="dash-sidebar">
        <div class="sync-engine-header">Sync Engine</div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Layer 0 — Own Content</span>
            <span class="sync-tier-badge idle" id="sync-layer-0-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-layer-0-detail">—</div>
        </div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Layer 0.5 — Tracked</span>
            <span class="sync-tier-badge idle" id="sync-layer-05-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-layer-05-detail">—</div>
        </div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Layer 1 — Direct Follows</span>
            <span class="sync-tier-badge idle" id="sync-layer-1-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-layer-1-detail">—</div>
        </div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Layer 2 — WoT Peers</span>
            <span class="sync-tier-badge idle" id="sync-layer-2-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-layer-2-detail">—</div>
        </div>
        <div class="sync-tier">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Relays</span>
          </div>
          <div style="padding-top:4px" id="sync-relay-detail">
            <!-- Populated from get_relay_status -->
          </div>
        </div>
      </div>
    </div>
  `;

  unlistenProgress = await listen<SyncProgress>("sync:progress", (event) => {
    console.log("[dashboard] sync:progress event:", event.payload);
    loadStats();
  });
  unlistenTierComplete = await listen<{ tier: number }>("sync:tier_complete", (event) => {
    console.log("[dashboard] sync:tier_complete event:", event.payload);
    loadStats();
    loadFeed();
  });

  await Promise.all([loadStats(), loadFeed(), loadActivityChart(), loadRelayStatus()]);

  // Stats refresh every 1s for responsive dashboard
  pollInterval = setInterval(() => {
    loadStats();
  }, 1000);

  // Feed, activity chart, and relay status on a slower 15s cadence
  slowPollInterval = setInterval(() => {
    loadFeed();
    loadActivityChart();
    loadRelayStatus();
  }, 15000);
}
