import type { Screen } from "./types/nostr";
import { renderWizard } from "./screens/wizard";
import { renderDashboard } from "./screens/dashboard";
import { renderFeed, cleanupFeed } from "./screens/feed";
import { renderDms } from "./screens/dms";
import { renderWot } from "./screens/wot";
import { renderStorage } from "./screens/storage";
import { renderSettings } from "./screens/settings";
import { renderMyMedia } from "./screens/my-media";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getProfiles, profileDisplayName, type ProfileInfo } from "./utils/profiles";
import { initMediaViewer } from "./utils/media";
import { iconDashboard, iconFeed, iconMessageCircle, iconNetwork, iconDatabase, iconSettings, iconCheckCircle, iconX, iconImage } from "./utils/icons";

let currentScreen: Screen = "wizard";

const screens: Record<Screen, (container: HTMLElement) => void | Promise<void>> = {
  wizard: renderWizard,
  dashboard: renderDashboard,
  feed: renderFeed,
  dms: renderDms,
  wot: renderWot,
  storage: renderStorage,
  settings: renderSettings,
  "my-media": renderMyMedia,
};

export function navigateTo(screen: Screen): void {
  console.log(`[app] navigateTo: ${screen}`);
  // Cleanup previous screen resources
  if (currentScreen === "feed") cleanupFeed();
  currentScreen = screen;
  const content = document.getElementById("main-content");
  if (content) {
    content.innerHTML = "";
    const result = screens[currentScreen](content);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(console.error);
    }
  }
  // Update sidebar active state
  document.querySelectorAll(".app-nav-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-screen") === screen);
  });
  // Update titlebar title
  const titleEl = document.getElementById("titlebar-title");
  if (titleEl) {
    const labels: Record<string, string> = {
      dashboard: "Dashboard",
      feed: "Feed",
      dms: "DMs",
      wot: "WoT",
      storage: "Storage",
      settings: "Settings",
    };
    titleEl.textContent = `nostrito — ${labels[screen] || screen}`;
  }
}

