/** Media URL extraction and viewer utilities */
import { iconX } from "./icons";

export interface MediaUrls {
  images: string[];
  videos: string[];
}

export interface MediaContext {
  eventId?: string;
  pubkey?: string;
  /** The original remote URL (before convertFileSrc) for bookmark storage */
  originalUrl?: string;
}

/**
 * Extract image and video URLs from event content.
 * Recognizes common image/video extensions and Nostr-specific CDNs.
 */
export function extractMediaUrls(content: string): MediaUrls {
  const urlRegex = /https?:\/\/[^\s<>"]+/gi;
  const urls = content.match(urlRegex) || [];
  const images: string[] = [];
  const videos: string[] = [];

  for (const url of urls) {
    const lower = url.toLowerCase();
    if (/\.(mp4|webm|mov)(\?|$)/.test(lower)) {
      videos.push(url);
    } else if (
      /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/.test(lower) ||
      /nostr\.build|void\.cat|blossom\.|media\.nostr\.band|imgproxy|primal\.net|nip\.media|sovbit\.host|satellite\.earth|snort\.social|nostpic\.com|stacker\.news\/uploads/.test(lower)
    ) {
      images.push(url);
    }
  }

  return { images, videos };
}

/** Strip media URLs from content text (so they don't appear as raw URLs alongside rendered images) */
export function stripMediaUrls(content: string): string {
  const { images, videos } = extractMediaUrls(content);
  const allUrls = [...images, ...videos];
  let cleaned = content;
  for (const url of allUrls) {
    cleaned = cleaned.replace(url, '');
  }
  // Also strip any remaining bare URLs that look like media (common CDN patterns)
  cleaned = cleaned.replace(/https?:\/\/\S+\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)(\?\S*)?/gi, '');
  return cleaned.trim();
}

/**
 * Render media HTML for an event card.
 * Accepts optional event context to attach to media elements for the viewer menu.
 * Returns empty string if no media found.
 */
