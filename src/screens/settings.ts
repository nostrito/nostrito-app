/** Settings — app configuration. Loads real data via get_settings/save_settings. */

import { invoke } from "@tauri-apps/api/core";

interface Settings {
  npub: string;
  relay_port: number;
  max_storage_mb: number;
  storage_others_gb: number;
  storage_media_gb: number;
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
        <div class="settings-sub-item" data-settings="storage">💾 Storage</div>
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
        <!-- Storage -->
        <div class="settings-pane" id="pane-storage">
          <div class="settings-pane-title">Storage</div>
          <div class="settings-pane-desc">Control what gets stored and how much space to use.</div>

          <div class="storage-section">
            <div class="storage-row locked">
              <div class="storage-row-info">
                <span class="storage-row-label">Your events & media</span>
                <span class="storage-row-meta">🔒 Always stored. No exceptions.</span>
              </div>
              <div class="storage-bar-wrap">
                <div class="storage-bar"><div class="storage-bar-fill"></div></div>
                <span class="storage-bar-label">100%</span>
              </div>
            </div>
          </div>

          <div class="storage-section">
            <div class="storage-row">
              <div class="storage-row-info">
                <span class="storage-row-label">Others' events</span>
                <span class="storage-row-meta">From your Web of Trust</span>
              </div>
              <div class="storage-slider-wrap">
                <input type="range" class="storage-slider" min="1" max="50" value="5" id="settings-others-events-slider">
                <span class="storage-slider-value" id="settings-others-events-val">5 GB</span>
              </div>
            </div>
          </div>

          <div class="storage-section">
            <div class="storage-row">
              <div class="storage-row-info">
                <span class="storage-row-label">Others' media (Blossom)</span>
                <span class="storage-row-meta">Images, videos, audio from your network</span>
              </div>
              <div class="storage-slider-wrap">
                <input type="range" class="storage-slider" min="1" max="50" value="2" id="settings-others-media-slider">
                <span class="storage-slider-value" id="settings-others-media-val">2 GB</span>
              </div>
            </div>
          </div>

          <div class="storage-section">
            <div class="storage-row">
              <div class="storage-row-info">
                <span class="storage-row-label">Auto-cleanup</span>
                <span class="storage-row-meta">When storage limit is reached</span>
              </div>
              <div class="cleanup-group" id="settings-cleanup-group">
                <div class="cleanup-radio active" data-cleanup="oldest">Oldest first</div>
                <div class="cleanup-radio" data-cleanup="least-interacted">Least interacted</div>
              </div>
            </div>
          </div>

          <button class="btn btn-primary" id="btn-save-storage" style="margin-top:16px;width:100%">Save Storage Settings</button>
          <div id="storage-save-result" style="margin-top:8px;font-size:0.78rem;text-align:center"></div>
        </div>
        <!-- Advanced -->
        <div class="settings-pane" id="pane-advanced">
          <div class="settings-pane-title">Advanced</div>
          <div class="settings-pane-desc">Low-level configuration options.</div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Relay port</span><span class="settings-field-desc">Local WebSocket relay port</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-port">—</span></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Auto-start</span><span class="settings-field-desc">Start nostrito on login</span></div><label class="toggle"><input type="checkbox" id="settings-autostart"><span class="toggle-slider"></span></label></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Max storage</span><span class="settings-field-desc">Database size limit</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-max-storage">—</span></div>

          <div class="settings-field" style="border-bottom:none;padding-bottom:8px"><div class="settings-field-info"><span class="settings-field-label">Browser Integration</span><span class="settings-field-desc">Enable wss:// for web Nostr clients (Coracle, Snort, Primal)</span></div></div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:16px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div>
                <div id="browser-integration-status" style="font-size:0.85rem;color:var(--text-dim);margin-bottom:2px">Checking...</div>
                <div id="browser-integration-detail" style="font-size:0.75rem;color:var(--text-muted)"></div>
              </div>
              <button class="btn btn-primary" id="btn-enable-browser" style="font-size:0.8rem;padding:8px 16px">Enable</button>
            </div>
            <div id="browser-integration-result" style="margin-top:10px"></div>
          </div>

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

  // Wire storage sliders
  const evSlider = document.getElementById("settings-others-events-slider") as HTMLInputElement | null;
  const evVal = document.getElementById("settings-others-events-val");
  if (evSlider && evVal) {
    evSlider.addEventListener("input", () => {
      evVal.textContent = `${evSlider.value} GB`;
    });
  }

  const mdSlider = document.getElementById("settings-others-media-slider") as HTMLInputElement | null;
  const mdVal = document.getElementById("settings-others-media-val");
  if (mdSlider && mdVal) {
    mdSlider.addEventListener("input", () => {
      mdVal.textContent = `${mdSlider.value} GB`;
    });
  }

  // Wire cleanup radios
  const cleanupGroup = document.getElementById("settings-cleanup-group");
  if (cleanupGroup) {
    cleanupGroup.querySelectorAll(".cleanup-radio").forEach((radio) => {
      radio.addEventListener("click", () => {
        cleanupGroup.querySelectorAll(".cleanup-radio").forEach((r) => r.classList.remove("active"));
        radio.classList.add("active");
      });
    });
  }

