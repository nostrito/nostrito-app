/** Feed — event feed with filter tabs, matching reference design */

import { invoke } from "@tauri-apps/api/core";

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

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
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function kindLabel(kind: number): { tag: string; cls: string } {
  switch (kind) {
    case 1: return { tag: "note", cls: "ev-kind-note" };
    case 6: return { tag: "repost", cls: "ev-kind-repost" };
    case 7: return { tag: "reaction", cls: "ev-kind-note" };
    case 30023: return { tag: "long-form", cls: "ev-kind-long" };
    default: return { tag: `kind ${kind}`, cls: "ev-kind-note" };
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderEventCard(event: NostrEvent): string {
  const initial = event.pubkey.charAt(0).toUpperCase();
  const kl = kindLabel(event.kind);
  return `
    <div class="event-card" data-kind="${event.kind}">
      <div class="ev-avatar" style="background:${avatarGradient(event.pubkey)}">${initial}</div>
      <div class="ev-content">
        <div class="ev-meta">
          <span class="ev-npub">${shortPubkey(event.pubkey)}</span>
          <span class="ev-kind-tag ${kl.cls}">${kl.tag}</span>
          <span class="ev-time">${timeAgo(event.created_at)}</span>
        </div>
        <div class="ev-text">${escapeHtml(event.content.slice(0, 400))}${event.content.length > 400 ? "..." : ""}</div>
        <div class="ev-actions">
          <button class="ev-action"><span class="icon">💬</span></button>
          <button class="ev-action"><span class="icon">🔁</span></button>
          <button class="ev-action"><span class="icon">⚡</span></button>
        </div>
      </div>
    </div>
  `;
}

type FilterKey = "all" | "note" | "long" | "repost";

const FILTER_KINDS: Record<FilterKey, number[] | undefined> = {
  all: undefined,
  note: [1],
  long: [30023],
  repost: [6],
};

let activeFilter: FilterKey = "all";

async function loadFeed(container: HTMLElement): Promise<void> {
  const listEl = container.querySelector("#feed-list") as HTMLElement;
  if (!listEl) return;

  try {
    const kinds = FILTER_KINDS[activeFilter];
    const events = await invoke<NostrEvent[]>("get_feed", {
      filter: { kinds, limit: 50 },
    });

    if (events.length === 0) {
      listEl.innerHTML = `
        <div style="text-align:center;color:var(--text-dim);padding:48px;">
          No events yet. Start syncing to populate your feed.
        </div>
      `;
    } else {
      listEl.innerHTML = events.map(renderEventCard).join("");
    }
  } catch (e) {
    listEl.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:48px;">Failed to load feed.</div>`;
    console.error("[feed]", e);
  }
}

export function renderFeed(container: HTMLElement): void {
  container.style.padding = "0";
  container.innerHTML = `
    <div class="feed-filters">
      <div class="feed-filter active" data-filter="all">All</div>
      <div class="feed-filter" data-filter="note">Notes</div>
      <div class="feed-filter" data-filter="long">Long-form</div>
      <div class="feed-filter" data-filter="repost">Reposts</div>
    </div>
    <div id="feed-list" style="overflow-y:auto;flex:1;">
      <div style="text-align:center;color:var(--text-dim);padding:48px;">Loading...</div>
    </div>
  `;

  // Wire filter tabs
  container.querySelectorAll(".feed-filter").forEach((tab) => {
    tab.addEventListener("click", () => {
      container.querySelectorAll(".feed-filter").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeFilter = (tab as HTMLElement).dataset.filter as FilterKey;
      loadFeed(container);
    });
  });

  loadFeed(container);
}
