/** Feed — event feed view. All data from get_feed backend command. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getProfiles, profileDisplayName, type ProfileInfo } from "../utils/profiles";
import { renderMediaHtml, stripMediaUrls, initMediaViewer } from "../utils/media";
import { renderMarkdown } from "../utils/markdown";
import { iconMessageCircle, iconRepeat, iconZap, iconX } from "../utils/icons";

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


function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
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

/** Kinds that belong in the feed — content only, no metadata */
const FEED_KINDS = [1, 6, 30023];

// ── NIP-23 tag helpers ──────────────────────────────────────

function getTagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag && tag.length > 1 ? tag[1] : null;
}

function getArticleTitle(event: NostrEvent): string {
  return getTagValue(event.tags, "title") || "Untitled";
}

function getArticleSummary(event: NostrEvent): string {
  const summary = getTagValue(event.tags, "summary");
  if (summary) return summary.length > 200 ? summary.slice(0, 200) + "…" : summary;
  // Fallback: first ~150 chars of content, stripped of markdown syntax
  const plain = event.content
    .replace(/^#+\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[.*?\]\(.*?\)/g, "")
    .trim();
  return plain.length > 150 ? plain.slice(0, 150) + "…" : plain;
}

function getArticleImage(event: NostrEvent): string | null {
  return getTagValue(event.tags, "image");
}

function getArticleTimestamp(event: NostrEvent): number {
  const published = getTagValue(event.tags, "published_at");
  if (published) {
    const ts = parseInt(published, 10);
    if (!isNaN(ts)) return ts;
  }
  return event.created_at;
}

// ── Repost helpers ──────────────────────────────────────────

function parseRepostContent(event: NostrEvent): { content: string; pubkey: string } | null {
  if (event.kind !== 6 || !event.content.trim()) return null;
  try {
    const original = JSON.parse(event.content);
    if (original && typeof original.content === "string" && original.content.trim()) {
      return { content: original.content, pubkey: original.pubkey || event.pubkey };
    }
  } catch {
    // Not valid JSON — skip
  }
  return null;
}

function renderEventContent(content: string): { cleaned: string; mediaHtml: string } {
  const mediaHtml = renderMediaHtml(content);
  const cleaned = stripMediaUrls(content).slice(0, 280);
  return { cleaned, mediaHtml };
}

// ── Article Card (kind:30023) ───────────────────────────────

function renderArticleCard(event: NostrEvent, profile?: ProfileInfo): string {
  const title = getArticleTitle(event);
  const summary = getArticleSummary(event);
  const image = getArticleImage(event);
  const ts = getArticleTimestamp(event);
  const displayName = profileDisplayName(profile, event.pubkey);
  const initial = event.pubkey.charAt(0).toUpperCase();

  const coverHtml = image
    ? `<div class="article-card-cover"><img src="${escapeHtml(image)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'" /></div>`
    : "";

  const avatarHtml = profile?.picture
    ? `<img src="${escapeHtml(profile.picture)}" class="article-card-avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="article-card-avatar article-card-avatar-fallback ${avatarClass(event.pubkey)}" style="display:none">${initial}</div>`
    : `<div class="article-card-avatar article-card-avatar-fallback ${avatarClass(event.pubkey)}">${initial}</div>`;

  return `
    <div class="article-card" data-kind="long-form" data-event-id="${event.id}">
      ${coverHtml}
      <div class="article-card-body">
        <div class="article-card-title">${escapeHtml(title)}</div>
        <div class="article-card-summary">${escapeHtml(summary)}</div>
        <div class="article-card-footer">
          <div class="article-card-author">
            ${avatarHtml}
            <span class="article-card-author-name">${escapeHtml(displayName)}</span>
          </div>
          <span class="article-card-date">${formatDate(ts)}</span>
        </div>
      </div>
    </div>
  `;
}

// ── Note/Repost Card (kind:1, kind:6) ──────────────────────

function renderEventCard(event: NostrEvent, profile?: ProfileInfo): string {
  const initial = event.pubkey.charAt(0).toUpperCase();
  const k = kindLabel(event.kind);
  const displayName = profileDisplayName(profile, event.pubkey);

  // Handle kind:6 reposts — show original content or skip if empty
  if (event.kind === 6) {
    const original = parseRepostContent(event);
    if (!original) return ""; // Empty repost, skip it

    const avatarHtml = profile?.picture
      ? `<img src="${escapeHtml(profile.picture)}" class="ev-avatar ev-avatar-img" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="ev-avatar ${avatarClass(event.pubkey)}" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer;display:none">${initial}</div>`
      : `<div class="ev-avatar ${avatarClass(event.pubkey)}" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer">${initial}</div>`;

    const repostContent = renderEventContent(original.content);

    return `
      <div class="event-card" data-kind="${k.tag}">
        ${avatarHtml}
        <div class="ev-content">
          <div class="ev-meta">
            <span class="ev-npub" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer">${escapeHtml(displayName)}</span>
            <span class="ev-kind-tag ${k.cls}"><span class="icon">${iconRepeat()}</span> repost</span>
            <span class="ev-time">${timeAgo(event.created_at)}</span>
          </div>
          <div class="ev-text">${escapeHtml(repostContent.cleaned)}</div>
          ${repostContent.mediaHtml}
          <div class="ev-actions">
            <button class="ev-action"><span class="icon">${iconMessageCircle()}</span> 0</button>
            <button class="ev-action"><span class="icon">${iconRepeat()}</span> 0</button>
            <button class="ev-action"><span class="icon">${iconZap()}</span> 0</button>
          </div>
        </div>
      </div>
    `;
  }

  const avatarHtml = profile?.picture
    ? `<img src="${escapeHtml(profile.picture)}" class="ev-avatar ev-avatar-img" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="ev-avatar ${avatarClass(event.pubkey)}" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer;display:none">${initial}</div>`
    : `<div class="ev-avatar ${avatarClass(event.pubkey)}" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer">${initial}</div>`;

  const eventContent = renderEventContent(event.content);

  return `
    <div class="event-card" data-kind="${k.tag}">
      ${avatarHtml}
      <div class="ev-content">
        <div class="ev-meta">
          <span class="ev-npub" onclick="window.showProfilePopup('${event.pubkey}')" style="cursor:pointer">${escapeHtml(displayName)}</span>
          <span class="ev-kind-tag ${k.cls}">${k.tag}</span>
          <span class="ev-time">${timeAgo(event.created_at)}</span>
        </div>
        <div class="ev-text">${escapeHtml(eventContent.cleaned)}</div>
        ${eventContent.mediaHtml}
        <div class="ev-actions">
          <button class="ev-action"><span class="icon">${iconMessageCircle()}</span> 0</button>
          <button class="ev-action"><span class="icon">${iconRepeat()}</span> 0</button>
          <button class="ev-action"><span class="icon">${iconZap()}</span> 0</button>
        </div>
      </div>
    </div>
  `;
}

// ── Article Reader View ─────────────────────────────────────

function openArticleReader(event: NostrEvent, profile?: ProfileInfo): void {
  const container = document.getElementById("main-content");
  if (!container) return;

  const title = getArticleTitle(event);
  const ts = getArticleTimestamp(event);
  const displayName = profileDisplayName(profile, event.pubkey);
  const initial = event.pubkey.charAt(0).toUpperCase();
  const image = getArticleImage(event);

  const avatarHtml = profile?.picture
    ? `<img src="${escapeHtml(profile.picture)}" class="reader-author-avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="reader-author-avatar reader-author-avatar-fallback ${avatarClass(event.pubkey)}" style="display:none">${initial}</div>`
    : `<div class="reader-author-avatar reader-author-avatar-fallback ${avatarClass(event.pubkey)}">${initial}</div>`;

  const coverHtml = image
    ? `<div class="reader-cover"><img src="${escapeHtml(image)}" alt="" loading="lazy" /></div>`
    : "";

  const renderedContent = renderMarkdown(event.content);

  container.innerHTML = `
    <div class="article-reader">
      <div class="reader-header">
        <button class="reader-back-btn" id="reader-back">← Back to feed</button>
      </div>
      <article class="reader-article">
        ${coverHtml}
        <h1 class="reader-title">${escapeHtml(title)}</h1>
        <div class="reader-meta">
          <div class="reader-author">
            ${avatarHtml}
            <span class="reader-author-name">${escapeHtml(displayName)}</span>
          </div>
          <span class="reader-date">${formatDate(ts)}</span>
        </div>
        <div class="reader-content">${renderedContent}</div>
      </article>
    </div>
  `;

  document.getElementById("reader-back")?.addEventListener("click", () => {
    renderFeed(container);
  });
}

// ── Feed State ──────────────────────────────────────────────

let feedLoading = false;
const renderedEventIds = new Set<string>();
let feedEvents: NostrEvent[] = [];
let feedProfileMap: Map<string, ProfileInfo> = new Map();
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let feedRefreshInterval: ReturnType<typeof setInterval> | null = null;
let unlistenTierComplete: UnlistenFn | null = null;

/** Resolve NIP-05 identifier (name@domain) to hex pubkey */
async function resolveNip05(nip05: string): Promise<string | null> {
  const parts = nip05.split("@");
  if (parts.length !== 2) return null;
  const [name, domain] = parts;
  try {
    const resp = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const pubkey = data?.names?.[name];
    return typeof pubkey === "string" ? pubkey : null;
  } catch {
    return null;
  }
}

/** Check if input looks like a NIP-05 identifier */
function isNip05(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input);
}

