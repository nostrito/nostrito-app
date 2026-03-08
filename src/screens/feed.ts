/** Feed — event feed view matching the landing page demo */

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
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function kindLabel(kind: number): { tag: string; cls: string } {
  switch (kind) {
    case 1: return { tag: "note", cls: "ev-kind-note" };
    case 6: return { tag: "repost", cls: "ev-kind-repost" };
    case 30023: return { tag: "long-form", cls: "ev-kind-long" };
    default: return { tag: `k:${kind}`, cls: "ev-kind-note" };
  }
}

function renderEventCard(event: NostrEvent): string {
  const initial = event.pubkey.charAt(0).toUpperCase();
  const k = kindLabel(event.kind);
  const hop = Math.random() > 0.5 ? 1 : 2;

  return `
    <div class="event-card" data-kind="${k.tag}">
      <div class="ev-avatar ${avatarClass(event.pubkey)}">${initial}</div>
      <div class="ev-content">
        <div class="ev-meta">
          <span class="ev-npub">${shortPubkey(event.pubkey)}</span>
          <span class="wot-hop-badge wot-hop-${hop}">${hop}-hop</span>
          <span class="ev-kind-tag ${k.cls}">${k.tag}</span>
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

export function renderFeed(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="feed-filters">
      <div class="feed-filter active" data-filter="all">All</div>
      <div class="feed-filter" data-filter="note">Notes</div>
      <div class="feed-filter" data-filter="long-form">Long-form</div>
      <div class="feed-filter" data-filter="repost">Reposts</div>
    </div>
    <div id="feedList">
      <div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">Loading events...</div>
    </div>
  `;

  // Wire filters
  const filters = container.querySelectorAll(".feed-filter");
  filters.forEach(f => {
    f.addEventListener("click", () => {
      const filter = (f as HTMLElement).dataset.filter!;
      filters.forEach(el => el.classList.remove("active"));
      f.classList.add("active");
      const items = container.querySelectorAll("#feedList .event-card[data-kind]");
      items.forEach(item => {
        if (filter === "all") {
          (item as HTMLElement).style.display = "flex";
        } else {
          (item as HTMLElement).style.display = (item as HTMLElement).dataset.kind === filter ? "flex" : "none";
        }
      });
    });
  });

  // Load events
  loadEvents(container);
}

async function loadEvents(container: HTMLElement): Promise<void> {
  try {
    const events = await invoke<NostrEvent[]>("get_feed", { filter: { limit: 50 } });
    const feedEl = container.querySelector("#feedList");
    if (feedEl) {
      if (events.length === 0) {
        feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">No events yet — syncing will populate your feed.</div>`;
      } else {
        feedEl.innerHTML = events.map(renderEventCard).join("");
      }
    }
  } catch (_) {
    // Silently fail — will show placeholder
  }
}
