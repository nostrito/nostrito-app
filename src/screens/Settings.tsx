import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { QRCodeSVG } from "qrcode.react";
import { RELAYS, resolveRelayUrl, urlToAlias } from "../relays";
import { profileDisplayName } from "../utils/profiles";
import { useProfileContext } from "../context/ProfileContext";
import { RelayCard } from "../components/RelayCard";
import { Slider } from "../components/Slider";
// Badge unused after storage tab redesign but kept for potential future use
// import { Badge } from "../components/Badge";
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
  IconFeather,
  IconArchive,
} from "../components/Icon";
import {
  STORAGE_PRESETS,
  STORAGE_PRESET_KEYS,
  estimateStorage,
} from "../utils/storagePresets";

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
  thread_retention_days: number;
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
  sync_wot_notes_per_cycle: number;
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
    wotNotes: number;
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
    wotNotes: 20,
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
    wotNotes: 50,
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
    wotNotes: 200,
    interval: 2,
  },
};

const TABS: { id: TabId; label: string; Icon: React.FC }[] = [
  { id: "identity", label: "identity", Icon: IconKey },
  { id: "relays", label: "relays", Icon: IconRadio },
  { id: "storage", label: "storage", Icon: IconDatabase },
  { id: "tracked", label: "tracked profiles", Icon: IconUsers },
  { id: "advanced", label: "advanced", Icon: IconSettingsIcon },
];

