import type { Screen } from "./types/nostr";
import { renderWizard } from "./screens/wizard";
import { renderDashboard } from "./screens/dashboard";
import { renderFeed } from "./screens/feed";
import { renderWot } from "./screens/wot";
import { renderStorage } from "./screens/storage";
import { renderSettings } from "./screens/settings";
import { getCurrentWindow } from "@tauri-apps/api/window";

let currentScreen: Screen = "wizard";

const screens: Record<Screen, (container: HTMLElement) => void> = {
  wizard: renderWizard,
  dashboard: renderDashboard,
  feed: renderFeed,
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
  document.querySelectorAll(".sidebar-nav a").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-screen") === screen);
  });
}

export function initApp(root: HTMLElement): void {
  const isInitialized = localStorage.getItem("nostrito_initialized") === "true";

  root.innerHTML = `
    <div class="titlebar" data-tauri-drag-region>
      <div class="titlebar-buttons">
        <button class="tb-btn tb-close" id="tb-close" title="Close"></button>
        <button class="tb-btn tb-minimize" id="tb-minimize" title="Minimize"></button>
        <button class="tb-btn tb-maximize" id="tb-maximize" title="Maximize"></button>
      </div>
    </div>
    <div class="app-container">
      <aside class="sidebar" id="sidebar" style="display: none;">
        <div class="sidebar-header" style="padding: 16px; font-weight: 700; font-size: 18px; color: var(--accent-light);">
          ⚡ nostrito
        </div>
        <nav class="sidebar-nav">
          <a href="#" data-screen="dashboard">📊 Dashboard</a>
          <a href="#" data-screen="feed">📝 Feed</a>
          <a href="#" data-screen="wot">🕸️ Web of Trust</a>
          <a href="#" data-screen="storage">💾 Storage</a>
          <a href="#" data-screen="settings">⚙️ Settings</a>
        </nav>
      </aside>
      <main class="main-content" id="main-content"></main>
    </div>
  `;

  // Wire titlebar buttons
  const appWindow = getCurrentWindow();
  document.getElementById("tb-close")?.addEventListener("click", () => appWindow.close());
  document.getElementById("tb-minimize")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("tb-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());

  // Wire up sidebar navigation
  root.querySelectorAll("[data-screen]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const screen = (el as HTMLElement).getAttribute("data-screen") as Screen;
      navigateTo(screen);
    });
  });

  if (isInitialized) {
    showAppShell();
  } else {
    navigateTo("wizard");
  }
}

/** Call after wizard completes to show full app shell */
export function showAppShell(): void {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.style.display = "flex";
  navigateTo("dashboard");
}
