/** Settings — app configuration. Loads real data via get_settings/save_settings. */

import { invoke } from "@tauri-apps/api/core";

interface Settings {
  npub: string;
  relay_port: number;
  max_storage_mb: number;
  wot_max_depth: number;
  sync_interval_secs: number;
  outbound_relays: string[];
  auto_start: boolean;
}

interface RelayStatusInfo {
  url: string;
  name: string;
  connected: boolean;
  latency_ms: number | null;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function renderSettings(container: HTMLElement): void {
  container.className = "main-content";
  container.style.padding = "0";
  container.innerHTML = `
    <div class="settings-container">
      <div class="settings-sub-nav">
        <div class="settings-sub-item active" data-settings="identity">🔑 Identity</div>
        <div class="settings-sub-item" data-settings="relays">📡 Relays</div>
        <div class="settings-sub-item" data-settings="wot-settings">🕸️ WoT</div>
        <div class="settings-sub-item" data-settings="advanced">⚙️ Advanced</div>
      </div>
      <div class="settings-panel">
        <!-- Identity -->
        <div class="settings-pane active" id="pane-identity">
          <div class="settings-pane-title">Identity</div>
          <div class="settings-pane-desc">Your Nostr identity configuration.</div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Public Key</span><span class="settings-field-desc">Your npub used for WoT computation</span></div></div>
          <div class="settings-mono" id="settings-npub">Loading...</div>

          <div class="settings-field" style="border-bottom:none;padding-bottom:8px"><div class="settings-field-info"><span class="settings-field-label">Signing Mode</span><span class="settings-field-desc">How events are signed</span></div></div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:16px">
            <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:2px">🔒 Read-only mode</div>
            <div style="font-size:0.75rem;color:var(--text-muted)">DMs disabled. Connect a signer to unlock full access.</div>
          </div>

          <div class="settings-field" style="border-bottom:none;padding-bottom:8px"><div class="settings-field-info"><span class="settings-field-label">Connect Signer</span><span class="settings-field-desc">Upgrade to full access</span></div></div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:border-color 0.2s"><span style="font-size:0.85rem;font-weight:500">🔑 Paste nsec</span><span style="font-size:0.72rem;color:var(--text-muted)">Full access</span></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:border-color 0.2s"><span style="font-size:0.85rem;font-weight:500">🏰 NBunker</span><span style="font-size:0.72rem;color:var(--text-muted)">Remote signer</span></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:border-color 0.2s"><span style="font-size:0.85rem;font-weight:500">🔌 Nostr Connect</span><span style="font-size:0.72rem;color:var(--text-muted)">NIP-46</span></div>
          </div>
        </div>
        <!-- Relays -->
        <div class="settings-pane" id="pane-relays">
          <div class="settings-pane-title">Relays</div>
          <div class="settings-pane-desc">Manage relay connections.</div>
          <div id="settings-relay-list">Loading relays...</div>
        </div>
        <!-- WoT Settings -->
        <div class="settings-pane" id="pane-wot-settings">
          <div class="settings-pane-title">Web of Trust</div>
          <div class="settings-pane-desc">Configure trust graph computation.</div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Max depth</span><span class="settings-field-desc">How many hops to compute</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--accent-light)" id="settings-wot-depth">—</span></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Sync interval</span><span class="settings-field-desc">Seconds between sync cycles</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-sync-interval">—</span></div>
        </div>
        <!-- Advanced -->
        <div class="settings-pane" id="pane-advanced">
          <div class="settings-pane-title">Advanced</div>
          <div class="settings-pane-desc">Low-level configuration options.</div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Relay port</span><span class="settings-field-desc">Local WebSocket relay port</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-port">—</span></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Auto-start</span><span class="settings-field-desc">Start nostrito on login</span></div><label class="toggle"><input type="checkbox" id="settings-autostart"><span class="toggle-slider"></span></label></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Max storage</span><span class="settings-field-desc">Database size limit</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-max-storage">—</span></div>

          <div class="danger-zone">
            <div class="danger-zone-title">⚠️ Danger Zone</div>
            <div class="danger-zone-row">
              <div>
                <div class="danger-zone-label">Reset App Data</div>
                <div class="danger-zone-desc">Clears all events, WoT graph, and config. Returns to setup wizard.</div>
              </div>
              <button class="btn-danger" id="btn-reset-app">Reset App Data</button>
            </div>
            <div class="danger-zone-row">
              <div>
                <div class="danger-zone-label">Change Account</div>
                <div class="danger-zone-desc">Remove your npub and start over. Keeps your event data.</div>
              </div>
              <button class="btn-danger" id="btn-change-account">Change Account</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire settings sub-nav
  const items = container.querySelectorAll(".settings-sub-item");
  const panes = container.querySelectorAll(".settings-pane");
  items.forEach((item) => {
    item.addEventListener("click", () => {
      const pane = (item as HTMLElement).dataset.settings!;
      items.forEach((s) => s.classList.remove("active"));
      item.classList.add("active");
      panes.forEach((p) => p.classList.remove("active"));
      const target = container.querySelector(`#pane-${pane}`);
      if (target) target.classList.add("active");
    });
  });

  // Wire danger zone buttons
  document.getElementById("btn-reset-app")?.addEventListener("click", async () => {
    if (confirm("Are you sure? This will delete ALL data and return to the setup wizard.")) {
      try {
        await invoke("reset_app_data");
        // Backend emits app:reset which app.ts listens to → navigates to wizard
        // Fallback: clear local state and reload
        localStorage.removeItem("nostrito_initialized");
        localStorage.removeItem("nostrito_config");
        window.dispatchEvent(new CustomEvent("nostrito:reset"));
      } catch (e) {
        console.error("[settings] Reset failed:", e);
      }
    }
  });

  document.getElementById("btn-change-account")?.addEventListener("click", async () => {
    if (confirm("Remove your npub and start over? Event data will be kept.")) {
      try {
        await invoke("reset_app_data");
        localStorage.removeItem("nostrito_initialized");
        localStorage.removeItem("nostrito_config");
        window.dispatchEvent(new CustomEvent("nostrito:reset"));
      } catch (e) {
        console.error("[settings] Change account failed:", e);
      }
    }
  });

  loadSettings();
}