/** Clean up feed refresh timers and listeners */
export function cleanupFeed(): void {
  if (feedRefreshInterval) { clearInterval(feedRefreshInterval); feedRefreshInterval = null; }
  if (unlistenTierComplete) { unlistenTierComplete(); unlistenTierComplete = null; }
}

export function renderFeed(container: HTMLElement): void {
  cleanupFeed();
  renderedEventIds.clear();

  initMediaViewer();
  container.className = "main-content";
  container.innerHTML = `
    <div class="feed-header-row">
      <div class="feed-filters">
        <div class="feed-filter active" data-filter="all">All</div>
        <div class="feed-filter" data-filter="note">Notes</div>
        <div class="feed-filter" data-filter="long-form">Long-form</div>
        <div class="feed-filter" data-filter="repost">Reposts</div>
      </div>
      <div class="feed-search-wrap">
        <input type="text" class="feed-search-input" placeholder="Search notes, npub, name@domain…" id="feed-search" />
        <button class="feed-search-clear" id="feed-search-clear" style="display:none"><span class="icon">${iconX()}</span></button>
      </div>
    </div>
    <div id="feed-search-status" class="feed-search-status" style="display:none"></div>
    <div id="feedList">
      <div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">Loading events...</div>
    </div>
  `;

  // Wire filters
  const filters = container.querySelectorAll(".feed-filter");
  filters.forEach((f) => {
    f.addEventListener("click", () => {
      const filter = (f as HTMLElement).dataset.filter!;
      filters.forEach((el) => el.classList.remove("active"));
      f.classList.add("active");

      const feedEl = container.querySelector("#feedList");
      if (!feedEl) return;

      // Select both regular event-cards and article-cards
      const items = feedEl.querySelectorAll("[data-kind]");
      items.forEach((item) => {
        if (filter === "all") {
          (item as HTMLElement).style.display = "";
        } else {
          (item as HTMLElement).style.display =
            (item as HTMLElement).dataset.kind === filter ? "" : "none";
        }
      });

      // Toggle article grid wrapper visibility
      const articleGrid = feedEl.querySelector(".article-cards-grid") as HTMLElement;
      if (articleGrid) {
        if (filter === "note" || filter === "repost") {
          articleGrid.style.display = "none";
        } else {
          articleGrid.style.display = "";
          // Also apply individual card visibility within grid
          const cards = articleGrid.querySelectorAll("[data-kind]");
          cards.forEach((c) => {
            (c as HTMLElement).style.display = "";
          });
        }
      }
    });
  });

  // Wire search input
  const searchInput = container.querySelector("#feed-search") as HTMLInputElement;
  const searchClear = container.querySelector("#feed-search-clear") as HTMLButtonElement;
  const searchStatus = container.querySelector("#feed-search-status") as HTMLElement;

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const val = searchInput.value.trim();
      searchClear.style.display = val ? "flex" : "none";

      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

      if (!val) {
        // Revert to normal feed
      
        searchStatus.style.display = "none";
        renderedEventIds.clear();
        const feedEl = container.querySelector("#feedList");
        if (feedEl) feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">Loading events...</div>`;
        loadEvents(container);
        return;
      }

      searchDebounceTimer = setTimeout(() => {
        performSearch(val, container);
      }, 300);
    });

    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      searchClear.style.display = "none";
    
      searchStatus.style.display = "none";
      renderedEventIds.clear();
      const feedEl = container.querySelector("#feedList");
      if (feedEl) feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">Loading events...</div>`;
      loadEvents(container);
    });
  }

  loadEvents(container);

  // Refresh feed when sync completes a tier (new events likely stored)
  listen<{ tier: number }>("sync:tier_complete", () => {
    loadEvents(container);
  }).then((unlisten) => { unlistenTierComplete = unlisten; });

  // Also refresh on a 30s cadence as a fallback
  feedRefreshInterval = setInterval(() => {
    loadEvents(container);
  }, 30000);
}

