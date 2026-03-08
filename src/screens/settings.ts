/** Settings — app configuration matching reference design */

import { invoke } from "@tauri-apps/api/core";
import { navigateTo } from "../app";

interface Settings {
  npub: string;
  relay_port: number;
  max_storage_mb: number;
  wot_max_depth: number;
  sync_interval_secs: number;
  outbound_relays: string[];
  auto_start: boolean;
}

type SettingsTab = "identity" | "relays" | "storage" | "wot" | "advanced";

let activeTab: SettingsTab = "identity";
let currentSettings: Settings | null = null;

function renderPane(tab: SettingsTab): string {
  if (!currentSettings) return "";
  const s = currentSettings;

  switch (tab) {
    case "identity":
      return `
        <div class="settings-pane-title">Identity</div>
        <div class="settings-pane-desc">Your Nostr identity configuration.</div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Public Key</span><span class="settings-field-desc">Your npub</span></div>
        </div>
        <div class="settings-mono">${s.npub || "Not set"}</div>
        <div class="settings-field" style="border-bottom:none;padding-bottom:8px;">
          <div class="settings-field-info"><span class="settings-field-label">Signing Mode</span><span class="settings-field-desc">How events are signed</span></div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.85rem;color:var(--text-dim);">🔒 Read-only mode</div>
          <div style="font-size:0.75rem;color:var(--text-dim);margin-top:2px;">Connect a signer to unlock DMs and publishing.</div>
        </div>
      `;

    case "relays":
      return `
        <div class="settings-pane-title">Relays</div>
        <div class="settings-pane-desc">Manage relay connections.</div>
        ${s.outbound_relays.map((r) => `
          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">${r}</span>
            </div>
            <label class="toggle"><input type="checkbox" checked><span class="toggle-slider"></span></label>
          </div>
        `).join("")}
      `;

    case "storage":
      return `
        <div class="settings-pane-title">Storage</div>
        <div class="settings-pane-desc">Control storage limits.</div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Max Storage</span><span class="settings-field-desc">Maximum database size</span></div>
          <span style="font-family:var(--mono);font-size:0.85rem;color:var(--accent-light);">${s.max_storage_mb} MB</span>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Auto Cleanup</span><span class="settings-field-desc">Remove old events when full</span></div>
          <label class="toggle"><input type="checkbox" checked><span class="toggle-slider"></span></label>
        </div>
      `;

    case "wot":
      return `
        <div class="settings-pane-title">Web of Trust</div>
        <div class="settings-pane-desc">Configure trust graph computation.</div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Max depth</span><span class="settings-field-desc">How many hops to compute</span></div>
          <span style="font-family:var(--mono);font-size:0.85rem;color:var(--accent-light);">${s.wot_max_depth}</span>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Auto-refresh</span><span class="settings-field-desc">Recompute WoT periodically</span></div>
          <label class="toggle"><input type="checkbox" checked><span class="toggle-slider"></span></label>
        </div>
      `;

    case "advanced":
      return `
        <div class="settings-pane-title">Advanced</div>
        <div class="settings-pane-desc">Developer settings and diagnostics.</div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Relay Port</span><span class="settings-field-desc">WebSocket server port</span></div>
          <span style="font-family:var(--mono);font-size:0.85rem;color:var(--accent-light);">${s.relay_port}</span>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Sync Interval</span><span class="settings-field-desc">Seconds between sync rounds</span></div>
          <span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim);">${s.sync_interval_secs}s</span>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Auto Start</span><span class="settings-field-desc">Start relay with app</span></div>
          <label class="toggle"><input type="checkbox" ${s.auto_start ? "checked" : ""}><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-field">
          <div class="settings-field-info"><span class="settings-field-label">Data Directory</span><span class="settings-field-desc">Where nostrito stores data</span></div>
        </div>
        <div class="settings-mono">~/.local/share/nostrito/</div>

        <div style="margin-top:32px;padding-top:24px;border-top:1px solid rgba(220,38,38,0.2);">
          <div class="settings-pane-title" style="color:#ef4444;">⚠️ Danger Zone</div>
          <div class="settings-pane-desc">These actions are irreversible.</div>
          <div style="display:flex;gap:12px;margin-top:16px;">
            <button id="btn-reset-data" style="
              background:rgba(220,38,38,0.15);color:#ef4444;border:1px solid rgba(220,38,38,0.3);
              padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;
            ">Reset App Data</button>
            <button id="btn-change-account" style="
              background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);
              padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;
            ">Change Account</button>
          </div>
          <div id="reset-status" style="margin-top:12px;font-size:13px;"></div>
        </div>
      `;
  }
}

function draw(container: HTMLElement): void {
  const panel = container.querySelector(".settings-panel") as HTMLElement;
  if (panel) panel.innerHTML = renderPane(activeTab);

  container.querySelectorAll(".settings-sub-item").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.tab === activeTab);
  });

  // Wire danger zone buttons (only present on advanced tab)
  if (activeTab === "advanced") {
    const resetHandler = async () => {
      const confirmed = confirm("This will delete ALL app data (events, WoT graph, settings) and return to the setup wizard.\n\nAre you sure?");
      if (!confirmed) return;
      const status = document.getElementById("reset-status");
      if (status) status.textContent = "Resetting...";
      try {
        await invoke("reset_app_data");
        localStorage.removeItem("nostrito_initialized");
        localStorage.removeItem("nostrito_config");
        const sidebar = document.getElementById("sidebar");
        if (sidebar) sidebar.style.display = "none";
        navigateTo("wizard");
      } catch (e) {
        if (status) { status.textContent = `Reset failed: ${e}`; status.style.color = "#ef4444"; }
      }
    };

    document.getElementById("btn-reset-data")?.addEventListener("click", resetHandler);
    document.getElementById("btn-change-account")?.addEventListener("click", async () => {
      const confirmed = confirm("This will clear your identity and return to the setup wizard.\n\nContinue?");
      if (!confirmed) return;
      await resetHandler();
    });
  }
}

export async function renderSettings(container: HTMLElement): Promise<void> {
  container.style.padding = "0";
  container.innerHTML = `
    <div class="settings-container">
      <div class="settings-sub-nav">
        <div class="settings-sub-item active" data-tab="identity">🔑 Identity</div>
        <div class="settings-sub-item" data-tab="relays">📡 Relays</div>
        <div class="settings-sub-item" data-tab="storage">💾 Storage</div>
        <div class="settings-sub-item" data-tab="wot">🕸️ WoT</div>
        <div class="settings-sub-item" data-tab="advanced">⚙️ Advanced</div>
      </div>
      <div class="settings-panel">
        <div style="color:var(--text-dim);padding:24px;">Loading...</div>
      </div>
    </div>
  `;

  container.querySelectorAll(".settings-sub-item").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = (el as HTMLElement).dataset.tab as SettingsTab;
      draw(container);
    });
  });

  try {
    currentSettings = await invoke<Settings>("get_settings");
  } catch (e) {
    console.error("[settings]", e);
    currentSettings = {
      npub: "",
      relay_port: 4869,
      max_storage_mb: 500,
      wot_max_depth: 3,
      sync_interval_secs: 300,
      outbound_relays: [],
      auto_start: true,
    };
  }

  draw(container);
}
