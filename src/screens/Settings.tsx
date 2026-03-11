import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RELAYS, resolveRelayUrl, urlToAlias } from "../relays";
import { getProfiles, profileDisplayName } from "../utils/profiles";
import type { ProfileInfo } from "../utils/profiles";
import { RelayCard } from "../components/RelayCard";
import { Slider } from "../components/Slider";
import { Badge } from "../components/Badge";
import { Avatar } from "../components/Avatar";
import {
  IconKey,
  IconRadio,
  IconDatabase,
  IconSettings as IconSettingsIcon,
  IconLock,
  IconCastle,
  IconPlug,
  IconRocket,
  IconScale,
  IconTurtle,
  IconAlertTriangle,
  IconCheckCircle,
  IconUsers,
  IconWifiOff,
} from "../components/Icon";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Settings {
  npub: string;
  relay_port: number;
  max_storage_mb: number;
  storage_others_gb: number;
  storage_media_gb: number;
  storage_own_media_gb: number;
  storage_tracked_media_gb: number;
  storage_wot_media_gb: number;
  wot_event_retention_days: number;
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
  max_event_age_days: number;
  sync_fof_content: boolean;
  offline_mode: boolean;
}

interface TrackedProfile {
  pubkey: string;
  tracked_at: number;
  note: string | null;
}

type TabId = "identity" | "relays" | "storage" | "advanced" | "tracked";

interface SaveFeedback {
  type: "success" | "error";
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  sync_interval_secs: 300,
  sync_lookback_days: 30,
  sync_batch_size: 50,
  sync_events_per_batch: 50,
  sync_batch_pause_secs: 7,
  sync_relay_min_interval_secs: 3,
  sync_wot_batch_size: 5,
  sync_wot_events_per_batch: 15,
  wot_max_depth: 2,
  wot_event_retention_days: 30,
  max_storage_mb: 10240,
  storage_media_gb: 2.0,
  max_event_age_days: 30,
};

const SYNC_PRESETS: Record<
  string,
  {
    lookback: number;
    batchSize: number;
    eventsPerBatch: number;
    batchPause: number;
    relayInterval: number;
    wotBatch: number;
    wotEvents: number;
    wotDepth: number;
    interval: number;
  }
> = {
  light: {
    lookback: 7,
    batchSize: 10,
    eventsPerBatch: 20,
    batchPause: 15,
    relayInterval: 5,
    wotBatch: 3,
    wotEvents: 10,
    wotDepth: 1,
    interval: 10,
  },
  balanced: {
    lookback: 30,
    batchSize: 50,
    eventsPerBatch: 50,
    batchPause: 7,
    relayInterval: 3,
    wotBatch: 5,
    wotEvents: 15,
    wotDepth: 2,
    interval: 5,
  },
  power: {
    lookback: 60,
    batchSize: 50,
    eventsPerBatch: 200,
    batchPause: 2,
    relayInterval: 1,
    wotBatch: 15,
    wotEvents: 50,
    wotDepth: 3,
    interval: 2,
  },
};

const TABS: { id: TabId; label: string; Icon: React.FC }[] = [
  { id: "identity", label: "Identity", Icon: IconKey },
  { id: "relays", label: "Relays", Icon: IconRadio },
  { id: "storage", label: "Storage", Icon: IconDatabase },
  { id: "tracked", label: "Tracked Profiles", Icon: IconUsers },
  { id: "advanced", label: "Advanced", Icon: IconSettingsIcon },
];