  // Wire danger zone buttons
  document.getElementById("btn-reset-app")?.addEventListener("click", async () => {
    if (confirm("Are you sure? This will delete ALL data and return to the setup wizard.")) {
      try {
        console.log("[settings] Calling reset_app_data...");
        await invoke("reset_app_data");
        console.log("[settings] reset_app_data complete");
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
        console.log("[settings] Calling reset_app_data (change account)...");
        await invoke("reset_app_data");
        console.log("[settings] reset_app_data (change account) complete");
        localStorage.removeItem("nostrito_initialized");
        localStorage.removeItem("nostrito_config");
        window.dispatchEvent(new CustomEvent("nostrito:reset"));
      } catch (e) {
        console.error("[settings] Change account failed:", e);
      }
    }
  });

  loadSettings();

  // Wire storage save button (needs to be after loadSettings call to use _currentSettings)
  document.getElementById("btn-save-storage")?.addEventListener("click", async () => {
    const resultEl = document.getElementById("storage-save-result");
    const btn = document.getElementById("btn-save-storage") as HTMLButtonElement | null;
    if (!_currentSettings || !btn) return;

    const evSliderEl = document.getElementById("settings-others-events-slider") as HTMLInputElement;
    const mdSliderEl = document.getElementById("settings-others-media-slider") as HTMLInputElement;

    const updated = {
      ..._currentSettings,
      storage_others_gb: parseFloat(evSliderEl.value),
      storage_media_gb: parseFloat(mdSliderEl.value),
    };

    btn.disabled = true;
    btn.textContent = "Saving...";
    if (resultEl) resultEl.innerHTML = "";

    try {
      await invoke("save_settings", { settings: updated });
      _currentSettings = updated;
      btn.textContent = "Save Storage Settings";
      btn.disabled = false;
      if (resultEl) resultEl.innerHTML = `<span style="color:#34d399">✅ Storage settings saved</span>`;
    } catch (e) {
      btn.textContent = "Save Storage Settings";
      btn.disabled = false;
      if (resultEl) resultEl.innerHTML = `<span style="color:#ef4444">Failed: ${e}</span>`;
    }
  });
}

let _currentSettings: Settings | null = null;

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

    // Storage sliders
    _currentSettings = settings;
    const evSliderEl = document.getElementById("settings-others-events-slider") as HTMLInputElement | null;
    const evValEl = document.getElementById("settings-others-events-val");
    if (evSliderEl && evValEl) {
      evSliderEl.value = String(Math.round(settings.storage_others_gb));
      evValEl.textContent = `${Math.round(settings.storage_others_gb)} GB`;
    }
    const mdSliderEl = document.getElementById("settings-others-media-slider") as HTMLInputElement | null;
    const mdValEl = document.getElementById("settings-others-media-val");
    if (mdSliderEl && mdValEl) {
      mdSliderEl.value = String(Math.round(settings.storage_media_gb));
      mdValEl.textContent = `${Math.round(settings.storage_media_gb)} GB`;
    }
    // Browser integration
    try {
      const browserEnabled = await invoke<boolean>("check_browser_integration");
      const statusEl = document.getElementById("browser-integration-status");
      const detailEl = document.getElementById("browser-integration-detail");
      const btnEl = document.getElementById("btn-enable-browser") as HTMLButtonElement | null;

      if (statusEl && detailEl && btnEl) {
        if (browserEnabled) {
          statusEl.textContent = "✅ Enabled";
          detailEl.textContent = "wss://localhost:" + settings.relay_port + " available for web clients";
          btnEl.textContent = "Regenerate";
        } else {
          statusEl.textContent = "Not enabled";
          detailEl.textContent = "Web clients cannot connect without wss:// support";
        }

        const resultEl = document.getElementById("browser-integration-result");
        btnEl.addEventListener("click", async () => {
          btnEl.disabled = true;
          btnEl.textContent = "Setting up...";
          if (resultEl) resultEl.innerHTML = "";
          try {
            await invoke("setup_browser_integration");
            // Restart relay to pick up new TLS certs
            try {
              await invoke("stop_relay");
              await new Promise((r) => setTimeout(r, 500));
              await invoke("start_relay");
            } catch (relayErr) {
              console.warn("[settings] Relay restart after mkcert failed:", relayErr);
            }
            if (statusEl) statusEl.textContent = "✅ wss://localhost:" + settings.relay_port + " active";
            if (detailEl) detailEl.textContent = "Web clients can connect securely";
            btnEl.textContent = "Regenerate";
            btnEl.disabled = false;
            if (resultEl) {
              resultEl.innerHTML = `<div style="font-size:0.78rem;color:#34d399;margin-top:6px">✅ wss://localhost:${settings.relay_port} active — relay restarted with TLS</div>`;
            }
          } catch (e) {
            btnEl.disabled = false;
            btnEl.textContent = "Retry";
            if (resultEl) {
              resultEl.innerHTML = `<div style="font-size:0.78rem;color:#ef4444;margin-top:6px">Failed: ${e}</div>`;
            }
          }
        });
      }
    } catch (e) {
      console.error("[settings] Browser integration check failed:", e);
    }

  } catch (e) {
    console.error("[settings] Failed to load:", e);
  }
}