async function loadSettings(): Promise<void> {
  try {
    console.log("[settings] Calling get_settings...");
    const settings = await invoke<Settings>("get_settings");
    console.log("[settings] get_settings response:", JSON.stringify(settings));

    // Identity
    const npubEl = document.getElementById("settings-npub");
    if (npubEl) {
      npubEl.textContent = settings.npub || "Not configured";
    }

    // Relays — from real config
    const relayListEl = document.getElementById("settings-relay-list");
    if (relayListEl) {
      if (settings.outbound_relays.length === 0) {
        relayListEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem">No relays configured</div>`;
      } else {
        // Try to get relay status for latency info
        let relayStatus: RelayStatusInfo[] = [];
        try {
          console.log("[settings] Calling get_relay_status...");
          relayStatus = await invoke<RelayStatusInfo[]>("get_relay_status");
          console.log("[settings] get_relay_status response:", relayStatus.length, "relays");
        } catch (_) {}

        const statusMap = new Map(relayStatus.map((r) => [r.url, r]));

        relayListEl.innerHTML = settings.outbound_relays
          .map((url) => {
            const info = statusMap.get(url);
            const name = info?.name || url.replace("wss://", "").replace("ws://", "");
            const latency = info?.latency_ms != null ? `${info.latency_ms}ms` : "";
            return `
              <div class="settings-field">
                <div class="settings-field-info">
                  <span class="settings-field-label">${escapeHtml(name)}</span>
                  <span class="settings-field-desc">${escapeHtml(url)}${latency ? ` · ${latency}` : ""}</span>
                </div>
                <label class="toggle"><input type="checkbox" checked><span class="toggle-slider"></span></label>
              </div>
            `;
          })
          .join("");
      }
    }

    // WoT
    const depthEl = document.getElementById("settings-wot-depth");
    if (depthEl) depthEl.textContent = settings.wot_max_depth.toString();

    const intervalEl = document.getElementById("settings-sync-interval");
    if (intervalEl) intervalEl.textContent = `${settings.sync_interval_secs}s`;

    // Advanced
    const portEl = document.getElementById("settings-port");
    if (portEl) portEl.textContent = settings.relay_port.toString();

    const autostartEl = document.getElementById("settings-autostart") as HTMLInputElement | null;
    if (autostartEl) autostartEl.checked = settings.auto_start;

    const maxStorageEl = document.getElementById("settings-max-storage");
    if (maxStorageEl) {
      maxStorageEl.textContent =
        settings.max_storage_mb >= 1024
          ? `${(settings.max_storage_mb / 1024).toFixed(1)} GB`
          : `${settings.max_storage_mb} MB`;
    }
  } catch (e) {
    console.error("[settings] Failed to load:", e);
  }
}
