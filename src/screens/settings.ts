/** Settings — app configuration. Loads real data via get_settings/save_settings. */

import { invoke } from "@tauri-apps/api/core";
import { RELAYS, resolveRelayUrl, urlToAlias } from "../relays";

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
  sync_lookback_days: number;
  sync_batch_size: number;
  sync_events_per_batch: number;
  sync_batch_pause_secs: number;
  sync_relay_min_interval_secs: number;
  sync_wot_batch_size: number;
  sync_wot_events_per_batch: number;
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
        <div class="settings-sub-item" data-settings="sync">⚡ Sync</div>
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
          <div class="settings-pane-desc">Pick which relays to sync from. Changes take effect after saving.</div>
          <div id="settings-relay-grid" class="relay-grid" style="margin-bottom:16px"></div>
          <button class="btn btn-primary" id="btn-save-relays" style="width:100%">Save Relays</button>
          <div id="relay-save-result" style="margin-top:8px;font-size:0.78rem;text-align:center"></div>
        </div>
        <!-- WoT Settings -->
        <div class="settings-pane" id="pane-wot-settings">
          <div class="settings-pane-title">Web of Trust</div>
          <div class="settings-pane-desc">Configure trust graph computation.</div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Max depth</span><span class="settings-field-desc">How many hops to compute</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--accent-light)" id="settings-wot-depth">—</span></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Sync interval</span><span class="settings-field-desc">Minutes between full sync cycles. Lower = more real-time, higher = more polite.</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-sync-interval">—</span></div>
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
        <!-- Sync -->
        <div class="settings-pane" id="pane-sync">
          <div class="settings-pane-title">Sync Configuration</div>
          <div class="settings-pane-desc">Tune how the sync engine fetches events. Use aggressive settings to build the initial database, then switch to conservative for ongoing sync.</div>

          <div class="sync-presets">
            <button class="sync-preset-btn" data-preset="aggressive">🚀 Aggressive (initial build)</button>
            <button class="sync-preset-btn" data-preset="balanced">⚖️ Balanced (default)</button>
            <button class="sync-preset-btn" data-preset="polite">🐢 Polite (background)</button>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">Lookback window</span>
              <span class="settings-field-desc">How many days back to fetch in Tier 2</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-lookback" min="1" max="90" value="7">
              <span class="sync-slider-val" id="sync-lookback-val">7 days</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">Authors per batch</span>
              <span class="settings-field-desc">How many authors per subscription request (Tier 2). Higher = faster but more likely to get rate-limited.</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-batch-size" min="1" max="50" value="10">
              <span class="sync-slider-val" id="sync-batch-size-val">10</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">Events per request</span>
              <span class="settings-field-desc">Max events per REQ (limit). Higher = more data per round trip.</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-events-per-batch" min="10" max="500" step="10" value="50">
              <span class="sync-slider-val" id="sync-events-per-batch-val">50</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">Pause between batches</span>
              <span class="settings-field-desc">Seconds to wait between subscription batches. Lower = faster, higher = more polite.</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-batch-pause" min="0" max="30" value="7">
              <span class="sync-slider-val" id="sync-batch-pause-val">7s</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">Min relay interval</span>
              <span class="settings-field-desc">Minimum seconds between requests to the same relay.</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-relay-interval" min="0" max="10" value="3">
              <span class="sync-slider-val" id="sync-relay-interval-val">3s</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">WoT authors per batch</span>
              <span class="settings-field-desc">Authors per batch in Tier 3 (WoT crawl).</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-wot-batch" min="1" max="30" value="5">
              <span class="sync-slider-val" id="sync-wot-batch-val">5</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">WoT events per request</span>
              <span class="settings-field-desc">Max events per REQ in Tier 3 WoT crawl.</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-wot-events" min="5" max="100" value="15">
              <span class="sync-slider-val" id="sync-wot-events-val">15</span>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-field-label">Sync cycle interval</span>
              <span class="settings-field-desc">Minutes between full sync cycles. Lower = more real-time, higher = more polite.</span>
            </div>
            <div class="sync-slider-wrap">
              <input type="range" class="sync-slider" id="sync-interval" min="1" max="60" value="5">
              <span class="sync-slider-val" id="sync-interval-val">5 min</span>
            </div>
          </div>

          <button class="btn btn-primary" id="sync-save-btn" style="margin-top:16px">Save & Restart Sync</button>
          <div id="sync-save-result" style="margin-top:8px;font-size:0.78rem"></div>
        </div>
        <!-- Advanced -->
        <div class="settings-pane" id="pane-advanced">
          <div class="settings-pane-title">Advanced</div>
          <div class="settings-pane-desc">Low-level configuration options.</div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Relay port</span><span class="settings-field-desc">Local WebSocket relay port</span></div><span style="font-family:var(--mono);font-size:0.85rem;color:var(--text-dim)" id="settings-port">—</span></div>
          <div class="settings-field"><div class="settings-field-info"><span class="settings-field-label">Auto-start</span><span class="settings-field-desc">Start nostrito on login</span></div><label class="toggle"><input type="checkbox" id="settings-autostart"><span class="toggle-slider"></span></label></div>

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

  // Wire relay save button
  document.getElementById("btn-save-relays")?.addEventListener("click", async () => {
    const resultEl = document.getElementById("relay-save-result");
    const btn = document.getElementById("btn-save-relays") as HTMLButtonElement | null;
    if (!_currentSettings || !btn) return;

    if (_selectedRelayAliases.size === 0) {
      if (resultEl) resultEl.innerHTML = `<span style="color:#ef4444">Select at least one relay</span>`;
      return;
    }

    const outboundRelays = Array.from(_selectedRelayAliases).map(resolveRelayUrl);
    const updated: Settings = { ..._currentSettings, outbound_relays: outboundRelays };

    btn.disabled = true;
    btn.textContent = "Saving...";
    if (resultEl) resultEl.innerHTML = "";

    try {
      await invoke("save_settings", { settings: updated });
      _currentSettings = updated;
      await invoke("restart_sync");
      btn.textContent = "Save Relays";
      btn.disabled = false;
      if (resultEl) resultEl.innerHTML = `<span style="color:#34d399">✅ Relays saved — sync restarted</span>`;
    } catch (e) {
      btn.textContent = "Save Relays";
      btn.disabled = false;
      if (resultEl) resultEl.innerHTML = `<span style="color:#ef4444">Failed: ${e}</span>`;
    }
  });

  // ── Sync pane: sliders, presets, save ──

  const SYNC_PRESETS: Record<string, { lookback: number; batchSize: number; eventsPerBatch: number; batchPause: number; relayInterval: number; wotBatch: number; wotEvents: number }> = {
    aggressive: { lookback: 30, batchSize: 30, eventsPerBatch: 200, batchPause: 2, relayInterval: 1, wotBatch: 15, wotEvents: 50 },
    balanced:   { lookback: 7,  batchSize: 10, eventsPerBatch: 50,  batchPause: 7, relayInterval: 3, wotBatch: 5,  wotEvents: 15 },
    polite:     { lookback: 3,  batchSize: 5,  eventsPerBatch: 20,  batchPause: 15, relayInterval: 5, wotBatch: 3,  wotEvents: 10 },
  };

  function applySyncPreset(p: typeof SYNC_PRESETS[string]) {
    const set = (id: string, val: number, suffix?: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      const valEl = document.getElementById(id + "-val");
      if (el) el.value = String(val);
      if (valEl) valEl.textContent = suffix ? `${val}${suffix}` : String(val);
    };
    set("sync-lookback", p.lookback, " days");
    set("sync-batch-size", p.batchSize);
    set("sync-events-per-batch", p.eventsPerBatch);
    set("sync-batch-pause", p.batchPause, "s");
    set("sync-relay-interval", p.relayInterval, "s");
    set("sync-wot-batch", p.wotBatch);
    set("sync-wot-events", p.wotEvents);
  }

  // Wire preset buttons
  container.querySelectorAll(".sync-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = (btn as HTMLElement).dataset.preset!;
      if (SYNC_PRESETS[preset]) applySyncPreset(SYNC_PRESETS[preset]);
    });
  });

  // Wire slider value displays
  const syncSliderMap: [string, string][] = [
    ["sync-lookback", " days"],
    ["sync-batch-size", ""],
    ["sync-events-per-batch", ""],
    ["sync-batch-pause", "s"],
    ["sync-relay-interval", "s"],
    ["sync-wot-batch", ""],
    ["sync-wot-events", ""],
    ["sync-interval", " min"],
  ];
  for (const [id, suffix] of syncSliderMap) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    const valEl = document.getElementById(id + "-val");
    if (slider && valEl) {
      slider.addEventListener("input", () => {
        valEl.textContent = suffix ? `${slider.value}${suffix}` : slider.value;
      });
    }
  }

  // Wire save button
  document.getElementById("sync-save-btn")?.addEventListener("click", async () => {
    const resultEl = document.getElementById("sync-save-result");
    const btn = document.getElementById("sync-save-btn") as HTMLButtonElement | null;
    if (!_currentSettings || !btn) return;

    const getVal = (id: string) => parseInt((document.getElementById(id) as HTMLInputElement)?.value || "0", 10);

    const updated: Settings = {
      ..._currentSettings,
      sync_lookback_days: getVal("sync-lookback"),
      sync_batch_size: getVal("sync-batch-size"),
      sync_events_per_batch: getVal("sync-events-per-batch"),
      sync_batch_pause_secs: getVal("sync-batch-pause"),
      sync_relay_min_interval_secs: getVal("sync-relay-interval"),
      sync_wot_batch_size: getVal("sync-wot-batch"),
      sync_wot_events_per_batch: getVal("sync-wot-events"),
      sync_interval_secs: getVal("sync-interval") * 60,
    };

    btn.disabled = true;
    btn.textContent = "Saving...";
    if (resultEl) resultEl.innerHTML = "";

    try {
      await invoke("save_settings", { settings: updated });
      _currentSettings = updated;
      await invoke("restart_sync");
      btn.textContent = "Save & Restart Sync";
      btn.disabled = false;
      if (resultEl) resultEl.innerHTML = `<span style="color:#34d399">✅ Saved — sync restarted with new config</span>`;
    } catch (e) {
      btn.textContent = "Save & Restart Sync";
      btn.disabled = false;
      if (resultEl) resultEl.innerHTML = `<span style="color:#ef4444">Failed: ${e}</span>`;
    }
  });
}

