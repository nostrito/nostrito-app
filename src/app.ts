import type { Screen } from "./types/nostr";
import { renderWizard } from "./screens/wizard";
import { renderDashboard } from "./screens/dashboard";
import { renderFeed } from "./screens/feed";
import { renderWot } from "./screens/wot";
import { renderStorage } from "./screens/storage";
import { renderSettings } from "./screens/settings";

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
  // TODO: Check AppStatus via invoke('get_status') to decide
  // whether to show wizard or dashboard on startup.
  // For now, always start with wizard.

  root.innerHTML = `
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
  `;

  // Wire up sidebar navigation
  root.querySelectorAll("[data-screen]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const screen = (el as HTMLElement).getAttribute("data-screen") as Screen;
      navigateTo(screen);
    });
  });

  // Start on wizard (sidebar hidden until onboarding complete)
  navigateTo("wizard");
}

/** Call after wizard completes to show full app shell */
export function showAppShell(): void {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.style.display = "flex";
  navigateTo("dashboard");
}
