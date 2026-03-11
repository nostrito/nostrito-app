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
 * Supports both images and videos. Call once on app startup.
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
  `;
  document.head.appendChild(style);

  /* --- build DOM ------------------------------------------------------ */
  const viewer = document.createElement("div");
  viewer.id = "media-viewer";
  viewer.innerHTML = `
    <img id="media-viewer-img" style="display:none">
    <video id="media-viewer-video" style="display:none" controls></video>
    <button id="media-viewer-close"><span class="icon">${iconX()}</span></button>
  `;
  document.body.appendChild(viewer);

  const imgEl = viewer.querySelector("#media-viewer-img") as HTMLImageElement;
  const videoEl = viewer.querySelector("#media-viewer-video") as HTMLVideoElement;

  /* --- helpers -------------------------------------------------------- */
  function isVideoUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return /\.(mp4|webm|mov)(\?|$)/.test(lower);
  }

  function showMedia(url: string, type?: "image" | "video"): void {
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
    viewer.style.display = "flex";
  }

  function closeViewer(): void {
    viewer.style.display = "none";
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
    imgEl.removeAttribute("src");
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

  // Event delegation for [data-media-url] clicks
  document.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-media-url]") as HTMLElement | null;
    if (!target) return;
    const url = target.dataset.mediaUrl;
    if (!url) return;
    const type = target.dataset.mediaType as "image" | "video" | undefined;
    showMedia(url, type);
  });

  // Expose global openMediaViewer for imperative calls (ProfileView, MyMedia grids)
  (window as any).openMediaViewer = showMedia;
}
