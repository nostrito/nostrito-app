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
  currentScreen = screen;
  const content = document.getElementById("main-content");
  if (content) {
    content.innerHTML = "";
    screens[currentScreen](content);
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
        <div class="app-nav-item" data-screen="dashboard">📊 Dashboard</div>
        <div class="app-nav-item" data-screen="feed">📰 Feed</div>
        <div class="app-nav-item" data-screen="dms">💬 DMs</div>
        <div class="app-nav-item" data-screen="wot">🕸️ WoT</div>
        <div class="app-nav-item" data-screen="storage">💾 Storage</div>
        <div class="app-nav-item" data-screen="settings">⚙️ Settings</div>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-status"><span class="pulse-dot"></span> Live · ws://localhost:4869</div>
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
    const status = await invoke<{ initialized: boolean }>("get_status");
    isInitialized = status.initialized;
  } catch (_e) {
    isInitialized = localStorage.getItem("nostrito_initialized") === "true";
  }

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
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.style.display = "none";
    const tb = document.querySelector(".titlebar") as HTMLElement;
    if (tb) tb.style.display = "none";
    navigateTo("wizard");
  });

  // Listen for app reset event from backend (e.g. after reset_app_data)
  listen("app:reset", () => {
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
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.style.display = "flex";
  const titlebar = document.querySelector(".titlebar") as HTMLElement;
  if (titlebar) titlebar.style.display = "flex";
  navigateTo("dashboard");
}
