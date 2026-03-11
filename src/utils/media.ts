/** Media URL extraction and viewer utilities */
import { iconX } from "./icons";

export interface MediaUrls {
  images: string[];
  videos: string[];
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
 * Returns empty string if no media found.
 */
export function renderMediaHtml(content: string): string {
  const { images, videos } = extractMediaUrls(content);
  if (images.length === 0 && videos.length === 0) return "";

  const parts: string[] = [];

  for (const url of images) {
    // Escape single quotes in URL for onclick
    const safeUrl = url.replace(/'/g, "\\'");
    parts.push(
      `<img class="ev-media-img" src="${url}" loading="lazy" onerror="this.style.display='none'" data-media-url="${safeUrl}" style="cursor:pointer">`
    );
  }

  for (const url of videos) {
    parts.push(
      `<video class="ev-media-video" src="${url}" controls preload="metadata"></video>`
    );
  }

  return `<div class="ev-media">${parts.join("")}</div>`;
}

/**
 * Initialize the media viewer (lightbox) overlay.
 * Call once on app startup.
 */
export function initMediaViewer(): void {
  if (document.getElementById("media-viewer")) return;

  const viewer = document.createElement("div");
  viewer.id = "media-viewer";
  viewer.innerHTML = `
    <img id="media-viewer-img">
    <button id="media-viewer-close"><span class="icon">${iconX()}</span></button>
  `;
  document.body.appendChild(viewer);

  // Close on backdrop click
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) {
      viewer.style.display = "none";
    }
  });

  // Close button
  viewer.querySelector("#media-viewer-close")?.addEventListener("click", () => {
    viewer.style.display = "none";
  });

  // ESC key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && viewer.style.display === "flex") {
      viewer.style.display = "none";
    }
  });

  // Event delegation for [data-media-url] clicks (replaces window global)
  document.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-media-url]") as HTMLElement | null;
    if (!target) return;
    const url = target.dataset.mediaUrl;
    if (!url) return;
    const img = document.getElementById("media-viewer-img") as HTMLImageElement;
    if (img) img.src = url;
    viewer.style.display = "flex";
  });

  // Expose global openMediaViewer for imperative calls (ProfileView, MyMedia grids)
  (window as any).openMediaViewer = (url: string) => {
    const img = document.getElementById("media-viewer-img") as HTMLImageElement;
    if (img) img.src = url;
    viewer.style.display = "flex";
  };
}