export async function initApp(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="titlebar" data-tauri-drag-region>
      <div class="titlebar-buttons">
        <button class="tb-btn tb-close" id="tb-close" title="Close"></button>
        <button class="tb-btn tb-minimize" id="tb-minimize" title="Minimize"></button>
        <button class="tb-btn tb-maximize" id="tb-maximize" title="Maximize"></button>
      </div>
      <div class="titlebar-title" id="titlebar-title">nostrito — Dashboard</div>
      <div style="width:52px"></div>
    </div>
    <div class="app-container">
      <aside class="app-sidebar-nav" id="sidebar" style="display: none;">
        <div class="app-nav-item" data-screen="dashboard"><span class="icon">${iconDashboard()}</span> Dashboard</div>
        <div class="app-nav-item" data-screen="feed"><span class="icon">${iconFeed()}</span> Feed</div>
        <div class="app-nav-item" data-screen="dms"><span class="icon">${iconMessageCircle()}</span> DMs</div>
        <div class="app-nav-item" data-screen="wot"><span class="icon">${iconNetwork()}</span> WoT</div>
        <div class="app-nav-item" data-screen="storage"><span class="icon">${iconDatabase()}</span> Storage</div>
        <div class="app-nav-item" data-screen="settings"><span class="icon">${iconSettings()}</span> Settings</div>
        <div class="sidebar-spacer"></div>
        <div class="own-profile" id="own-profile" style="display:none"></div>
        <div class="sidebar-status"><span class="pulse-dot"></span> Live · wss://localhost:4869</div>
      </aside>
      <main class="main-content" id="main-content"></main>
    </div>
  `;

  // Wire titlebar buttons
  const appWindow = getCurrentWindow();
  document.getElementById("tb-close")?.addEventListener("click", () => appWindow.close());
  document.getElementById("tb-minimize")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("tb-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());

  // Wire sidebar navigation
  root.querySelectorAll("[data-screen]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const screen = (el as HTMLElement).getAttribute("data-screen") as Screen;
      navigateTo(screen);
    });
  });

  // Check initialization state from Rust backend
  let isInitialized = false;
  try {
    console.log("[app] Calling get_status to check initialization...");
    const status = await invoke<{ initialized: boolean }>("get_status");
    console.log("[app] get_status response:", status);
    isInitialized = status.initialized;
  } catch (_e) {
    console.warn("[app] get_status failed, falling back to localStorage:", _e);
    isInitialized = localStorage.getItem("nostrito_initialized") === "true";
  }

  console.log("[app] isInitialized:", isInitialized);

  if (isInitialized) {
    showAppShell();
  } else {
    // Hide titlebar and sidebar for wizard (wizard has its own)
    const titlebar = root.querySelector(".titlebar") as HTMLElement;
    if (titlebar) titlebar.style.display = "none";
    navigateTo("wizard");
  }

  // Listen for frontend reset fallback
  window.addEventListener("nostrito:reset", () => {
    console.log("[app] nostrito:reset event received");
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.style.display = "none";
    const tb = document.querySelector(".titlebar") as HTMLElement;
    if (tb) tb.style.display = "none";
    navigateTo("wizard");
  });

  // Listen for app reset event from backend (e.g. after reset_app_data)
  listen("app:reset", () => {
    console.log("[app] app:reset event from backend");
    localStorage.removeItem("nostrito_initialized");
    localStorage.removeItem("nostrito_config");
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.style.display = "none";
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    if (titlebar) titlebar.style.display = "none";
    navigateTo("wizard");
  });
}

/** Call after wizard completes to show full app shell */
export function showAppShell(): void {
  console.log("[app] showAppShell — switching to dashboard");
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.style.display = "flex";
  const titlebar = document.querySelector(".titlebar") as HTMLElement;
  if (titlebar) titlebar.style.display = "flex";
  navigateTo("dashboard");
  loadOwnProfile();
}

let previousScreen: Screen = "dashboard";

async function loadOwnProfile(): Promise<void> {
  try {
    const profile = await invoke<ProfileInfo | null>("get_own_profile");
    const el = document.getElementById("own-profile");
    if (!el || !profile) return;

    const name = profile.name || profile.display_name || "Me";
    const avatarHtml = profile.picture
      ? `<img src="${profile.picture}" class="own-profile-avatar" onerror="this.style.display='none'" />`
      : `<div class="own-profile-avatar"></div>`;

    el.innerHTML = `${avatarHtml}<span class="own-profile-name">${escapeHtml(name)}</span>`;
    el.style.display = "flex";
    el.style.cursor = "pointer";

    el.onclick = () => showOwnProfilePanel(profile);
  } catch (e) {
    console.warn("[app] Failed to load own profile:", e);
  }
}

async function showOwnProfilePanel(profile: ProfileInfo): Promise<void> {
  previousScreen = currentScreen;
  const content = document.getElementById("main-content");
  if (!content) return;

  renderProfileView(content, profile.pubkey, profile, true);
}

/** Show a profile view for any pubkey (replaces the old popup with a full page) */
async function showProfilePopup(pubkey: string): Promise<void> {
  previousScreen = currentScreen;
  const content = document.getElementById("main-content");
  if (!content) return;

  // Check if this is our own profile
  let isOwn = false;
  try {
    const status = await invoke<{ npub: string | null }>("get_status");
    if (status.npub) {
      const ownProfile = await invoke<ProfileInfo | null>("get_own_profile");
      if (ownProfile && ownProfile.pubkey === pubkey) isOwn = true;
    }
  } catch (_) {}

  const profileMap = await getProfiles([pubkey]);
  const profile = profileMap.get(pubkey) || null;

  // Check if we should show the fetch button (foreign profiles with limited cached data)
  let showFetchButton = false;
  if (!isOwn) {
    try {
      const cacheStatus = await invoke<{ event_count: number; has_metadata: boolean }>("get_profile_cache_status", { pubkey });
      showFetchButton = cacheStatus.event_count < 20 || !cacheStatus.has_metadata;
    } catch {
      showFetchButton = !profile;
    }
  }

  renderProfileView(content, pubkey, profile, isOwn, showFetchButton);
}

// Expose globally for inline onclick handlers
(window as any).showProfilePopup = showProfilePopup;

// ── Profile View with Tabs ─────────────────────────────────────

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface MediaItem {
  hash: string;
  url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  downloaded_at: number;
}

function renderProfileView(
  container: HTMLElement,
  pubkey: string,
  profile: ProfileInfo | null,
  isOwn: boolean,
  showFetchButton: boolean = false,
): void {
  const name = profile ? profileDisplayName(profile, pubkey) : shortPubkey(pubkey);
  const npub = pubkey.length > 20 ? pubkey.slice(0, 10) + "..." + pubkey.slice(-8) : pubkey;

  const avatarHtml = profile?.picture
    ? `<img src="${escapeHtml(profile.picture)}" class="own-panel-avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="own-panel-avatar own-panel-avatar-fallback" style="display:none;background:var(--accent)"></div>`
    : `<div class="own-panel-avatar own-panel-avatar-fallback" style="background:var(--accent)"></div>`;

  const fetchBannerHtml = showFetchButton
    ? `<div class="profile-fetch-banner">
        <span class="profile-fetch-hint">Limited data cached for this profile</span>
        <button id="profile-fetch-btn" class="profile-fetch-btn">↓ Fetch from relays</button>
        <div id="profile-fetch-result" class="profile-fetch-result"></div>
      </div>`
    : "";

  container.className = "main-content";
  container.innerHTML = `
    <div class="own-profile-panel">
      <button class="own-panel-close" id="profile-back">← Back</button>
      <div class="own-panel-header">
        ${avatarHtml}
        <div class="own-panel-name">${escapeHtml(name)}</div>
        <div class="own-panel-npub">${escapeHtml(npub)}</div>
        ${profile?.nip05 ? `<div class="own-panel-nip05"><span class="icon">${iconCheckCircle()}</span> ${escapeHtml(profile.nip05)}</div>` : ""}
      </div>
      ${(profile as any)?.about ? `<div class="own-panel-about">${escapeHtml((profile as any).about)}</div>` : ""}
      ${fetchBannerHtml}
      <div class="profile-tabs">
        <button class="profile-tab active" data-tab="notes">Notes</button>
        <button class="profile-tab" data-tab="articles">Articles</button>
        <button class="profile-tab" data-tab="media">${iconImage()} Media</button>
      </div>
      <div class="profile-tab-content" id="profile-tab-content">
        <div class="popup-loading">Loading...</div>
      </div>
    </div>
  `;

  initMediaViewer();

  document.getElementById("profile-back")?.addEventListener("click", () => {
    navigateTo(previousScreen);
  });

  // Wire up fetch button
  if (showFetchButton) {
    const fetchBtn = document.getElementById("profile-fetch-btn") as HTMLButtonElement | null;
    fetchBtn?.addEventListener("click", async () => {
      fetchBtn.disabled = true;
      fetchBtn.innerHTML = `<span class="profile-fetch-spinner"></span> Fetching...`;
      const resultEl = document.getElementById("profile-fetch-result")!;
      resultEl.textContent = "";
      resultEl.className = "profile-fetch-result";

      try {
        const result = await invoke<{ events_fetched: number; has_profile: boolean }>("fetch_profile", { pubkey });
        if (result.events_fetched === 0) {
          resultEl.textContent = "No data found on connected relays";
          resultEl.className = "profile-fetch-result profile-fetch-empty";
          fetchBtn.innerHTML = "↓ Fetch from relays";
          fetchBtn.disabled = false;
        } else {
          // Refresh the entire profile view with new data
          const updatedProfileMap = await getProfiles([pubkey]);
          const updatedProfile = updatedProfileMap.get(pubkey) || null;
          const newStatus = await invoke<{ event_count: number; has_metadata: boolean }>("get_profile_cache_status", { pubkey });
          const stillLimited = newStatus.event_count < 20 || !newStatus.has_metadata;
          renderProfileView(container, pubkey, updatedProfile, isOwn, stillLimited);
          // Show success message
          const newResultEl = document.getElementById("profile-fetch-result");
          if (newResultEl) {
            newResultEl.textContent = `Fetched ${result.events_fetched} events`;
            newResultEl.className = "profile-fetch-result profile-fetch-success";
          }
        }
      } catch (e) {
        resultEl.textContent = `Fetch failed: ${e}`;
        resultEl.className = "profile-fetch-result profile-fetch-error";
        fetchBtn.innerHTML = "↓ Fetch from relays";
        fetchBtn.disabled = false;
      }
    });
  }

  // Tab switching
  container.querySelectorAll(".profile-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".profile-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.getAttribute("data-tab")!;
      loadProfileTab(tab, pubkey, isOwn);
    });
  });

  // Load default tab
  loadProfileTab("notes", pubkey, isOwn);
}