async function performSearch(query: string, container: HTMLElement): Promise<void> {
  const searchStatus = container.querySelector("#feed-search-status") as HTMLElement;
  const feedEl = container.querySelector("#feedList");
  if (!feedEl) return;


  searchStatus.style.display = "block";
  searchStatus.textContent = "Searching…";

  let searchQuery = query;

  // NIP-05 resolution
  if (isNip05(query)) {
    searchStatus.textContent = `Resolving ${query}…`;
    const resolved = await resolveNip05(query);
    if (resolved) {
      searchQuery = resolved; // Use hex pubkey
    } else {
      searchStatus.textContent = `Could not resolve ${query}`;
      feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">No results — NIP-05 resolution failed</div>`;
      return;
    }
  }

  try {
    const results = await invoke<NostrEvent[]>("search_events", { query: searchQuery, limit: 50 });

    searchStatus.textContent = `${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"`;

    if (results.length === 0) {
      feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">No events found</div>`;
      return;
    }

    const pubkeys = [...new Set(results.map((e) => e.pubkey))];
    const profileMap = await getProfiles(pubkeys);
    feedProfileMap = profileMap;

    const articles = results.filter((e) => e.kind === 30023);
    const notes = results.filter((e) => e.kind !== 30023);

    feedEvents = [...results];

    let html = "";

    if (articles.length > 0) {
      html += `<div class="article-cards-grid">`;
      html += articles.map((e) => renderArticleCard(e, profileMap.get(e.pubkey))).join("");
      html += `</div>`;
    }

    html += notes
      .map((e) => renderEventCard(e, profileMap.get(e.pubkey)))
      .filter((h) => h.trim() !== "")
      .join("");

    feedEl.innerHTML = html;

    // Wire article click handlers
    feedEl.querySelectorAll(".article-card").forEach((card) => {
      card.addEventListener("click", () => {
        const eventId = (card as HTMLElement).dataset.eventId;
        const event = feedEvents.find((e) => e.id === eventId);
        if (event) openArticleReader(event, feedProfileMap.get(event.pubkey));
      });
    });
  } catch (err) {
    searchStatus.textContent = "Search failed";
    feedEl.innerHTML = `<div class="event-card" style="justify-content:center;color:var(--text-muted);padding:32px;">Search error</div>`;
  }
}