const WOT_PRESETS = [
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1yr" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Settings: React.FC = () => {
  /* --- core state --------------------------------------------------- */
  const [activeTab, setActiveTab] = useState<TabId>("identity");
  const [settings, setSettings] = useState<Settings | null>(null);

  /* --- identity ----------------------------------------------------- */
  // (npub comes from settings)

  /* --- relays ------------------------------------------------------- */
  const [selectedRelays, setSelectedRelays] = useState<Set<string>>(new Set());
  const [relaySaving, setRelaySaving] = useState(false);
  const [relayFeedback, setRelayFeedback] = useState<SaveFeedback | null>(null);

  /* --- storage ------------------------------------------------------ */
  const [trackedMediaGb, setTrackedMediaGb] = useState(3);
  const [wotRetentionDays, setWotRetentionDays] = useState(30);
  const [wotMediaGb, setWotMediaGb] = useState(2);
  const [storageSaving, setStorageSaving] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<SaveFeedback | null>(null);

  /* --- advanced ----------------------------------------------------- */
  const [syncLookback, setSyncLookback] = useState(30);
  const [syncBatchSize, setSyncBatchSize] = useState(50);
  const [syncEventsPerBatch, setSyncEventsPerBatch] = useState(50);
  const [syncBatchPause, setSyncBatchPause] = useState(7);
  const [syncRelayInterval, setSyncRelayInterval] = useState(3);
  const [syncWotBatch, setSyncWotBatch] = useState(5);
  const [syncWotEvents, setSyncWotEvents] = useState(15);
  const [syncInterval, setSyncInterval] = useState(5);
  const [syncWotDepth, setSyncWotDepth] = useState(2);
  const [syncFofContent, setSyncFofContent] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [advancedFeedback, setAdvancedFeedback] = useState<SaveFeedback | null>(null);
  const [resetDefaultsFeedback, setResetDefaultsFeedback] = useState<SaveFeedback | null>(null);

  /* --- browser integration ------------------------------------------ */
  const [browserEnabled, setBrowserEnabled] = useState<boolean | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserFeedback, setBrowserFeedback] = useState<SaveFeedback | null>(null);

  /* --- tracked profiles --------------------------------------------- */
  const [trackedProfiles, setTrackedProfiles] = useState<TrackedProfile[]>([]);
  const [trackedProfileMap, setTrackedProfileMap] = useState<Map<string, ProfileInfo>>(new Map());
  const [trackedLoading, setTrackedLoading] = useState(true);
  const [trackInput, setTrackInput] = useState("");

  /* --- offline mode -------------------------------------------------- */
  const [offlineMode, setOfflineMode] = useState(false);
  const [offlineToggling, setOfflineToggling] = useState(false);

  /* --- nsec identity ------------------------------------------------ */
  const [nsecExpanded, setNsecExpanded] = useState(false);
  const [nsecInput, setNsecInput] = useState("");
  const [nsecSaving, setNsecSaving] = useState(false);
  const [nsecFeedback, setNsecFeedback] = useState<SaveFeedback | null>(null);
  const [signingMode, setSigningMode] = useState("read-only");

  /* --- load settings on mount --------------------------------------- */
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      console.log("[settings] Calling get_settings...");
      const s = await invoke<Settings>("get_settings");
      console.log("[settings] get_settings response:", JSON.stringify(s));
      setSettings(s);

      // Initialize relay selection
      const activeAliases = new Set<string>();
      for (const relay of s.outbound_relays) {
        const isAlias = RELAYS.some((r) => r.id === relay);
        if (isAlias) {
          activeAliases.add(relay);
        } else {
          const alias = urlToAlias(relay);
          if (alias) activeAliases.add(alias);
        }
      }
      setSelectedRelays(activeAliases);

      // Storage sliders
      setTrackedMediaGb(Math.round(s.storage_tracked_media_gb));
      setWotMediaGb(Math.round(s.storage_wot_media_gb));
      setWotRetentionDays(s.wot_event_retention_days);

      // Advanced sync sliders
      setSyncLookback(s.sync_lookback_days);
      setSyncBatchSize(s.sync_batch_size);
      setSyncEventsPerBatch(s.sync_events_per_batch);
      setSyncBatchPause(s.sync_batch_pause_secs);
      setSyncRelayInterval(s.sync_relay_min_interval_secs);
      setSyncWotBatch(s.sync_wot_batch_size);
      setSyncWotEvents(s.sync_wot_events_per_batch);
      setSyncInterval(Math.round(s.sync_interval_secs / 60));
      setSyncWotDepth(s.wot_max_depth);
      setSyncFofContent(s.sync_fof_content);
      setAutoStart(s.auto_start);
      setOfflineMode(s.offline_mode);

      // Browser integration
      try {
        const enabled = await invoke<boolean>("check_browser_integration");
        setBrowserEnabled(enabled);
      } catch (e) {
        console.error("[settings] Browser integration check failed:", e);
      }

      // Signing mode
      try {
        const mode = await invoke<string>("get_signing_mode");
        setSigningMode(mode);
      } catch (e) {
        console.error("[settings] Signing mode check failed:", e);
      }

      // Tracked profiles
      loadTrackedProfiles();
    } catch (e) {
      console.error("[settings] Failed to load:", e);
    }
  }, []);

  const loadTrackedProfiles = useCallback(async () => {
    setTrackedLoading(true);
    try {
      const tracked = await invoke<TrackedProfile[]>("get_tracked_profiles");
      setTrackedProfiles(tracked);
      if (tracked.length > 0) {
        const pubkeys = tracked.map((p) => p.pubkey);
        const profileMap = await getProfiles(pubkeys);
        setTrackedProfileMap(new Map(profileMap));
      } else {
        setTrackedProfileMap(new Map());
      }
    } catch (e) {
      console.error("[settings] get_tracked_profiles failed:", e);
    } finally {
      setTrackedLoading(false);
    }
  }, []);

  /* --- relay toggle ------------------------------------------------- */
  const toggleRelay = useCallback((id: string) => {
    setSelectedRelays((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /* --- save handlers ------------------------------------------------ */
  const handleSaveRelays = useCallback(async () => {
    if (!settings) return;
    if (selectedRelays.size === 0) {
      setRelayFeedback({ type: "error", message: "Select at least one relay" });
      return;
    }

    setRelaySaving(true);
    setRelayFeedback(null);

    const outboundRelays = Array.from(selectedRelays).map(resolveRelayUrl);
    const updated: Settings = { ...settings, outbound_relays: outboundRelays };

    try {
      await invoke("save_settings", { settings: updated });
      setSettings(updated);
      await invoke("restart_sync");
      setRelayFeedback({ type: "success", message: "Relays saved \u2014 sync restarted" });
    } catch (e) {
      setRelayFeedback({ type: "error", message: `Failed: ${e}` });
    } finally {
      setRelaySaving(false);
    }
  }, [settings, selectedRelays]);

  const handleSaveStorage = useCallback(async () => {
    if (!settings) return;

    setStorageSaving(true);
    setStorageFeedback(null);

    const updated: Settings = {
      ...settings,
      storage_own_media_gb: 0,
      storage_tracked_media_gb: trackedMediaGb,
      storage_wot_media_gb: wotMediaGb,
      wot_event_retention_days: wotRetentionDays,
      max_event_age_days: wotRetentionDays,
    };

    try {
      await invoke("save_settings", { settings: updated });
      setSettings(updated);
      setStorageFeedback({ type: "success", message: "Storage settings saved" });
    } catch (e) {
      setStorageFeedback({ type: "error", message: `Failed: ${e}` });
    } finally {
      setStorageSaving(false);
    }
  }, [settings, trackedMediaGb, wotMediaGb, wotRetentionDays]);

  const handleSaveAdvanced = useCallback(async () => {
    if (!settings) return;

    setAdvancedSaving(true);
    setAdvancedFeedback(null);

    const updated: Settings = {
      ...settings,
      sync_lookback_days: syncLookback,
      sync_batch_size: syncBatchSize,
      sync_events_per_batch: syncEventsPerBatch,
      sync_batch_pause_secs: syncBatchPause,
      sync_relay_min_interval_secs: syncRelayInterval,
      sync_wot_batch_size: syncWotBatch,
      sync_wot_events_per_batch: syncWotEvents,
      sync_interval_secs: syncInterval * 60,
      wot_max_depth: syncWotDepth,
      sync_fof_content: syncFofContent,
    };

    try {
      await invoke("save_settings", { settings: updated });
      setSettings(updated);
      await invoke("restart_sync");
      setAdvancedFeedback({ type: "success", message: "Saved \u2014 sync restarted with new config" });
    } catch (e) {
      setAdvancedFeedback({ type: "error", message: `Failed: ${e}` });
    } finally {
      setAdvancedSaving(false);
    }
  }, [
    settings,
    syncLookback,
    syncBatchSize,
    syncEventsPerBatch,
    syncBatchPause,
    syncRelayInterval,
    syncWotBatch,
    syncWotEvents,
    syncInterval,
    syncWotDepth,
  ]);

  const handleResetDefaults = useCallback(() => {
    setSyncLookback(DEFAULTS.sync_lookback_days);
    setSyncBatchSize(DEFAULTS.sync_batch_size);
    setSyncEventsPerBatch(DEFAULTS.sync_events_per_batch);
    setSyncBatchPause(DEFAULTS.sync_batch_pause_secs);
    setSyncRelayInterval(DEFAULTS.sync_relay_min_interval_secs);
    setSyncWotBatch(DEFAULTS.sync_wot_batch_size);
    setSyncWotEvents(DEFAULTS.sync_wot_events_per_batch);
    setSyncInterval(Math.round(DEFAULTS.sync_interval_secs / 60));
    setSyncWotDepth(DEFAULTS.wot_max_depth);
    setSyncFofContent(false);
    setResetDefaultsFeedback({
      type: "success",
      message: 'Defaults restored \u2014 click "Save & Restart Sync" to apply',
    });
  }, []);

  const applySyncPreset = useCallback((presetKey: string) => {
    const p = SYNC_PRESETS[presetKey];
    if (!p) return;
    setSyncLookback(p.lookback);
    setSyncBatchSize(p.batchSize);
    setSyncEventsPerBatch(p.eventsPerBatch);
    setSyncBatchPause(p.batchPause);
    setSyncRelayInterval(p.relayInterval);
    setSyncWotBatch(p.wotBatch);
    setSyncWotEvents(p.wotEvents);
    setSyncWotDepth(p.wotDepth);
    setSyncInterval(p.interval);
  }, []);

  /* --- danger zone -------------------------------------------------- */
  const handleSaveNsec = useCallback(async () => {
    if (!nsecInput.trim()) return;
    setNsecSaving(true);
    setNsecFeedback(null);
    try {
      await invoke("set_nsec", { nsec: nsecInput.trim() });
      setSigningMode("nsec");
      setNsecExpanded(false);
      setNsecInput("");
      setNsecFeedback({ type: "success", message: "nsec saved to system keychain" });
    } catch (e: any) {
      setNsecFeedback({ type: "error", message: String(e) });
    } finally {
      setNsecSaving(false);
    }
  }, [nsecInput]);

  const handleClearNsec = useCallback(async () => {
    try {
      await invoke("clear_nsec");
      setSigningMode("read-only");
      setNsecFeedback({ type: "success", message: "nsec removed" });
    } catch (e: any) {
      setNsecFeedback({ type: "error", message: String(e) });
    }
  }, []);

  const handleChangeAccount = useCallback(async () => {
    if (
      confirm(
        "You will be signed out and redirected to the setup wizard.\n\nYour event data will be preserved \u2014 if you re-enter the same npub later, it will resume where you left off.\n\nContinue?"
      )
    ) {
      try {
        console.log("[settings] Calling change_account...");
        await invoke("change_account");
        console.log("[settings] change_account complete \u2014 identity cleared, events preserved");
        localStorage.removeItem("nostrito_initialized");
        localStorage.removeItem("nostrito_config");
        window.dispatchEvent(new CustomEvent("nostrito:reset"));
      } catch (e) {
        console.error("[settings] Change account failed:", e);
        alert("Failed to change account: " + e);
      }
    }
  }, []);

  const handleResetApp = useCallback(async () => {
    if (confirm("Are you sure? This will delete ALL data and return to the setup wizard.")) {
      try {
        console.log("[settings] Calling reset_app_data...");
        await invoke("reset_app_data");
        console.log("[settings] reset_app_data complete");
        localStorage.removeItem("nostrito_initialized");
        localStorage.removeItem("nostrito_config");
        window.dispatchEvent(new CustomEvent("nostrito:reset"));
      } catch (e) {
        console.error("[settings] Reset failed:", e);
      }
    }
  }, []);

  /* --- browser integration ------------------------------------------ */
  const handleEnableBrowser = useCallback(async () => {
    if (!settings) return;
    setBrowserBusy(true);
    setBrowserFeedback(null);

    try {
      await invoke("setup_browser_integration");
      try {
        await invoke("stop_relay");
        await new Promise((r) => setTimeout(r, 500));
        await invoke("start_relay");
      } catch (relayErr) {
        console.warn("[settings] Relay restart after mkcert failed:", relayErr);
      }
      setBrowserEnabled(true);
      setBrowserFeedback({
        type: "success",
        message: `wss://localhost:${settings.relay_port} active \u2014 relay restarted with TLS`,
      });
    } catch (e) {
      setBrowserFeedback({ type: "error", message: `Failed: ${e}` });
    } finally {
      setBrowserBusy(false);
    }
  }, [settings]);

  /* --- offline mode toggle ------------------------------------------ */
  const handleToggleOffline = useCallback(async () => {
    const next = !offlineMode;
    setOfflineToggling(true);
    try {
      await invoke("set_offline_mode", { enabled: next });
      setOfflineMode(next);
      if (settings) {
        setSettings({ ...settings, offline_mode: next });
      }
    } catch (e) {
      console.error("[settings] set_offline_mode failed:", e);
    } finally {
      setOfflineToggling(false);
    }
  }, [offlineMode, settings]);

  /* --- tracked profiles --------------------------------------------- */
  const handleTrackProfile = useCallback(async () => {
    if (!trackInput.trim()) return;
    try {
      await invoke("track_profile", { pubkey: trackInput.trim(), note: null });
      setTrackInput("");
      loadTrackedProfiles();
      try { await invoke("restart_sync"); } catch (e) { console.warn("[settings] restart_sync after track failed:", e); }
    } catch (e) {
      console.error("[settings] track_profile failed:", e);
    }
  }, [trackInput, loadTrackedProfiles]);

  const handleUntrackProfile = useCallback(
    async (pubkey: string) => {
      try {
        await invoke("untrack_profile", { pubkey });
        loadTrackedProfiles();
        try { await invoke("restart_sync"); } catch (e) { console.warn("[settings] restart_sync after untrack failed:", e); }
      } catch (e) {
        console.error("[settings] untrack_profile failed:", e);
      }
    },
    [loadTrackedProfiles]
  );

  /* --- helpers ------------------------------------------------------ */
  const shortPubkey = (pk: string) =>
    pk.length > 16 ? pk.slice(0, 8) + "\u2026" + pk.slice(-8) : pk;

  /* --- render ------------------------------------------------------- */
  return (
    <div className="settings-container">
      {/* Sub-nav */}
      <div className="settings-sub-nav">
        {TABS.map((tab) => (
          <div
            key={tab.id}
            className={`settings-sub-item${activeTab === tab.id ? " active" : ""}`}
            data-settings={tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="icon">
              <tab.Icon />
            </span>{" "}
            {tab.label}
          </div>
        ))}
      </div>

      <div className="settings-panel">
        {/* ================================================================ */}
        {/*  Offline Mode Banner                                             */}
        {/* ================================================================ */}
        <div
          style={{
            background: offlineMode ? "rgba(251, 191, 36, 0.08)" : "var(--bg)",
            border: offlineMode ? "1px solid rgba(251, 191, 36, 0.3)" : "1px solid var(--border)",
            borderRadius: 12,
            padding: "16px 20px",
            marginBottom: 20,
            transition: "all 0.3s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                className="icon"
                style={{
                  color: offlineMode ? "#fbbf24" : "var(--text-muted)",
                  transition: "color 0.3s ease",
                }}
              >
                <IconWifiOff />
              </span>
              <div>
                <div
                  style={{
                    fontSize: "0.88rem",
                    fontWeight: 600,
                    color: offlineMode ? "#fbbf24" : "var(--text)",
                  }}
                >
                  Offline Mode
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {offlineMode
                    ? "All relay sync is paused. Working with local data only."
                    : "Disable all outbound connections and work with downloaded data"}
                </div>
              </div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={offlineMode}
                disabled={offlineToggling}
                onChange={handleToggleOffline}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Tab 1: Identity                                                 */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "identity" ? " active" : ""}`} id="pane-identity">
          <div className="settings-pane-title">Identity</div>
          <div className="settings-pane-desc">Your Nostr identity.</div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Public Key</span>
              <span className="settings-field-desc">Your npub used for WoT computation</span>
            </div>
          </div>
          <div className="settings-mono" id="settings-npub">
            {settings ? settings.npub || "Not configured" : "Loading..."}
          </div>

          <div className="settings-field" style={{ borderBottom: "none", paddingBottom: 8 }}>
            <div className="settings-field-info">
              <span className="settings-field-label">Signing Mode</span>
              <span className="settings-field-desc">How events are signed</span>
            </div>
          </div>
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "14px 18px",
              marginBottom: 16,
            }}
          >
            {signingMode === "nsec" ? (
              <>
                <div style={{ fontSize: "0.85rem", color: "var(--accent)", marginBottom: 2 }}>
                  <span className="icon">
                    <IconKey />
                  </span>{" "}
                  nsec (full access)
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Key stored in system keychain</span>
                  <button
                    onClick={handleClearNsec}
                    style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "0.72rem", textDecoration: "underline" }}
                  >
                    Remove
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: 2 }}>
                  <span className="icon">
                    <IconLock />
                  </span>{" "}
                  Read-only mode
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  DMs disabled. Connect a signer to unlock full access.
                </div>
              </>
            )}
          </div>

          <div className="settings-field" style={{ borderBottom: "none", paddingBottom: 8 }}>
            <div className="settings-field-info">
              <span className="settings-field-label">Connect Signer</span>
              <span className="settings-field-desc">Upgrade to full access</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
            <div
              onClick={() => setNsecExpanded(!nsecExpanded)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                background: "var(--bg)",
                border: nsecExpanded ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: nsecExpanded ? "10px 10px 0 0" : 10,
                cursor: "pointer",
                transition: "border-color 0.2s",
              }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                <span className="icon">
                  <IconKey />
                </span>{" "}
                Paste nsec
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Full access</span>
            </div>
            {nsecExpanded && (
              <div
                style={{
                  padding: "12px 16px",
                  background: "var(--bg)",
                  border: "1px solid var(--accent)",
                  borderTop: "none",
                  borderRadius: "0 0 10px 10px",
                  marginTop: -1,
                }}
              >
                <input
                  type="password"
                  value={nsecInput}
                  onChange={(e) => setNsecInput(e.target.value)}
                  placeholder="nsec1..."
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    fontSize: "0.82rem",
                    fontFamily: "monospace",
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--text)",
                    outline: "none",
                    marginBottom: 8,
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    className="btn btn-primary"
                    onClick={(e) => { e.stopPropagation(); handleSaveNsec(); }}
                    disabled={nsecSaving || !nsecInput.trim().startsWith("nsec1")}
                    style={{ fontSize: "0.8rem", padding: "6px 16px" }}
                  >
                    {nsecSaving ? "Saving..." : "Save to Keychain"}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setNsecExpanded(false); setNsecInput(""); setNsecFeedback(null); }}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "0.78rem" }}
                  >
                    Cancel
                  </button>
                </div>
                {nsecFeedback && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: "0.78rem",
                      color: nsecFeedback.type === "success" ? "var(--accent)" : "var(--danger)",
                    }}
                  >
                    {nsecFeedback.message}
                  </div>
                )}
              </div>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                cursor: "pointer",
                transition: "border-color 0.2s",
              }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                <span className="icon">
                  <IconCastle />
                </span>{" "}
                NBunker
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Remote signer</span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                cursor: "pointer",
                transition: "border-color 0.2s",
              }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                <span className="icon">
                  <IconPlug />
                </span>{" "}
                Nostr Connect
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>NIP-46</span>
            </div>
          </div>

          <div className="danger-zone">
            <div className="danger-zone-row">
              <div>
                <div className="danger-zone-label">Change Account</div>
                <div className="danger-zone-desc">
                  Remove your npub and start over. Keeps your event data.
                </div>
              </div>
              <button className="btn-danger" id="btn-change-account" onClick={handleChangeAccount}>
                Change Account
              </button>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Tab 2: Relays                                                   */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "relays" ? " active" : ""}`} id="pane-relays">
          <div className="settings-pane-title">Relays</div>
          <div className="settings-pane-desc">
            Pick which relays to sync from. Changes take effect after saving.
          </div>

          <div className="relay-grid" style={{ marginBottom: 16 }}>
            {RELAYS.map((relay) => (
              <RelayCard
                key={relay.id}
                relay={relay}
                selected={selectedRelays.has(relay.id)}
                onToggle={toggleRelay}
              />
            ))}
          </div>

          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            disabled={relaySaving}
            onClick={handleSaveRelays}
          >
            {relaySaving ? "Saving..." : "Save Relays"}
          </button>
          {relayFeedback && (
            <div style={{ marginTop: 8, fontSize: "0.78rem", textAlign: "center" }}>
              <span style={{ color: relayFeedback.type === "success" ? "#34d399" : "#ef4444" }}>
                {relayFeedback.type === "success" && (
                  <span className="icon">
                    <IconCheckCircle />
                  </span>
                )}{" "}
                {relayFeedback.message}
              </span>
            </div>
          )}
        </div>

        {/* ================================================================ */}
        {/*  Tab 3: Storage                                                  */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "storage" ? " active" : ""}`} id="pane-storage">
          <div className="settings-pane-title">Storage</div>
          <div className="settings-pane-desc">
            Control what gets stored, organized by ownership.
          </div>

          {/* Own Events Section */}
          <div className="storage-category-section">
            <div className="storage-category-header">
              <Badge text="YOU" className="storage-category-badge" variant="own" />
              <span className="storage-category-title">Own Events</span>
            </div>
            <div className="storage-section">
              <div className="storage-row locked">
                <div className="storage-row-info">
                  <span className="storage-row-label">Event retention</span>
                  <span className="storage-row-meta">
                    <span className="icon">
                      <IconLock />
                    </span>{" "}
                    Own events are always kept
                  </span>
                </div>
              </div>
            </div>
            <div className="storage-section">
              <div className="storage-row">
                <div className="storage-row-info">
                  <span className="storage-row-label">Own media limit</span>
                  <span className="storage-row-meta">
                    Media from your own events &mdash; always kept, never evicted
                  </span>
                </div>
                <div className="storage-slider-wrap">
                  <span
                    className="storage-slider-value"
                    style={{ color: "var(--green)", fontWeight: 600 }}
                  >
                    &infin; Unlimited
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Tracked Profiles Section */}
          <div className="storage-category-section">
            <div className="storage-category-header">
              <Badge text="TRACKED" className="storage-category-badge" variant="tracked" />
              <span className="storage-category-title">Tracked Profiles</span>
            </div>
            <div className="storage-section">
              <div className="storage-row locked">
                <div className="storage-row-info">
                  <span className="storage-row-label">Event retention</span>
                  <span className="storage-row-meta">
                    <span className="icon">
                      <IconLock />
                    </span>{" "}
                    Tracked profiles events are always kept
                  </span>
                </div>
              </div>
            </div>
            <div className="storage-section">
              <div className="storage-row">
                <div className="storage-row-info">
                  <span className="storage-row-label">Tracked media limit</span>
                  <span className="storage-row-meta">Media from tracked profiles</span>
                </div>
                <Slider
                  variant="storage"
                  id="settings-tracked-media-slider"
                  min={1}
                  max={50}
                  value={trackedMediaGb}
                  suffix=" GB"
                  onChange={setTrackedMediaGb}
                />
              </div>
            </div>
          </div>

          {/* WoT Profiles Section */}
          <div className="storage-category-section">
            <div className="storage-category-header">
              <Badge text="WOT" className="storage-category-badge" variant="wot" />
              <span className="storage-category-title">WoT Profiles</span>
            </div>
            <div className="storage-section">
              <div className="storage-row">
                <div className="storage-row-info">
                  <span className="storage-row-label">Event retention</span>
                  <span className="storage-row-meta">
                    How long to keep WoT events before pruning
                  </span>
                </div>
                <Slider
                  variant="storage"
                  id="storage-wot-retention"
                  min={7}
                  max={365}
                  value={wotRetentionDays}
                  suffix=" days"
                  onChange={setWotRetentionDays}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  {WOT_PRESETS.map((preset) => (
                    <button
                      key={preset.days}
                      className="btn btn-secondary wot-age-preset"
                      style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                      onClick={() => setWotRetentionDays(preset.days)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="storage-section">
              <div className="storage-row">
                <div className="storage-row-info">
                  <span className="storage-row-label">WoT media limit</span>
                  <span className="storage-row-meta">Media from WoT profiles</span>
                </div>
                <Slider
                  variant="storage"
                  id="settings-wot-media-slider"
                  min={1}
                  max={50}
                  value={wotMediaGb}
                  suffix=" GB"
                  onChange={setWotMediaGb}
                />
              </div>
            </div>
          </div>

          <button
            className="btn btn-primary"
            style={{ marginTop: 16, width: "100%" }}
            disabled={storageSaving}
            onClick={handleSaveStorage}
          >
            {storageSaving ? "Saving..." : "Save Storage Settings"}
          </button>
          {storageFeedback && (
            <div style={{ marginTop: 8, fontSize: "0.78rem", textAlign: "center" }}>
              <span style={{ color: storageFeedback.type === "success" ? "#34d399" : "#ef4444" }}>
                {storageFeedback.type === "success" && (
                  <span className="icon">
                    <IconCheckCircle />
                  </span>
                )}{" "}
                {storageFeedback.message}
              </span>
            </div>
          )}
        </div>

        {/* ================================================================ */}
        {/*  Tab 4: Advanced                                                 */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "advanced" ? " active" : ""}`} id="pane-advanced">
          <div className="settings-pane-title">Advanced</div>
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "14px 18px",
              marginBottom: 20,
            }}
          >
            <div style={{ fontSize: "0.84rem", color: "var(--text-dim)" }}>
              These settings are for advanced users. The defaults work well for most people.
            </div>
          </div>

          <button
            className="btn btn-secondary"
            style={{ width: "100%", marginBottom: 20 }}
            onClick={handleResetDefaults}
          >
            Reset to Defaults
          </button>
          {resetDefaultsFeedback && (
            <div
              style={{
                marginTop: -12,
                marginBottom: 12,
                fontSize: "0.78rem",
                textAlign: "center",
              }}
            >
              <span
                style={{
                  color: resetDefaultsFeedback.type === "success" ? "#34d399" : "#ef4444",
                }}
              >
                {resetDefaultsFeedback.type === "success" && (
                  <span className="icon">
                    <IconCheckCircle />
                  </span>
                )}{" "}
                {resetDefaultsFeedback.message}
              </span>
            </div>
          )}

          {/* FoF Content Toggle */}
          <div className="settings-field" style={{ marginBottom: 20 }}>
            <div className="settings-field-info">
              <span className="settings-field-label">Follows-of-follows content</span>
              <span className="settings-field-desc">
                Fetch posts from people your follows follow, prioritized by how many of your follows also follow them
              </span>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={syncFofContent}
                onChange={(e) => setSyncFofContent(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: "var(--accent)" }}
              />
              <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                {syncFofContent ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>

          {/* Sync Presets */}
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: "0.82rem",
                fontWeight: 600,
                color: "var(--text)",
                marginBottom: 8,
              }}
            >
              Sync Presets
            </div>
            <div className="sync-presets">
              <button className="sync-preset-btn" onClick={() => applySyncPreset("light")}>
                <span className="icon">
                  <IconTurtle />
                </span>{" "}
                Light
              </button>
              <button className="sync-preset-btn" onClick={() => applySyncPreset("balanced")}>
                <span className="icon">
                  <IconScale />
                </span>{" "}
                Balanced
              </button>
              <button className="sync-preset-btn" onClick={() => applySyncPreset("power")}>
                <span className="icon">
                  <IconRocket />
                </span>{" "}
                Power
              </button>
            </div>
          </div>

          {/* Sync Sliders */}
          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Lookback window</span>
              <span className="settings-field-desc">How many days back to fetch</span>
            </div>
            <Slider
              variant="sync"
              id="sync-lookback"
              min={1}
              max={90}
              value={syncLookback}
              suffix=" days"
              onChange={setSyncLookback}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Authors per batch</span>
              <span className="settings-field-desc">How many authors per subscription request</span>
            </div>
            <Slider
              variant="sync"
              id="sync-batch-size"
              min={1}
              max={50}
              value={syncBatchSize}
              onChange={setSyncBatchSize}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Events per request</span>
              <span className="settings-field-desc">Max events per REQ</span>
            </div>
            <Slider
              variant="sync"
              id="sync-events-per-batch"
              min={10}
              max={500}
              step={10}
              value={syncEventsPerBatch}
              onChange={setSyncEventsPerBatch}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Pause between batches</span>
              <span className="settings-field-desc">
                Seconds to wait between subscription batches
              </span>
            </div>
            <Slider
              variant="sync"
              id="sync-batch-pause"
              min={0}
              max={30}
              value={syncBatchPause}
              suffix="s"
              onChange={setSyncBatchPause}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Min relay interval</span>
              <span className="settings-field-desc">
                Minimum seconds between requests to the same relay
              </span>
            </div>
            <Slider
              variant="sync"
              id="sync-relay-interval"
              min={0}
              max={10}
              value={syncRelayInterval}
              suffix="s"
              onChange={setSyncRelayInterval}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">WoT authors per batch</span>
              <span className="settings-field-desc">Authors per batch in WoT crawl</span>
            </div>
            <Slider
              variant="sync"
              id="sync-wot-batch"
              min={1}
              max={30}
              value={syncWotBatch}
              onChange={setSyncWotBatch}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">WoT events per request</span>
              <span className="settings-field-desc">Max events per REQ in WoT crawl</span>
            </div>
            <Slider
              variant="sync"
              id="sync-wot-events"
              min={5}
              max={100}
              value={syncWotEvents}
              onChange={setSyncWotEvents}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">Sync cycle interval</span>
              <span className="settings-field-desc">Minutes between full sync cycles</span>
            </div>
            <Slider
              variant="sync"
              id="sync-interval"
              min={1}
              max={60}
              value={syncInterval}
              suffix=" min"
              onChange={setSyncInterval}
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">WoT max depth</span>
              <span className="settings-field-desc">
                How many hops to compute in the trust graph
              </span>
            </div>
            <Slider
              variant="sync"
              id="sync-wot-depth"
              min={1}
              max={4}
              value={syncWotDepth}
              onChange={setSyncWotDepth}
            />
          </div>

          <button
            className="btn btn-primary"
            style={{ marginTop: 16, width: "100%" }}
            disabled={advancedSaving}
            onClick={handleSaveAdvanced}
          >
            {advancedSaving ? "Saving..." : "Save & Restart Sync"}
          </button>
          {advancedFeedback && (
            <div style={{ marginTop: 8, fontSize: "0.78rem", textAlign: "center" }}>
              <span style={{ color: advancedFeedback.type === "success" ? "#34d399" : "#ef4444" }}>
                {advancedFeedback.type === "success" && (
                  <span className="icon">
                    <IconCheckCircle />
                  </span>
                )}{" "}
                {advancedFeedback.message}
              </span>
            </div>
          )}

          {/* Low-level config */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <div className="settings-field">
              <div className="settings-field-info">
                <span className="settings-field-label">Relay port</span>
                <span className="settings-field-desc">Local WebSocket relay port</span>
              </div>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "0.85rem",
                  color: "var(--text-dim)",
                }}
              >
                {settings ? settings.relay_port : "\u2014"}
              </span>
            </div>

            <div className="settings-field">
              <div className="settings-field-info">
                <span className="settings-field-label">Auto-start</span>
                <span className="settings-field-desc">Start nostrito on login</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => setAutoStart(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="settings-field" style={{ borderBottom: "none", paddingBottom: 8 }}>
              <div className="settings-field-info">
                <span className="settings-field-label">Browser Integration</span>
                <span className="settings-field-desc">
                  Enable wss:// for web Nostr clients (Coracle, Snort, Primal)
                </span>
              </div>
            </div>
            <div
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "14px 18px",
                marginBottom: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: 2 }}>
                    {browserEnabled === null ? (
                      "Checking..."
                    ) : browserEnabled ? (
                      <>
                        <span className="icon">
                          <IconCheckCircle />
                        </span>{" "}
                        Enabled
                      </>
                    ) : (
                      "Not enabled"
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {browserEnabled
                      ? `wss://localhost:${settings?.relay_port ?? ""} available for web clients`
                      : "Web clients cannot connect without wss:// support"}
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: "0.8rem", padding: "8px 16px" }}
                  disabled={browserBusy}
                  onClick={handleEnableBrowser}
                >
                  {browserBusy ? "Setting up..." : browserEnabled ? "Regenerate" : "Enable"}
                </button>
              </div>
              {browserFeedback && (
                <div style={{ marginTop: 10 }}>
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: browserFeedback.type === "success" ? "#34d399" : "#ef4444",
                      marginTop: 6,
                    }}
                  >
                    {browserFeedback.type === "success" && (
                      <span className="icon">
                        <IconCheckCircle />
                      </span>
                    )}{" "}
                    {browserFeedback.message}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Danger Zone */}
          <div className="danger-zone">
            <div className="danger-zone-title">
              <span className="icon">
                <IconAlertTriangle />
              </span>{" "}
              Danger Zone
            </div>
            <div className="danger-zone-row">
              <div>
                <div className="danger-zone-label">Reset App Data</div>
                <div className="danger-zone-desc">
                  Clears all events, WoT graph, and config. Returns to setup wizard.
                </div>
              </div>
              <button className="btn-danger" onClick={handleResetApp}>
                Reset App Data
              </button>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Tab 5: Tracked Profiles                                         */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "tracked" ? " active" : ""}`} id="pane-tracked">
          <div className="settings-pane-title">Tracked Profiles</div>
          <div className="settings-pane-desc">
            These profiles are never pruned. Perfect for important follows.
          </div>

          <div
            style={{
              margin: "8px 0",
              maxHeight: 500,
              overflowY: "auto",
              fontSize: "0.82rem",
              color: "var(--text-dim)",
            }}
          >
            {trackedLoading ? (
              "Loading..."
            ) : trackedProfiles.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", padding: "4px 0" }}>
                No tracked profiles yet.
              </div>
            ) : (
              trackedProfiles.map((p) => {
                const profile = trackedProfileMap.get(p.pubkey);
                const hasName = !!(profile?.name || profile?.display_name);
                const displayName = profileDisplayName(profile, p.pubkey);
                const short = shortPubkey(p.pubkey);

                return (
                  <div
                    key={p.pubkey}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 4px",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <Avatar
                      picture={profile?.picture}
                      pubkey={p.pubkey}
                      className="tracked-profile-avatar"
                    />
                    <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: "0.84rem",
                          color: "var(--text)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {displayName}
                      </div>
                      {!hasName && (
                        <div
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "0.72rem",
                            color: "var(--text-muted)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={p.pubkey}
                        >
                          {short}
                        </div>
                      )}
                    </div>
                    <button
                      className="btn-untrack"
                      style={{
                        fontSize: "0.72rem",
                        padding: "4px 10px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        flexShrink: 0,
                        transition: "border-color 0.2s, color 0.2s",
                      }}
                      onClick={() => handleUntrackProfile(p.pubkey)}
                    >
                      Untrack
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              type="text"
              placeholder="npub or hex pubkey"
              value={trackInput}
              onChange={(e) => setTrackInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTrackProfile();
              }}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: "0.82rem",
                fontFamily: "var(--mono)",
              }}
            />
            <button
              className="btn btn-primary"
              style={{ fontSize: "0.82rem", padding: "8px 16px" }}
              onClick={handleTrackProfile}
            >
              Track
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