let _currentSettings: Settings | null = null;
let _selectedRelayAliases: Set<string> = new Set();

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

    // Relays — card grid picker
    const relayGridEl = document.getElementById("settings-relay-grid");
    if (relayGridEl) {
      // Convert stored relays to alias set for pre-selection
      // Handles BOTH short aliases (e.g. "primal") and wss:// URLs
      const activeAliases = new Set<string>();
      for (const relay of settings.outbound_relays) {
        const isAlias = RELAYS.some(r => r.id === relay);
        if (isAlias) {
          activeAliases.add(relay);
        } else {
          const alias = urlToAlias(relay);
          if (alias) activeAliases.add(alias);
        }
      }

      // Track selected relays in module scope for the save button
      _selectedRelayAliases = new Set(activeAliases);

      relayGridEl.innerHTML = "";
      for (const relay of RELAYS) {
        const isOn = activeAliases.has(relay.id);
        const card = document.createElement("div");
        card.className = `relay-card${isOn ? " selected" : ""}`;
        card.setAttribute("data-relay", relay.id);
        card.innerHTML = `
          <div class="relay-card-info">
            <span class="relay-card-name">${escapeHtml(relay.name)}</span>
            <span class="relay-card-desc">${escapeHtml(relay.description)}</span>
          </div>
          <div class="relay-check">${isOn ? "✓" : ""}</div>
        `;
        card.addEventListener("click", () => {
          const selected = _selectedRelayAliases.has(relay.id);
          if (selected) {
            _selectedRelayAliases.delete(relay.id);
          } else {
            _selectedRelayAliases.add(relay.id);
          }
          card.classList.toggle("selected");
          const check = card.querySelector(".relay-check")!;
          check.textContent = _selectedRelayAliases.has(relay.id) ? "✓" : "";
        });
        relayGridEl.appendChild(card);
      }
    }

    // WoT
    const depthEl = document.getElementById("settings-wot-depth");
    if (depthEl) depthEl.textContent = settings.wot_max_depth.toString();

    const intervalEl = document.getElementById("settings-sync-interval");
    if (intervalEl) intervalEl.textContent = `${Math.round(settings.sync_interval_secs / 60)} min`;

    // Advanced
    const portEl = document.getElementById("settings-port");
    if (portEl) portEl.textContent = settings.relay_port.toString();

    const autostartEl = document.getElementById("settings-autostart") as HTMLInputElement | null;
    if (autostartEl) autostartEl.checked = settings.auto_start;

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

    // Sync sliders
    const syncFields: [string, number, string][] = [
      ["sync-lookback", settings.sync_lookback_days, " days"],
      ["sync-batch-size", settings.sync_batch_size, ""],
      ["sync-events-per-batch", settings.sync_events_per_batch, ""],
      ["sync-batch-pause", settings.sync_batch_pause_secs, "s"],
      ["sync-relay-interval", settings.sync_relay_min_interval_secs, "s"],
      ["sync-wot-batch", settings.sync_wot_batch_size, ""],
      ["sync-wot-events", settings.sync_wot_events_per_batch, ""],
      ["sync-interval", Math.round(settings.sync_interval_secs / 60), " min"],
    ];
    for (const [id, val, suffix] of syncFields) {
      const sl = document.getElementById(id) as HTMLInputElement | null;
      const valEl = document.getElementById(id + "-val");
      if (sl) sl.value = String(val);
      if (valEl) valEl.textContent = suffix ? `${val}${suffix}` : String(val);
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