async function loadEvents(container: HTMLElement): Promise<void> {
  if (feedLoading) return;
  feedLoading = true;
  try {
    // Fetch notes/reposts and long-form articles separately so articles
    // aren't buried by the much larger volume of kind:1 notes.
    const [rawNotes, rawArticles] = await Promise.all([
      invoke<NostrEvent[]>("get_feed", { filter: { kinds: [1, 6], limit: 50 } }),
      invoke<NostrEvent[]>("get_feed", { filter: { kinds: [30023], limit: 20 } }),
    ]);
    const rawEvents = [...rawArticles, ...rawNotes];
    const kindFiltered = rawEvents.filter((e) => FEED_KINDS.includes(e.kind));
    const newEvents = kindFiltered.filter((e) => !renderedEventIds.has(e.id));
    if (newEvents.length === 0) return;

    const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
    const profileMap = await getProfiles(pubkeys);
    feedProfileMap = profileMap;

    const feedEl = container.querySelector("#feedList");
    if (!feedEl) return;

    // Remove loading placeholder if present
    const placeholder = feedEl.querySelector('.event-card:not([data-kind])');
    if (placeholder) placeholder.remove();

    // Separate long-form articles from notes/reposts
    const articles = newEvents.filter((e) => e.kind === 30023);
    const notes = newEvents.filter((e) => e.kind !== 30023);

    // Store events for reader view access
    feedEvents = [...articles, ...feedEvents.filter((e) => !articles.find((a) => a.id === e.id))];
    for (const e of notes) {
      if (!feedEvents.find((fe) => fe.id === e.id)) feedEvents.push(e);
    }

    // Render article cards in a grid section at the top
    if (articles.length > 0) {
      let articleGrid = feedEl.querySelector(".article-cards-grid");
      if (!articleGrid) {
        const gridWrapper = document.createElement("div");
        gridWrapper.className = "article-cards-grid";
        feedEl.prepend(gridWrapper);
        articleGrid = gridWrapper;
      }

      const articleHtml = articles
        .map((e) => {
          renderedEventIds.add(e.id);
          return renderArticleCard(e, profileMap.get(e.pubkey));
        })
        .join("");

      articleGrid.insertAdjacentHTML("afterbegin", articleHtml);

      // Wire click handlers for article cards
      articleGrid.querySelectorAll(".article-card").forEach((card) => {
        card.addEventListener("click", () => {
          const eventId = (card as HTMLElement).dataset.eventId;
          const event = feedEvents.find((e) => e.id === eventId);
          if (event) {
            openArticleReader(event, feedProfileMap.get(event.pubkey));
          }
        });
      });
    }

    // Render notes/reposts below
    const noteHtml = notes
      .map((e) => { renderedEventIds.add(e.id); return renderEventCard(e, profileMap.get(e.pubkey)); })
      .filter((h) => h.trim() !== '')
      .join('');

    if (noteHtml) {
      // Insert after article grid if present, otherwise at top
      const articleGrid = feedEl.querySelector(".article-cards-grid");
      if (articleGrid) {
        articleGrid.insertAdjacentHTML("afterend", noteHtml);
      } else {
        feedEl.insertAdjacentHTML('afterbegin', noteHtml);
      }
    }

    // Cap at 100 note items to avoid memory bloat
    const allCards = feedEl.querySelectorAll('.event-card[data-kind]');
    if (allCards.length > 100) {
      for (let i = 100; i < allCards.length; i++) {
        allCards[i].remove();
      }
    }
  } catch (_) {
  } finally {
    feedLoading = false;
  }
}