export function renderMediaHtml(content: string, ctx?: MediaContext): string {
  const { images, videos } = extractMediaUrls(content);
  if (images.length === 0 && videos.length === 0) return "";

  const parts: string[] = [];
  const eidAttr = ctx?.eventId ? ` data-event-id="${ctx.eventId}"` : "";
  const pkAttr = ctx?.pubkey ? ` data-event-pubkey="${ctx.pubkey}"` : "";

  for (const url of images) {
    const safeUrl = url.replace(/'/g, "\\'");
    parts.push(
      `<img class="ev-media-img" src="${url}" loading="lazy" onerror="this.style.display='none'" data-media-url="${safeUrl}" data-original-url="${safeUrl}"${eidAttr}${pkAttr} style="cursor:pointer">`
    );
  }

  for (const url of videos) {
    const safeUrl = url.replace(/'/g, "\\'");
    parts.push(
      `<video class="ev-media-video" src="${url}" controls preload="metadata" data-media-url="${safeUrl}" data-media-type="video" data-original-url="${safeUrl}"${eidAttr}${pkAttr} style="cursor:pointer"></video>`
    );
  }

  return `<div class="ev-media">${parts.join("")}</div>`;
}

/* ── SVG icon strings for the viewer (inline, no React) ────────── */

const iconMoreVert = () =>
  `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;

const iconBookmark = () =>
  `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;

const iconBookmarkFilled = () =>
  `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;

const iconEye = () =>
  `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;

/**
 * Initialize the media viewer (lightbox) overlay.
 * Supports both images and videos. Call once on app startup.
 * Includes a three-dots menu for "View Event" and "Bookmark".
 */
export function initMediaViewer(): void {
  if (document.getElementById("media-viewer")) return;

  /* --- inject styles -------------------------------------------------- */
  const style = document.createElement("style");
  style.textContent = `
    #media-viewer {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.92);
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    #media-viewer-img,
    #media-viewer-video {
      max-width: 90vw;
      max-height: 90vh;
      object-fit: contain;
      border-radius: 8px;
      cursor: default;
    }
    #media-viewer-close {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      font-size: 1.2rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
      z-index: 1;
    }
    #media-viewer-close:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    #media-viewer-menu-btn {
      position: absolute;
      top: 16px;
      right: 64px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
      z-index: 1;
    }
    #media-viewer-menu-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    #media-viewer-menu {
      position: absolute;
      top: 58px;
      right: 64px;
      background: var(--bg-card, #1e1e2e);
      border: 1px solid var(--border, rgba(255,255,255,0.12));
      border-radius: 8px;
      min-width: 180px;
      padding: 4px 0;
      display: none;
      flex-direction: column;
      z-index: 2;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    #media-viewer-menu.open { display: flex; }
    .mv-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      color: var(--text, #cdd6f4);
      font-size: 0.85rem;
      background: none;
      border: none;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 0.15s;
    }
    .mv-menu-item:hover { background: rgba(255,255,255,0.08); }
    .mv-menu-item .icon { width: 18px; height: 18px; flex-shrink: 0; }
    .mv-menu-item.disabled {
      opacity: 0.4;
      cursor: default;
    }
    .mv-menu-item.bookmarked { color: var(--accent, #f9e2af); }
    .mv-menu-sep {
      height: 1px;
      background: var(--border, rgba(255,255,255,0.08));
      margin: 4px 0;
    }
  `;
  document.head.appendChild(style);

  /* --- build DOM ------------------------------------------------------ */
  const viewer = document.createElement("div");
  viewer.id = "media-viewer";
  viewer.innerHTML = `
    <img id="media-viewer-img" style="display:none">
    <video id="media-viewer-video" style="display:none" controls></video>
    <button id="media-viewer-menu-btn" title="Options">${iconMoreVert()}</button>
    <div id="media-viewer-menu">
      <button class="mv-menu-item" id="mv-view-event">${iconEye()}<span>View Event</span></button>
      <div class="mv-menu-sep"></div>
      <button class="mv-menu-item" id="mv-bookmark">${iconBookmark()}<span>Bookmark</span></button>
    </div>
    <button id="media-viewer-close"><span class="icon">${iconX()}</span></button>
  `;
  document.body.appendChild(viewer);

  const imgEl = viewer.querySelector("#media-viewer-img") as HTMLImageElement;
  const videoEl = viewer.querySelector("#media-viewer-video") as HTMLVideoElement;
  const menuBtn = viewer.querySelector("#media-viewer-menu-btn") as HTMLButtonElement;
  const menu = viewer.querySelector("#media-viewer-menu") as HTMLDivElement;
  const viewEventBtn = viewer.querySelector("#mv-view-event") as HTMLButtonElement;
  const bookmarkBtn = viewer.querySelector("#mv-bookmark") as HTMLButtonElement;

  /* --- current context ------------------------------------------------ */
  let currentOriginalUrl = "";
  let currentEventId = "";
  let currentPubkey = "";
  let isBookmarked = false;

  /* --- helpers -------------------------------------------------------- */
  function isVideoUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return /\.(mp4|webm|mov)(\?|$)/.test(lower);
  }

  function closeMenu(): void {
    menu.classList.remove("open");
  }

  function updateBookmarkBtn(): void {
    const iconSpan = bookmarkBtn.querySelector(".icon") as HTMLElement;
    const labelSpan = bookmarkBtn.querySelector("span:last-child") as HTMLElement;
    if (isBookmarked) {
      bookmarkBtn.classList.add("bookmarked");
      if (iconSpan) iconSpan.outerHTML = iconBookmarkFilled();
      if (labelSpan) labelSpan.textContent = "Bookmarked";
    } else {
      bookmarkBtn.classList.remove("bookmarked");
      if (iconSpan) iconSpan.outerHTML = iconBookmark();
      if (labelSpan) labelSpan.textContent = "Bookmark";
    }
  }

  async function checkBookmarkStatus(): Promise<void> {
    if (!currentEventId || !currentOriginalUrl) {
      isBookmarked = false;
      updateBookmarkBtn();
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      isBookmarked = await invoke<boolean>("is_media_bookmarked", {
        eventId: currentEventId,
        mediaUrl: currentOriginalUrl,
      });
    } catch {
      isBookmarked = false;
    }
    updateBookmarkBtn();
  }

  /** Resolve event context if we only have a URL (e.g. from media grids without event_id) */
  async function resolveEventContext(): Promise<void> {
    if (currentEventId) return;
    if (!currentOriginalUrl) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const event = await invoke<any>("find_event_for_media", {
        mediaUrl: currentOriginalUrl,
        pubkey: currentPubkey || null,
      });
      if (event) {
        currentEventId = event.id;
        currentPubkey = event.pubkey;
      }
    } catch {
      // silent — event lookup is best-effort
    }
  }

  function showMedia(
    url: string,
    type?: "image" | "video",
    context?: MediaContext,
  ): void {
    const isVideo = type === "video" || (!type && isVideoUrl(url));
    if (isVideo) {
      imgEl.style.display = "none";
      imgEl.removeAttribute("src");
      videoEl.src = url;
      videoEl.style.display = "block";
    } else {
      videoEl.style.display = "none";
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
      imgEl.src = url;
      imgEl.style.display = "block";
    }

    currentOriginalUrl = context?.originalUrl || url;
    currentEventId = context?.eventId || "";
    currentPubkey = context?.pubkey || "";
    isBookmarked = false;
    updateBookmarkBtn();

    console.log("[media-viewer] open:", { currentEventId, currentPubkey, currentOriginalUrl });

    // Update button states
    viewEventBtn.classList.toggle("disabled", !currentEventId);
    bookmarkBtn.classList.toggle("disabled", !currentEventId);

    viewer.style.display = "flex";
    closeMenu();

    // Async: resolve event if needed, then check bookmark
    resolveEventContext().then(() => {
      console.log("[media-viewer] resolved:", { currentEventId, currentPubkey });
      viewEventBtn.classList.toggle("disabled", !currentEventId);
      bookmarkBtn.classList.toggle("disabled", !currentEventId);
      checkBookmarkStatus();
    });
  }

  function closeViewer(): void {
    viewer.style.display = "none";
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
    imgEl.removeAttribute("src");
    closeMenu();
    currentOriginalUrl = "";
    currentEventId = "";
    currentPubkey = "";
  }

  /* --- event listeners ------------------------------------------------ */

  // Close on backdrop click
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeViewer();
  });

  // Close button
  viewer.querySelector("#media-viewer-close")?.addEventListener("click", closeViewer);

  // ESC key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && viewer.style.display === "flex") {
      closeViewer();
    }
  });

  // Menu toggle
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  // Close menu on outside click
  viewer.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#media-viewer-menu") &&
        !(e.target as HTMLElement).closest("#media-viewer-menu-btn")) {
      closeMenu();
    }
  });

  // View Event action
  viewEventBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const eid = currentEventId;
    console.log("[media-viewer] View Event clicked, eventId:", eid);
    if (!eid) return;
    closeViewer();
    window.dispatchEvent(new CustomEvent("navigate-to-note", { detail: { noteId: eid } }));
  });

  // Bookmark action
  bookmarkBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const eid = currentEventId;
    const murl = currentOriginalUrl;
    console.log("[media-viewer] Bookmark clicked, eventId:", eid, "url:", murl);
    if (!eid || !murl) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (isBookmarked) {
        await invoke("unbookmark_media", { eventId: eid, mediaUrl: murl });
        isBookmarked = false;
      } else {
        await invoke("bookmark_media", { eventId: eid, mediaUrl: murl });
        isBookmarked = true;
      }
      updateBookmarkBtn();
    } catch (err) {
      console.error("[media-viewer] bookmark failed:", err);
    }
    closeMenu();
  });

  // Event delegation for [data-media-url] clicks
  document.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-media-url]") as HTMLElement | null;
    if (!target) return;
    const url = target.dataset.mediaUrl;
    if (!url) return;
    const type = target.dataset.mediaType as "image" | "video" | undefined;
    const context: MediaContext = {
      eventId: target.dataset.eventId,
      pubkey: target.dataset.eventPubkey,
      originalUrl: target.dataset.originalUrl || url,
    };
    showMedia(url, type, context);
  });

  // Expose global openMediaViewer for imperative calls (ProfileView, MyMedia grids)
  (window as any).openMediaViewer = showMedia;
}
