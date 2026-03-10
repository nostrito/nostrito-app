/** My Media — offline-capable grid explorer of own cached media */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { iconImage } from "../utils/icons";
import { initMediaViewer } from "../utils/media";

interface OwnMediaItem {
  hash: string;
  url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  downloaded_at: number;
}

type MediaFilter = "all" | "images" | "videos" | "audio";

let currentFilter: MediaFilter = "all";
let allMedia: OwnMediaItem[] = [];

export function renderMyMedia(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="my-media-page">
      <div class="my-media-header">
        <h2 class="my-media-title">${iconImage()} My Media</h2>
        <div class="my-media-stats" id="my-media-stats">Loading...</div>
      </div>
      <div class="my-media-filters">
        <button class="my-media-filter active" data-filter="all">All</button>
        <button class="my-media-filter" data-filter="images">Images</button>
        <button class="my-media-filter" data-filter="videos">Videos</button>
        <button class="my-media-filter" data-filter="audio">Audio</button>
      </div>
      <div class="my-media-grid" id="my-media-grid">
        <div class="my-media-loading">Loading media...</div>
      </div>
    </div>
  `;

  // Ensure media viewer (lightbox) is initialized
  initMediaViewer();

  // Wire filter buttons
  container.querySelectorAll(".my-media-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".my-media-filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.getAttribute("data-filter") as MediaFilter;
      renderGrid();
    });
  });

  loadMedia();
}

async function loadMedia(): Promise<void> {
  try {
    allMedia = await invoke<OwnMediaItem[]>("get_own_media");
    const statsEl = document.getElementById("my-media-stats");
    if (statsEl) {
      const totalSize = allMedia.reduce((sum, m) => sum + m.size_bytes, 0);
      statsEl.textContent = `${allMedia.length} files · ${formatBytes(totalSize)}`;
    }
    renderGrid();
  } catch (e) {
    console.error("[my-media] Failed to load:", e);
    const grid = document.getElementById("my-media-grid");
    if (grid) grid.innerHTML = `<div class="my-media-empty">Failed to load media</div>`;
  }
}

function filterMedia(): OwnMediaItem[] {
  switch (currentFilter) {
    case "images":
      return allMedia.filter((m) => m.mime_type.startsWith("image/"));
    case "videos":
      return allMedia.filter((m) => m.mime_type.startsWith("video/"));
    case "audio":
      return allMedia.filter((m) => m.mime_type.startsWith("audio/"));
    default:
      return allMedia;
  }
}

function renderGrid(): void {
  const grid = document.getElementById("my-media-grid");
  if (!grid) return;

  const filtered = filterMedia();

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="my-media-empty">No ${currentFilter === "all" ? "" : currentFilter + " "}media cached yet.<br><span style="font-size:0.8rem;color:var(--text-muted)">Your own media will appear here as it syncs from relays.</span></div>`;
    return;
  }

  const cards: string[] = [];
  for (const item of filtered) {
    const localSrc = convertFileSrc(item.local_path);
    const safeUrl = localSrc.replace(/'/g, "\\'");
    const date = new Date(item.downloaded_at * 1000).toLocaleDateString();

    if (item.mime_type.startsWith("image/")) {
      cards.push(`
        <div class="my-media-card" onclick="openMediaViewer('${safeUrl}')" title="${date} · ${formatBytes(item.size_bytes)}">
          <img src="${localSrc}" loading="lazy" onerror="this.parentElement.classList.add('broken')" />
          <div class="my-media-card-overlay">${formatBytes(item.size_bytes)}</div>
        </div>
      `);
    } else if (item.mime_type.startsWith("video/")) {
      cards.push(`
        <div class="my-media-card video" onclick="openMediaViewer('${safeUrl}')" title="${date} · ${formatBytes(item.size_bytes)}">
          <video src="${localSrc}" preload="metadata" muted></video>
          <div class="my-media-card-play">▶</div>
          <div class="my-media-card-overlay">${formatBytes(item.size_bytes)}</div>
        </div>
      `);
    } else if (item.mime_type.startsWith("audio/")) {
      cards.push(`
        <div class="my-media-card audio" title="${date} · ${formatBytes(item.size_bytes)}">
          <div class="my-media-audio-icon">🎵</div>
          <audio src="${localSrc}" controls preload="metadata"></audio>
          <div class="my-media-card-overlay">${formatBytes(item.size_bytes)}</div>
        </div>
      `);
    }
  }

  grid.innerHTML = cards.join("");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}
