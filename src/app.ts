import type { Screen } from "./types/nostr";
import { renderWizard } from "./screens/wizard";
import { renderDashboard } from "./screens/dashboard";
import { renderFeed } from "./screens/feed";
import { renderDms } from "./screens/dms";
import { renderWot } from "./screens/wot";
import { renderStorage } from "./screens/storage";
import { renderSettings } from "./screens/settings";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getProfiles, profileDisplayName, type ProfileInfo } from "./utils/profiles";
import { iconDashboard, iconFeed, iconMessageCircle, iconNetwork, iconDatabase, iconSettings, iconCheckCircle, iconX } from "./utils/icons";

let currentScreen: Screen = "wizard";

const screens: Record<Screen, (container: HTMLElement) => void | Promise<void>> = {
  wizard: renderWizard,
  dashboard: renderDashboard,
  feed: renderFeed,
  dms: renderDms,
  wot: renderWot,
  storage: renderStorage,
  settings: renderSettings,
};

export function navigateTo(screen: Screen): void {
  console.log(`[app] navigateTo: ${screen}`);
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

  const name = profile.display_name || profile.name || "Me";
  const npub = profile.pubkey.length > 20
    ? profile.pubkey.slice(0, 10) + "..." + profile.pubkey.slice(-8)
    : profile.pubkey;

  const avatarHtml = profile.picture
    ? `<img src="${escapeHtml(profile.picture)}" class="own-panel-avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="own-panel-avatar own-panel-avatar-fallback" style="display:none;background:var(--accent)"></div>`
    : `<div class="own-panel-avatar own-panel-avatar-fallback" style="background:var(--accent)"></div>`;

  let eventCount = "—";
  try {
    const status = await invoke<{ events_stored: number }>("get_status");
    eventCount = status.events_stored.toLocaleString();
  } catch (_) {}

  content.className = "main-content";
  content.innerHTML = `
    <div class="own-profile-panel">
      <button class="own-panel-close" id="own-panel-close">← Back</button>
      <div class="own-panel-header">
        ${avatarHtml}
        <div class="own-panel-name">${escapeHtml(name)}</div>
        <div class="own-panel-npub">${escapeHtml(npub)}</div>
        ${profile.nip05 ? `<div class="own-panel-nip05"><span class="icon">${iconCheckCircle()}</span> ${escapeHtml(profile.nip05)}</div>` : ""}
      </div>
      ${(profile as any).about ? `<div class="own-panel-about">${escapeHtml((profile as any).about)}</div>` : ""}
      <div class="own-panel-stats">
        <div class="own-panel-stat"><div class="own-panel-stat-val">${eventCount}</div><div class="own-panel-stat-label">Events Stored</div></div>
      </div>
      <button class="own-panel-edit" disabled>Edit Profile (coming soon)</button>
    </div>
  `;

  document.getElementById("own-panel-close")?.addEventListener("click", () => {
    navigateTo(previousScreen);
  });
}

/** Show a profile popup for any pubkey */
async function showProfilePopup(pubkey: string): Promise<void> {
  let overlay = document.getElementById("profile-popup-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "profile-popup-overlay";
    overlay.className = "profile-popup-overlay";
    overlay.innerHTML = `
      <div class="profile-popup-card">
        <button id="popup-close" class="popup-close-btn"><span class="icon">${iconX()}</span></button>
        <div id="popup-content" class="popup-content">
          <div class="popup-loading">Loading...</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Close on clicking overlay background
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay!.style.display = "none";
      }
    });
    overlay.querySelector("#popup-close")?.addEventListener("click", () => {
      overlay!.style.display = "none";
    });
  }

  // Show with loading state
  overlay.style.display = "flex";
  const popupContent = overlay.querySelector("#popup-content")!;
  popupContent.innerHTML = `<div class="popup-loading">Loading...</div>`;

  try {
    const profileMap = await getProfiles([pubkey]);
    const profile = profileMap.get(pubkey);
    const name = profileDisplayName(profile, pubkey);
    const npub = pubkey.length > 20
      ? pubkey.slice(0, 10) + "..." + pubkey.slice(-8)
      : pubkey;

    const avatarHtml = profile?.picture
      ? `<img src="${escapeHtml(profile.picture)}" class="popup-avatar-img" onerror="this.style.display='none'" />`
      : "";

    popupContent.innerHTML = `
      ${avatarHtml}
      <div class="popup-name">${escapeHtml(name)}</div>
      <div class="popup-npub">${escapeHtml(npub)}</div>
      ${profile?.nip05 ? `<div class="popup-nip05"><span class="icon">${iconCheckCircle()}</span> ${escapeHtml(profile.nip05)}</div>` : ""}
      ${(profile as any)?.about ? `<div class="popup-about">${escapeHtml((profile as any).about)}</div>` : ""}
    `;
  } catch (e) {
    popupContent.innerHTML = `<div class="popup-loading">Failed to load profile</div>`;
  }
}

// Expose globally for inline onclick handlers
(window as any).showProfilePopup = showProfilePopup;

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
