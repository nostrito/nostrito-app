/** Dashboard — main overview matching the reference design */

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

let pollInterval: ReturnType<typeof setInterval> | null = null;
let unlistenProgress: UnlistenFn | null = null;
let unlistenTierComplete: UnlistenFn | null = null;

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #7c3aed, #a78bfa)",
  "linear-gradient(135deg, #2563eb, #60a5fa)",
  "linear-gradient(135deg, #059669, #34d399)",
  "linear-gradient(135deg, #d97706, #fbbf24)",
  "linear-gradient(135deg, #dc2626, #f87171)",
  "linear-gradient(135deg, #0891b2, #22d3ee)",
  "linear-gradient(135deg, #7c3aed, #f472b6)",
];

function avatarGradient(pubkey: string): string {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
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

function tierLabel(tier: number): string {
  switch (tier) {
    case 1: return "Tier 1 — Local Cache";
    case 2: return "Tier 2 — WoT Peers";
    case 3: return "Tier 3 — Relays";
    case 4: return "Tier 4 — Fallback";
    default: return "Idle";
  }
}

function tierBadge(tier: number, currentTier: number): string {
  if (tier === currentTier) return `<span class="sync-tier-badge fast"><span class="pulse-dot"></span></span>`;
  if (tier < currentTier) return `<span class="sync-tier-badge done">✓</span>`;
  return `<span class="sync-tier-badge idle">IDLE</span>`;
}

function generateActivityBars(): string {
  const bars: string[] = [];
  for (let i = 0; i < 24; i++) {
    const h = 5 + Math.floor(Math.random() * 35);
    const recent = i >= 20;
    bars.push(`<div class="dash-activity-bar${recent ? " recent" : ""}" style="height:${h}px;background:${recent ? "var(--accent)" : "rgba(124,58,237,0.25)"}"></div>`);
  }
  return bars.join("");
}

function renderEventCard(event: NostrEvent): string {
  const initial = event.pubkey.charAt(0).toUpperCase();
  const kindTag = event.kind === 1 ? "note" : event.kind === 30023 ? "long-form" : `k:${event.kind}`;
  const kindClass = event.kind === 1 ? "ev-kind-note" : event.kind === 30023 ? "ev-kind-long" : "ev-kind-note";

  return `
    <div class="event-card">
      <div class="ev-avatar" style="background:${avatarGradient(event.pubkey)}">${initial}</div>
      <div class="ev-content">
        <div class="ev-meta">
          <span class="ev-npub">${shortPubkey(event.pubkey)}</span>
          <span class="ev-kind-tag ${kindClass}">${kindTag}</span>
          <span class="ev-time">${timeAgo(event.created_at)}</span>
        </div>
        <div class="ev-text">${escapeHtml(event.content.slice(0, 280))}${event.content.length > 280 ? "..." : ""}</div>
      </div>
    </div>
  `;
}

async function loadStats(): Promise<void> {
  try {
    const status = await invoke<AppStatus>("get_status");
    let uptime = 0;
    try { uptime = await invoke<number>("get_uptime"); } catch (_) {}

    const uptimeStr = uptime > 3600
      ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
      : uptime > 60 ? `${Math.floor(uptime / 60)}m` : `${uptime}s`;

    setTextContent("dash-events", status.events_stored.toLocaleString());
    setTextContent("dash-wot-peers", status.wot_nodes.toLocaleString());
    setTextContent("dash-media", "—");
    setTextContent("dash-sync-rate", status.sync_tier > 0 ? "~syncing" : "idle");
    setTextContent("dash-uptime", uptimeStr);

    // Relay badge
    const badge = document.getElementById("dash-relay-badge");
    if (badge) {
      if (status.relay_running) {
        badge.innerHTML = `<span class="status-dot"></span> Live`;
        badge.className = "status-badge live";
      } else {
        badge.innerHTML = `○ Offline`;
        badge.className = "status-badge offline";
      }
    }

    // Sync tiers
    const ct = status.sync_tier;
    for (let t = 1; t <= 4; t++) {
      const el = document.getElementById(`sync-tier-${t}-badge`);
      if (el) el.outerHTML = tierBadge(t, ct);
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
      if (el) el.textContent = details[t] || (t <= ct ? "complete" : "—");
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
        feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-dim);padding:32px;">No events yet — syncing will populate your feed.</div>`;
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

  container.style.padding = "0";
  container.style.display = "flex";
  container.style.flexDirection = "column";
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

    <!-- Activity chart -->
    <div class="dash-activity">
      <div class="dash-activity-label">Last 24h activity</div>
      <div class="dash-activity-bars">${generateActivityBars()}</div>
    </div>

    <!-- Body: feed + sidebar -->
    <div class="dash-body">
      <div class="dash-feed" id="dash-feed-list">
        <div class="event-card" style="justify-content:center;color:var(--text-dim);padding:32px;">Loading...</div>
      </div>
      <div class="dash-sidebar">
        <div class="sync-engine-header">Sync Engine</div>
        <div class="sync-tier" id="sync-tier-1">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 1 — Profile & Follows</span>
            <span class="sync-tier-badge idle" id="sync-tier-1-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-tier-1-detail">—</div>
        </div>
        <div class="sync-tier" id="sync-tier-2">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 2 — Recent Events</span>
            <span class="sync-tier-badge idle" id="sync-tier-2-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-tier-2-detail">—</div>
        </div>
        <div class="sync-tier" id="sync-tier-3">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 3 — WoT Crawl</span>
            <span class="sync-tier-badge idle" id="sync-tier-3-badge">IDLE</span>
          </div>
          <div class="sync-tier-detail" id="sync-tier-3-detail">—</div>
        </div>
        <div class="sync-tier dimmed" id="sync-tier-4">
          <div class="sync-tier-head">
            <span class="sync-tier-label">Tier 4 — Archive</span>
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

  await loadStats();
  await loadFeed();
  pollInterval = setInterval(() => { loadStats(); loadFeed(); }, 10000);
}