async function loadProfileTab(tab: string, pubkey: string, isOwn: boolean): Promise<void> {
  const content = document.getElementById("profile-tab-content");
  if (!content) return;

  content.innerHTML = `<div class="popup-loading">Loading...</div>`;

  try {
    switch (tab) {
      case "notes":
        await loadProfileNotes(content, pubkey);
        break;
      case "articles":
        await loadProfileArticles(content, pubkey);
        break;
      case "media":
        await loadProfileMedia(content, pubkey, isOwn);
        break;
    }
  } catch (e) {
    console.error(`[profile] Failed to load ${tab}:`, e);
    content.innerHTML = `<div class="popup-loading">Failed to load ${tab}</div>`;
  }
}

async function loadProfileNotes(container: HTMLElement, pubkey: string): Promise<void> {
  const events = await invoke<NostrEvent[]>("get_feed", {
    filter: { kinds: [1], limit: 50, author: pubkey },
  });

  if (events.length === 0) {
    container.innerHTML = `<div class="profile-empty">No notes cached yet</div>`;
    return;
  }

  const cards = events.map((ev) => {
    const date = new Date(ev.created_at * 1000).toLocaleDateString();
    const time = new Date(ev.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const contentPreview = ev.content.length > 300 ? ev.content.slice(0, 300) + "…" : ev.content;
    return `<div class="profile-note-card">
      <div class="profile-note-date">${date} · ${time}</div>
      <div class="profile-note-content">${escapeHtml(contentPreview)}</div>
    </div>`;
  });

  container.innerHTML = cards.join("");
}

async function loadProfileArticles(container: HTMLElement, pubkey: string): Promise<void> {
  const events = await invoke<NostrEvent[]>("get_feed", {
    filter: { kinds: [30023], limit: 20, author: pubkey },
  });

  if (events.length === 0) {
    container.innerHTML = `<div class="profile-empty">No articles cached yet</div>`;
    return;
  }

  const cards = events.map((ev) => {
    const title = ev.tags.find((t) => t[0] === "title")?.[1] || "Untitled";
    const summary = ev.tags.find((t) => t[0] === "summary")?.[1] || ev.content.slice(0, 200);
    const date = new Date(ev.created_at * 1000).toLocaleDateString();
    return `<div class="profile-note-card">
      <div class="profile-article-title">${escapeHtml(title)}</div>
      <div class="profile-note-date">${date}</div>
      <div class="profile-note-content">${escapeHtml(summary.slice(0, 200))}${summary.length > 200 ? "…" : ""}</div>
    </div>`;
  });

  container.innerHTML = cards.join("");
}

async function loadProfileMedia(container: HTMLElement, pubkey: string, isOwn: boolean): Promise<void> {
  const command = isOwn ? "get_own_media" : "get_profile_media";
  const args = isOwn ? {} : { pubkey };

  const media = await invoke<MediaItem[]>(command, args);

  if (media.length === 0) {
    container.innerHTML = `<div class="profile-empty">No media cached yet<br><span style="font-size:0.8rem;color:var(--text-muted)">Media will appear here as it syncs from relays.</span></div>`;
    return;
  }

  const totalSize = media.reduce((sum, m) => sum + m.size_bytes, 0);
  const statsHtml = `<div class="profile-media-stats">${media.length} files · ${formatBytes(totalSize)}</div>`;

  const cards: string[] = [];
  for (const item of media) {
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

  container.innerHTML = `${statsHtml}<div class="my-media-grid">${cards.join("")}</div>`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function shortPubkey(pk: string): string {
  if (pk.length > 12) return pk.slice(0, 6) + "..." + pk.slice(-4);
  return pk;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