// Moved to advanced customize sliders — no longer need standalone preset buttons

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const StorageEstimationPanel: React.FC = () => {
  const [estimate, setEstimate] = useState<{
    follows_count: number;
    fof_estimate: number;
    events_per_day: number;
    bytes_per_day: number;
    projected_30d_bytes: number;
    current_db_size: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchEstimate = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<typeof estimate>("get_storage_estimate");
      setEstimate(data);
    } catch (e) {
      console.warn("[settings] storage estimate failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fmtBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: "0.84rem", fontWeight: 600, marginBottom: 8, color: "var(--accent-light)" }}>
        storage estimation (dev)
      </div>
      <button
        className="btn btn-secondary"
        style={{ fontSize: "0.78rem", padding: "6px 14px", marginBottom: 12 }}
        disabled={loading}
        onClick={fetchEstimate}
      >
        {loading ? "loading..." : "run estimate"}
      </button>
      {estimate && (
        <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", fontFamily: "var(--mono)", lineHeight: 1.8 }}>
          <div>follows: {estimate.follows_count}</div>
          <div>fof (est): ~{estimate.fof_estimate.toLocaleString()}</div>
          <div>events/day: ~{estimate.events_per_day.toFixed(0)}</div>
          <div>growth/day: ~{fmtBytes(estimate.bytes_per_day)}</div>
          <div>projected 30d: ~{fmtBytes(estimate.projected_30d_bytes)}</div>
          <div>current db: {fmtBytes(estimate.current_db_size)}</div>
        </div>
      )}
    </div>
  );
};

export const Settings: React.FC = () => {
  const { getProfile, ensureProfiles } = useProfileContext();

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
  const [storagePreset, setStoragePreset] = useState<string>("balanced");
  const [othersEventsGb, setOthersEventsGb] = useState(0);
  const [trackedMediaGb, setTrackedMediaGb] = useState(0);
  const [wotRetentionDays, setWotRetentionDays] = useState(0);
  const [threadRetentionDays, setThreadRetentionDays] = useState(0);
  const [wotMediaGb, setWotMediaGb] = useState(0);
  const [maxEventAgeDays, setMaxEventAgeDays] = useState(0);
  const [storageCustomMode, setStorageCustomMode] = useState(false);
  const [storageSaving, setStorageSaving] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<SaveFeedback | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<{ type: "success" | "error"; msg: string } | null>(null);

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
  const [syncWotNotes, setSyncWotNotes] = useState(50);
  const [autoStart, setAutoStart] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [advancedFeedback, setAdvancedFeedback] = useState<SaveFeedback | null>(null);
  const [resetDefaultsFeedback, setResetDefaultsFeedback] = useState<SaveFeedback | null>(null);

  /* --- data directory ------------------------------------------------ */
  const [dataDir, setDataDir] = useState("");
  const [defaultDataDir, setDefaultDataDir] = useState("");
  const [platform, setPlatform] = useState("macos");
  const [dataDirChanging, setDataDirChanging] = useState(false);
  const [dataDirFeedback, setDataDirFeedback] = useState<SaveFeedback | null>(null);

  /* --- browser integration ------------------------------------------ */
  const [browserEnabled, setBrowserEnabled] = useState<boolean | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserFeedback, setBrowserFeedback] = useState<SaveFeedback | null>(null);

  /* --- tracked profiles --------------------------------------------- */
  const [trackedProfiles, setTrackedProfiles] = useState<TrackedProfile[]>([]);
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

  /* --- NIP-46 bunker / connect ------------------------------------- */
  const [bunkerExpanded, setBunkerExpanded] = useState(false);
  const [bunkerUri, setBunkerUri] = useState("");
  const [bunkerConnecting, setBunkerConnecting] = useState(false);
  const [bunkerFeedback, setBunkerFeedback] = useState<SaveFeedback | null>(null);
  const [connectExpanded, setConnectExpanded] = useState(false);
  const [connectRelay, setConnectRelay] = useState("wss://relay.nsec.app");
  const [connectUri, setConnectUri] = useState("");
  const [connectWaiting, setConnectWaiting] = useState(false);
  const [connectFeedback, setConnectFeedback] = useState<SaveFeedback | null>(null);

  /* --- load settings on mount --------------------------------------- */
  useEffect(() => {
    loadSettings();
    // Fetch data directory info
    Promise.all([
      invoke<string>("get_data_dir"),
      invoke<string>("get_default_data_dir"),
      invoke<string>("get_platform"),
    ]).then(([dir, defDir, plat]) => {
      setDataDir(dir);
      setDefaultDataDir(defDir);
      setPlatform(plat);
    }).catch(() => {});
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
      setOthersEventsGb(Math.round(s.storage_others_gb));
      setTrackedMediaGb(Math.round(s.storage_tracked_media_gb));
      setWotMediaGb(Math.round(s.storage_wot_media_gb));
      setWotRetentionDays(s.wot_event_retention_days);
      setThreadRetentionDays(s.thread_retention_days);
      setMaxEventAgeDays(s.max_event_age_days);

      // Detect active storage preset by matching values
      for (const key of STORAGE_PRESET_KEYS) {
        const p = STORAGE_PRESETS[key];
        if (
          Math.round(s.storage_others_gb) === p.othersEventsGb &&
          Math.round(s.storage_tracked_media_gb) === p.trackedMediaGb &&
          Math.round(s.storage_wot_media_gb) === p.wotMediaGb &&
          s.wot_event_retention_days === p.wotRetentionDays
        ) {
          setStoragePreset(key);
          break;
        }
      }

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
      setSyncWotNotes(s.sync_wot_notes_per_cycle);
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
        ensureProfiles(pubkeys);
      }
    } catch (e) {
      console.error("[settings] get_tracked_profiles failed:", e);
    } finally {
      setTrackedLoading(false);
    }
  }, [ensureProfiles]);

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
      setRelayFeedback({ type: "error", message: "select at least one relay" });
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
      setRelayFeedback({ type: "success", message: "relays saved \u2014 sync restarted" });
    } catch (e) {
      setRelayFeedback({ type: "error", message: `failed: ${e}` });
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
      storage_others_gb: othersEventsGb,
      storage_tracked_media_gb: trackedMediaGb,
      storage_wot_media_gb: wotMediaGb,
      wot_event_retention_days: wotRetentionDays,
      thread_retention_days: threadRetentionDays,
      max_event_age_days: maxEventAgeDays,
      sync_wot_notes_per_cycle: syncWotNotes,
    };

    try {
      await invoke("save_settings", { settings: updated });
      setSettings(updated);
      setStorageFeedback({ type: "success", message: "storage settings saved" });
    } catch (e) {
      setStorageFeedback({ type: "error", message: `failed: ${e}` });
    } finally {
      setStorageSaving(false);
    }
  }, [settings, othersEventsGb, trackedMediaGb, wotMediaGb, wotRetentionDays, threadRetentionDays, maxEventAgeDays, syncWotNotes]);

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
      sync_wot_notes_per_cycle: syncWotNotes,
    };

    try {
      await invoke("save_settings", { settings: updated });
      setSettings(updated);
      await invoke("restart_sync");
      setAdvancedFeedback({ type: "success", message: "saved \u2014 sync restarted with new config" });
    } catch (e) {
      setAdvancedFeedback({ type: "error", message: `failed: ${e}` });
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
    setSyncWotNotes(50);
    setResetDefaultsFeedback({
      type: "success",
      message: 'defaults restored \u2014 click "save & restart sync" to apply',
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
    setSyncWotNotes(p.wotNotes);
    setSyncInterval(p.interval);
  }, []);

  const applyStoragePreset = useCallback((presetKey: string) => {
    const p = STORAGE_PRESETS[presetKey];
    if (!p) return;
    setStoragePreset(presetKey);
    setOthersEventsGb(p.othersEventsGb);
    setTrackedMediaGb(p.trackedMediaGb);
    setWotMediaGb(p.wotMediaGb);
    setWotRetentionDays(p.wotRetentionDays);
    setMaxEventAgeDays(p.maxEventAgeDays);
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

  /* --- NIP-46 handlers ---------------------------------------------- */
  const handleConnectBunkerSettings = useCallback(async () => {
    if (!bunkerUri.trim().startsWith("bunker://")) return;
    setBunkerConnecting(true);
    setBunkerFeedback(null);
    try {
      await invoke<string>("connect_bunker", { bunkerUri: bunkerUri.trim() });
      setSigningMode("bunker");
      setBunkerExpanded(false);
      setBunkerUri("");
      setBunkerFeedback({ type: "success", message: "Connected to bunker" });
    } catch (e: any) {
      setBunkerFeedback({ type: "error", message: String(e) });
    } finally {
      setBunkerConnecting(false);
    }
  }, [bunkerUri]);

  const handleGenerateConnectUriSettings = useCallback(async () => {
    setConnectFeedback(null);
    try {
      const result = await invoke<string>("generate_nostr_connect_uri", { relayUrl: connectRelay });
      const parsed = JSON.parse(result);
      setConnectUri(parsed.uri);
      setConnectWaiting(true);
      try {
        await invoke<string>("await_nostr_connect", {
          nostrConnectUri: parsed.uri,
          appKeysNsec: parsed.app_keys_nsec,
        });
        setSigningMode("connect");
        setConnectExpanded(false);
        setConnectUri("");
        setConnectFeedback({ type: "success", message: "Connected via Nostr Connect" });
      } catch (e: any) {
        setConnectFeedback({ type: "error", message: `Connection failed: ${e}` });
      } finally {
        setConnectWaiting(false);
      }
    } catch (e: any) {
      setConnectFeedback({ type: "error", message: String(e) });
    }
  }, [connectRelay]);

  const handleDisconnectBunker = useCallback(async () => {
    try {
      await invoke("disconnect_bunker");
      setSigningMode("read-only");
      setBunkerFeedback({ type: "success", message: "Signer disconnected" });
      setConnectFeedback(null);
    } catch (e: any) {
      setBunkerFeedback({ type: "error", message: String(e) });
    }
  }, []);

  const [changeAccountConfirm, setChangeAccountConfirm] = useState(false);

  const handleChangeAccount = useCallback(async () => {
    if (!changeAccountConfirm) {
      setChangeAccountConfirm(true);
      return;
    }
    try {
      console.log("[settings] Calling change_account...");
      await invoke("change_account");
      console.log("[settings] change_account complete — identity cleared, events preserved");
      // app:reset event from backend handles navigation via App.tsx listener
    } catch (e) {
      console.error("[settings] Change account failed:", e);
      setChangeAccountConfirm(false);
    }
  }, [changeAccountConfirm]);

  const [resetSyncBusy, setResetSyncBusy] = useState(false);
  const [resetSyncConfirm, setResetSyncConfirm] = useState(false);

  const handleResetSync = useCallback(async () => {
    if (!resetSyncConfirm) {
      setResetSyncConfirm(true);
      return;
    }
    setResetSyncBusy(true);
    try {
      await invoke("reset_sync_cursors");
      setAdvancedFeedback({ type: "success", message: "sync cursors cleared — resyncing from scratch" });
    } catch (e) {
      setAdvancedFeedback({ type: "error", message: `reset failed: ${e}` });
    } finally {
      setResetSyncBusy(false);
      setResetSyncConfirm(false);
    }
  }, [resetSyncConfirm]);

  const [resetAppConfirm, setResetAppConfirm] = useState(false);

  const handleResetApp = useCallback(async () => {
    if (!resetAppConfirm) {
      setResetAppConfirm(true);
      return;
    }
    try {
      console.log("[settings] Calling reset_app_data...");
      await invoke("reset_app_data");
      console.log("[settings] reset_app_data complete");
      // app:reset event from backend handles navigation via App.tsx listener
    } catch (e) {
      console.error("[settings] Reset failed:", e);
      setResetAppConfirm(false);
    }
  }, [resetAppConfirm]);

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
        message: `wss://localhost:${settings.relay_port} active \u2014 relay restarted with tls`,
      });
    } catch (e) {
      setBrowserFeedback({ type: "error", message: `failed: ${e}` });
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
                  offline mode
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {offlineMode
                    ? "all relay sync is paused. working with local data only."
                    : "disable all outbound connections and work with downloaded data"}
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
          <div className="settings-pane-title">identity</div>
          <div className="settings-pane-desc">your nostr identity.</div>

          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">public key</span>
              <span className="settings-field-desc">your npub used for wot computation</span>
            </div>
          </div>
          <div className="settings-mono" id="settings-npub">
            {settings ? settings.npub || "not configured" : "loading..."}
          </div>

          <div className="settings-field" style={{ borderBottom: "none", paddingBottom: 8 }}>
            <div className="settings-field-info">
              <span className="settings-field-label">signing mode</span>
              <span className="settings-field-desc">how events are signed</span>
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
                  <span>key stored in system keychain</span>
                  <button
                    onClick={handleClearNsec}
                    style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "0.72rem", textDecoration: "underline" }}
                  >
                    remove
                  </button>
                </div>
              </>
            ) : signingMode === "bunker" || signingMode === "connect" ? (
              <>
                <div style={{ fontSize: "0.85rem", color: "var(--accent)", marginBottom: 2 }}>
                  <span className="icon">
                    {signingMode === "bunker" ? <IconCastle /> : <IconPlug />}
                  </span>{" "}
                  {signingMode === "bunker" ? "NBunker" : "Nostr Connect"} (full access)
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>remote signer connected</span>
                  <button
                    onClick={handleDisconnectBunker}
                    style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "0.72rem", textDecoration: "underline" }}
                  >
                    disconnect
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: 2 }}>
                  <span className="icon">
                    <IconLock />
                  </span>{" "}
                  read-only mode
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  dms disabled. connect a signer to unlock full access.
                </div>
              </>
            )}
          </div>

          <div className="settings-field" style={{ borderBottom: "none", paddingBottom: 8 }}>
            <div className="settings-field-info">
              <span className="settings-field-label">connect signer</span>
              <span className="settings-field-desc">upgrade to full access</span>
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
                paste nsec
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>full access</span>
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
                    {nsecSaving ? "saving..." : "save to keychain"}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setNsecExpanded(false); setNsecInput(""); setNsecFeedback(null); }}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "0.78rem" }}
                  >
                    cancel
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
              onClick={() => { setBunkerExpanded(!bunkerExpanded); setConnectExpanded(false); }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                background: "var(--bg)",
                border: bunkerExpanded ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: bunkerExpanded ? "10px 10px 0 0" : 10,
                cursor: "pointer",
                transition: "border-color 0.2s",
              }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                <span className="icon">
                  <IconCastle />
                </span>{" "}
                nbunker
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>remote signer</span>
            </div>
            {bunkerExpanded && (
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
                  type="text"
                  value={bunkerUri}
                  onChange={(e) => setBunkerUri(e.target.value)}
                  placeholder="bunker://..."
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
                    onClick={(e) => { e.stopPropagation(); handleConnectBunkerSettings(); }}
                    disabled={bunkerConnecting || !bunkerUri.trim().startsWith("bunker://")}
                    style={{ fontSize: "0.8rem", padding: "6px 16px" }}
                  >
                    {bunkerConnecting ? "connecting..." : "connect"}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setBunkerExpanded(false); setBunkerUri(""); setBunkerFeedback(null); }}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "0.78rem" }}
                  >
                    cancel
                  </button>
                </div>
                {bunkerFeedback && (
                  <div style={{ marginTop: 8, fontSize: "0.78rem", color: bunkerFeedback.type === "success" ? "var(--accent)" : "var(--danger)" }}>
                    {bunkerFeedback.message}
                  </div>
                )}
              </div>
            )}
            <div
              onClick={() => { setConnectExpanded(!connectExpanded); setBunkerExpanded(false); }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                background: "var(--bg)",
                border: connectExpanded ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: connectExpanded ? "10px 10px 0 0" : 10,
                cursor: "pointer",
                transition: "border-color 0.2s",
              }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                <span className="icon">
                  <IconPlug />
                </span>{" "}
                nostr connect
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>NIP-46</span>
            </div>
            {connectExpanded && (
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
                {!connectUri ? (
                  <>
                    <input
                      type="text"
                      value={connectRelay}
                      onChange={(e) => setConnectRelay(e.target.value)}
                      placeholder="wss://relay.nsec.app"
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
                        onClick={(e) => { e.stopPropagation(); handleGenerateConnectUriSettings(); }}
                        style={{ fontSize: "0.8rem", padding: "6px 16px" }}
                      >
                        generate URI
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConnectExpanded(false); setConnectFeedback(null); }}
                        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "0.78rem" }}
                      >
                        cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                      Scan with your signer app or copy the URI:
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                      <div style={{
                        padding: 10, background: "#fff", borderRadius: 10,
                        display: "inline-flex",
                      }}>
                        <QRCodeSVG value={connectUri} size={160} level="M" />
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
                        <code style={{
                          fontSize: "0.68rem", flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap", padding: "8px", background: "var(--bg-card)", borderRadius: 6,
                          border: "1px solid var(--border)", color: "var(--text-dim)",
                        }}>
                          {connectUri}
                        </code>
                        <button
                          className="btn btn-secondary"
                          onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(connectUri); }}
                          title="Copy"
                          style={{ flexShrink: 0, fontSize: "0.78rem", padding: "6px 10px" }}
                        >
                          copy
                        </button>
                      </div>
                    </div>
                    {connectWaiting && (
                      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center" }}>
                        Waiting for signer to connect...
                      </p>
                    )}
                  </div>
                )}
                {connectFeedback && (
                  <div style={{ marginTop: 8, fontSize: "0.78rem", color: connectFeedback.type === "success" ? "var(--accent)" : "var(--danger)" }}>
                    {connectFeedback.message}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="danger-zone">
            <div className="danger-zone-row">
              <div>
                <div className="danger-zone-label">change account</div>
                <div className="danger-zone-desc">
                  remove your npub and start over. keeps your event data.
                </div>
              </div>
              <button className="btn-danger" id="btn-change-account" onClick={handleChangeAccount}>
                {changeAccountConfirm ? "are you sure?" : "change account"}
              </button>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Tab 2: Relays                                                   */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "relays" ? " active" : ""}`} id="pane-relays">
          <div className="settings-pane-title">relays</div>
          <div className="settings-pane-desc">
            pick which relays to sync from. changes take effect after saving.
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
            {relaySaving ? "saving..." : "save relays"}
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
          <div className="settings-pane-title">storage</div>
          <div className="settings-pane-desc">
            control what gets stored, organized by ownership.
          </div>

          {/* Data Location */}
          {platform !== "android" && (
            <div className="storage-category-section">
              <div className="storage-category-header">
                <span className="storage-category-title">data location</span>
              </div>
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">
                      {dataDir && defaultDataDir && dataDir !== defaultDataDir ? "custom path" : "default path"}
                    </span>
                    <span className="storage-row-meta" style={{ wordBreak: "break-all" }}>
                      {dataDir || "loading..."}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {dataDir && defaultDataDir && dataDir !== defaultDataDir && (
                      <button
                        className="btn btn-secondary"
                        disabled={dataDirChanging}
                        onClick={async () => {
                          if (!confirm("Reset to default path? You can choose to move your data or start fresh.")) return;
                          setDataDirChanging(true);
                          try {
                            const shouldMigrate = confirm("Move existing data to the default location?\n\nOK = Move data\nCancel = Start fresh");
                            await invoke("set_data_dir", { path: defaultDataDir, migrate: shouldMigrate });
                            setDataDirFeedback({ type: "success", message: "Path updated. Restarting..." });
                            const { relaunch } = await import("@tauri-apps/plugin-process");
                            setTimeout(() => relaunch(), 500);
                          } catch (e: any) {
                            setDataDirFeedback({ type: "error", message: String(e) });
                            setDataDirChanging(false);
                          }
                        }}
                      >
                        reset
                      </button>
                    )}
                    <button
                      className="btn btn-secondary"
                      disabled={dataDirChanging}
                      onClick={async () => {
                        try {
                          const selected = await open({ directory: true, multiple: false, title: "Choose data folder" });
                          if (!selected || typeof selected !== "string") return;
                          if (selected === dataDir) return;
                          const shouldMigrate = confirm("Move existing data to the new location?\n\nOK = Move data\nCancel = Start fresh");
                          setDataDirChanging(true);
                          await invoke("set_data_dir", { path: selected, migrate: shouldMigrate });
                          setDataDirFeedback({ type: "success", message: "Path updated. Restarting..." });
                          const { relaunch } = await import("@tauri-apps/plugin-process");
                          setTimeout(() => relaunch(), 500);
                        } catch (e: any) {
                          setDataDirFeedback({ type: "error", message: String(e) });
                          setDataDirChanging(false);
                        }
                      }}
                    >
                      {dataDirChanging ? "moving..." : "change..."}
                    </button>
                  </div>
                </div>
                {dataDirFeedback && (
                  <p style={{ fontSize: 12, color: dataDirFeedback.type === "error" ? "var(--red)" : "var(--green)", marginTop: 4 }}>
                    {dataDirFeedback.message}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Your events & media — always kept */}
          <div className="storage-section">
            <div className="storage-row locked">
              <div className="storage-row-info">
                <span className="storage-row-label">your events &amp; media</span>
                <span className="storage-row-meta">
                  <span className="icon"><IconLock /></span> always stored. no exceptions.
                </span>
              </div>
            </div>
          </div>

          {/* Preset cards — same as wizard */}
          <div className="storage-preset-grid">
            {STORAGE_PRESET_KEYS.map((key) => {
              const preset = STORAGE_PRESETS[key];
              const isSelected = storagePreset === key;
              const ICONS: Record<string, React.ReactNode> = {
                personal: <IconUsers />, minimal: <IconFeather />,
                balanced: <IconScale />, archive: <IconArchive />,
              };
              const DETAILS: Record<string, string[]> = {
                personal: ["your own events only", "tracked profiles: full history", "no WoT sync, no media from others"],
                minimal: ["last 3 days for follows only", "tracked profiles: full history", "images only, no WoT media"],
                balanced: ["last 30 days for follows, 7 days for WoT", "tracked profiles: full history", "all media types, 2 GB WoT media"],
                archive: ["last year for follows, 90 days for WoT", "tracked profiles: full history", "all media types, 10 GB WoT media"],
              };
              return (
                <div
                  key={key}
                  className={`storage-preset-card${isSelected ? " selected" : ""}`}
                  onClick={() => applyStoragePreset(key)}
                >
                  <div className="storage-preset-card-header">
                    <span className="icon">{ICONS[key]}</span>
                    <span className="storage-preset-card-name">{preset.label}</span>
                  </div>
                  <span className="storage-preset-card-size">
                    {preset.estimatedGb.typical < 1
                      ? `~${Math.round(preset.estimatedGb.low * 1000)}-${Math.round(preset.estimatedGb.typical * 1000)} MB`
                      : `~${preset.estimatedGb.low}-${preset.estimatedGb.typical} GB`}
                  </span>
                  <p className="storage-preset-card-desc">{preset.description}</p>
                  <ul className="storage-preset-card-details">
                    {(DETAILS[key] || []).map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </div>
              );
            })}
          </div>

          {/* Estimation summary */}
          {(() => {
            const estimate = estimateStorage(200, storagePreset);
            return (
              <div className="storage-estimate-summary" style={{ margin: "12px 0" }}>
                {estimate.eventsPerDay === 0
                  ? "only your own events will be stored locally"
                  : `with ~200 follows: ~${estimate.eventsPerDay.toLocaleString()} events/day, ~${estimate.growthGbPerMonth} GB/month`}
              </div>
            );
          })()}

          {/* Customize toggle */}
          <div className="storage-custom-toggle" onClick={() => setStorageCustomMode((p) => !p)}>
            {storageCustomMode ? "hide" : "customize"} advanced settings
          </div>

          {/* Advanced sliders — shown when customize is on */}
          {storageCustomMode && (
            <>
              {/* Others' events */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">others' events</span>
                    <span className="storage-row-meta">from your web of trust (0 = disabled)</span>
                  </div>
                  <Slider variant="storage" id="settings-others-events" min={0} max={50} value={othersEventsGb} suffix=" GB" onChange={setOthersEventsGb} />
                </div>
              </div>

              {/* Tracked profiles media */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">tracked profiles media</span>
                    <span className="storage-row-meta">media from profiles you track</span>
                  </div>
                  <Slider variant="storage" id="settings-tracked-media-slider" min={0} max={50} value={trackedMediaGb} suffix=" GB" onChange={setTrackedMediaGb} />
                </div>
              </div>

              {/* WoT media */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">WoT media</span>
                    <span className="storage-row-meta">images, videos, audio from your network (0 = disabled)</span>
                  </div>
                  <Slider variant="storage" id="settings-wot-media-slider" min={0} max={50} value={wotMediaGb} suffix=" GB" onChange={setWotMediaGb} />
                </div>
              </div>

              {/* WoT retention */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">WoT event retention</span>
                    <span className="storage-row-meta">how long to keep WoT events before pruning (0 = don't keep)</span>
                  </div>
                  <Slider variant="storage" id="storage-wot-retention" min={0} max={365} value={wotRetentionDays} suffix=" days" onChange={setWotRetentionDays} />
                </div>
              </div>

              {/* Max event age */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">max event age</span>
                    <span className="storage-row-meta">global max age for non-own events (0 = no limit)</span>
                  </div>
                  <Slider variant="storage" id="storage-max-age" min={0} max={365} value={maxEventAgeDays} suffix=" days" onChange={setMaxEventAgeDays} />
                </div>
              </div>

              {/* Thread follow-up */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">thread follow-up window</span>
                    <span className="storage-row-meta">how long to keep re-fetching replies for threads you've interacted with</span>
                  </div>
                  <Slider variant="storage" id="storage-thread-retention" min={0} max={90} value={threadRetentionDays} suffix=" days" onChange={setThreadRetentionDays} />
                </div>
              </div>

              {/* WoT notes per cycle */}
              <div className="storage-section">
                <div className="storage-row">
                  <div className="storage-row-info">
                    <span className="storage-row-label">WoT notes per cycle</span>
                    <span className="storage-row-meta">random notes fetched from WoT peers each sync cycle (0 = disabled)</span>
                  </div>
                  <Slider variant="storage" id="storage-wot-notes" min={0} max={500} value={syncWotNotes} suffix="" onChange={setSyncWotNotes} />
                </div>
              </div>

              {/* Prune button */}
              <div className="storage-section">
                <div className="storage-row" style={{ alignItems: "center" }}>
                  <div className="storage-row-info">
                    <span className="storage-row-label">prune WoT data</span>
                    <span className="storage-row-meta">manually delete old events based on retention settings</span>
                  </div>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: "0.78rem", padding: "6px 14px", whiteSpace: "nowrap" }}
                    disabled={pruning}
                    onClick={async () => {
                      setPruning(true);
                      setPruneResult(null);
                      try {
                        const msg = await invoke<string>("prune_wot_data");
                        setPruneResult({ type: "success", msg });
                      } catch (e) {
                        setPruneResult({ type: "error", msg: String(e) });
                      } finally {
                        setPruning(false);
                      }
                    }}
                  >
                    {pruning ? "pruning..." : "prune now"}
                  </button>
                </div>
                {pruneResult && (
                  <div style={{ fontSize: "0.75rem", marginTop: 6, color: pruneResult.type === "success" ? "#34d399" : "#ef4444" }}>
                    {pruneResult.msg}
                  </div>
                )}
              </div>
            </>
          )}

          <button
            className="btn btn-primary"
            style={{ marginTop: 16, width: "100%" }}
            disabled={storageSaving}
            onClick={handleSaveStorage}
          >
            {storageSaving ? "saving..." : "save storage settings"}
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
          <div className="settings-pane-title">advanced</div>
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
              these settings are for advanced users. the defaults work well for most people.
            </div>
          </div>

          <button
            className="btn btn-secondary"
            style={{ width: "100%", marginBottom: 20 }}
            onClick={handleResetDefaults}
          >
            reset to defaults
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
              sync presets
            </div>
            <div className="sync-presets">
              <button className="sync-preset-btn" onClick={() => applySyncPreset("light")}>
                <span className="icon">
                  <IconTurtle />
                </span>{" "}
                light
              </button>
              <button className="sync-preset-btn" onClick={() => applySyncPreset("balanced")}>
                <span className="icon">
                  <IconScale />
                </span>{" "}
                balanced
              </button>
              <button className="sync-preset-btn" onClick={() => applySyncPreset("power")}>
                <span className="icon">
                  <IconRocket />
                </span>{" "}
                power
              </button>
            </div>
          </div>

          {/* Sync Sliders */}
          <div className="settings-field">
            <div className="settings-field-info">
              <span className="settings-field-label">lookback window</span>
              <span className="settings-field-desc">how many days back to fetch</span>
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
              <span className="settings-field-label">authors per batch</span>
              <span className="settings-field-desc">how many authors per subscription request</span>
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
              <span className="settings-field-label">events per request</span>
              <span className="settings-field-desc">max events per REQ</span>
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
              <span className="settings-field-label">pause between batches</span>
              <span className="settings-field-desc">
                seconds to wait between subscription batches
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
              <span className="settings-field-label">min relay interval</span>
              <span className="settings-field-desc">
                minimum seconds between requests to the same relay
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
              <span className="settings-field-label">wot authors per batch</span>
              <span className="settings-field-desc">authors per batch in wot crawl</span>
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
              <span className="settings-field-label">wot events per request</span>
              <span className="settings-field-desc">max events per REQ in wot crawl</span>
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
              <span className="settings-field-label">sync cycle interval</span>
              <span className="settings-field-desc">minutes between full sync cycles</span>
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
              <span className="settings-field-label">wot max depth</span>
              <span className="settings-field-desc">
                how many hops to compute in the trust graph
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
            {advancedSaving ? "saving..." : "save & restart sync"}
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

          <button
            className="btn"
            style={{ marginTop: 12, width: "100%", background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            disabled={resetSyncBusy}
            onClick={handleResetSync}
          >
            {resetSyncBusy ? "resetting..." : resetSyncConfirm ? "are you sure? click again to confirm" : "reset sync from scratch"}
          </button>

          {/* Low-level config */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <div className="settings-field">
              <div className="settings-field-info">
                <span className="settings-field-label">relay port</span>
                <span className="settings-field-desc">local websocket relay port</span>
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
                <span className="settings-field-label">auto-start</span>
                <span className="settings-field-desc">start nostrito on login</span>
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
                <span className="settings-field-label">browser integration</span>
                <span className="settings-field-desc">
                  enable wss:// for web nostr clients (coracle, snort, primal)
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
                      "checking..."
                    ) : browserEnabled ? (
                      <>
                        <span className="icon">
                          <IconCheckCircle />
                        </span>{" "}
                        enabled
                      </>
                    ) : (
                      "not enabled"
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {browserEnabled
                      ? `wss://localhost:${settings?.relay_port ?? ""} available for web clients`
                      : "web clients cannot connect without wss:// support"}
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: "0.8rem", padding: "8px 16px" }}
                  disabled={browserBusy}
                  onClick={handleEnableBrowser}
                >
                  {browserBusy ? "setting up..." : browserEnabled ? "regenerate" : "enable"}
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

          {/* Storage Estimation (dev mode only) */}
          {import.meta.env.DEV && (
            <StorageEstimationPanel />
          )}

          {/* Danger Zone */}
          <div className="danger-zone">
            <div className="danger-zone-title">
              <span className="icon">
                <IconAlertTriangle />
              </span>{" "}
              danger zone
            </div>
            <div className="danger-zone-row">
              <div>
                <div className="danger-zone-label">reset app data</div>
                <div className="danger-zone-desc">
                  clears all events, wot graph, and config. returns to setup wizard.
                </div>
              </div>
              <button className="btn-danger" onClick={handleResetApp}>
                {resetAppConfirm ? "are you sure?" : "reset app data"}
              </button>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/*  Tab 5: Tracked Profiles                                         */}
        {/* ================================================================ */}
        <div className={`settings-pane${activeTab === "tracked" ? " active" : ""}`} id="pane-tracked">
          <div className="settings-pane-title">tracked profiles</div>
          <div className="settings-pane-desc">
            these profiles are never pruned. perfect for important follows.
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
              "loading..."
            ) : trackedProfiles.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", padding: "4px 0" }}>
                no tracked profiles yet.
              </div>
            ) : (
              trackedProfiles.map((p) => {
                const profile = getProfile(p.pubkey);
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
                      pictureLocal={profile?.picture_local}
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
                      untrack
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
              track
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
