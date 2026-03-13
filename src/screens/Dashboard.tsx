import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconChili } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useInterval } from "../hooks/useInterval";
import { getProfiles, invalidateProfileCache, profileDisplayName, type ProfileInfo } from "../utils/profiles";
import type {
  AppStatus,
  SyncProgress,
  SyncStats,
  RelayStatusInfo,
  StoredEventNotification,
} from "../types/nostr";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const LIVE_STREAM_MAX = 50;

interface LiveEntry {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  ts: number; // local timestamp (Date.now())
  layer: string;
}

const LAYER_IDS = ["0", "05", "1", "2"] as const;
type LayerId = (typeof LAYER_IDS)[number];

const LAYER_LABELS: Record<LayerId, string> = {
  "0": "Layer 0 \u2014 Own Content",
  "05": "Layer 0.5 \u2014 Tracked",
  "1": "Layer 1 \u2014 Direct Follows",
  "2": "Layer 2 \u2014 WoT Peers",
};

const LAYER_TO_BACKEND: Record<LayerId, string> = {
  "0": "0",
  "05": "0.5",
  "1": "1",
  "2": "2",
};

const LAYER_ORDER = ["0", "0.5", "1", "2", "3"];

function kindLabel(kind: number): string {
  switch (kind) {
    case 1: return "note";
    case 6: return "repost";
    case 7: return "reaction";
    case 4: return "dm";
    case 0: return "profile";
    case 3: return "contacts";
    default: return `k:${kind}`;
  }
}

function kindCssClass(kind: number): string {
  if (kind === 1) return "live-kind-note";
  if (kind === 6) return "live-kind-repost";
  return "live-kind-other";
}

function layerLabel(layer: string): string {
  switch (layer) {
    case "0": return "L0";
    case "0.5": return "T";
    case "1": return "L1";
    case "2": return "L2";
    case "3": return "L3";
    case "thread": return "Th";
    default: return "";
  }
}

function layerCssClass(layer: string): string {
  switch (layer) {
    case "0": return "live-layer-own";
    case "0.5": return "live-layer-tracked";
    case "1": return "live-layer-follows";
    case "2": return "live-layer-fof";
    case "3": return "live-layer-hop3";
    default: return "live-layer-other";
  }
}

function formatUptime(seconds: number): string {
  if (seconds > 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds > 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

/* ------------------------------------------------------------------ */
/*  Sync layer badge helpers                                           */
/* ------------------------------------------------------------------ */

interface LayerBadge {
  text: string;
  className: string;
}

function getLayerBadge(layerId: LayerId, currentLayer: string, wotNotes?: number): LayerBadge {
  const backendLayer = LAYER_TO_BACKEND[layerId];

  // Show DISABLED for Layer 2 when WoT notes is 0
  if (layerId === "2" && wotNotes === 0) {
    return { text: "OFF", className: "sync-tier-badge disabled" };
  }

  if (currentLayer === backendLayer) {
    return { text: "FAST", className: "sync-tier-badge fast" };
  }
  if (
    currentLayer !== "" &&
    LAYER_ORDER.indexOf(backendLayer) < LAYER_ORDER.indexOf(currentLayer)
  ) {
    return { text: "\u2713", className: "sync-tier-badge done" };
  }
  return { text: "IDLE", className: "sync-tier-badge idle" };
}

function getLayerDetail(
  layerId: LayerId,
  syncStats: SyncStats,
  currentLayer: string,
  progressRelay?: string,
  wotNotes?: number
): string {
  const backendLayer = LAYER_TO_BACKEND[layerId];
  const isActive = currentLayer === backendLayer;
  const s = syncStats;

  // Layer 2 disabled
  if (layerId === "2" && wotNotes === 0) {
    const count = (s.tier3_fetched || 0) + (s.tier4_fetched || 0);
    return count > 0 ? `${count} events \u00b7 disabled` : "disabled";
  }

  // Build progress string like "42/200" when a content pass is running
  let progressStr = "";
  if (isActive && s.pass_pubkeys_total > 0) {
    progressStr = `${s.pass_pubkeys_done}/${s.pass_pubkeys_total}`;
  }

  let count = 0;
  switch (layerId) {
    case "0":
      count = s.tier1_fetched;
      break;
    case "05":
      count = s.tracked_fetched || 0;
      break;
    case "1":
      count = s.tier2_fetched;
      break;
    case "2":
      count = (s.tier3_fetched || 0) + (s.tier4_fetched || 0);
      break;
  }

  // For Layer 1, append follows count
  const followsSuffix = layerId === "1" && s.follows_count > 0
    ? ` \u00b7 ${s.follows_count} follows`
    : "";

  if (isActive && progressStr) {
    return count > 0
      ? `${count} events \u00b7 ${progressStr}${followsSuffix}`
      : `fetching \u00b7 ${progressStr}${followsSuffix}`;
  }

  if (count > 0) return `${count} events${followsSuffix}`;

  if (isActive) {
    return progressRelay ? `fetching \u00b7 ${progressRelay}` : "fetching...";
  }

  const isDone =
    currentLayer !== "" &&
    LAYER_ORDER.indexOf(backendLayer) < LAYER_ORDER.indexOf(currentLayer);
  return isDone ? `complete${followsSuffix}` : "\u2014";
}

/* ------------------------------------------------------------------ */
/*  Module-level live stream cache (survives component remounts)       */
/* ------------------------------------------------------------------ */

let cachedLiveStream: LiveEntry[] = [];
let cachedProfileMap: Map<string, ProfileInfo> = new Map();

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  /* --- state -------------------------------------------------------- */
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [uptime, setUptime] = useState<number>(0);
  const [activityData, setActivityData] = useState<number[]>(new Array(24).fill(0));
  const [relays, setRelays] = useState<RelayStatusInfo[]>([]);
  const [relaysLoaded, setRelaysLoaded] = useState(false);
  /* --- live event stream state (initialized from cache) ------------- */
  const [liveStream, setLiveStream] = useState<LiveEntry[]>(cachedLiveStream);
  const [liveProfileMap, setLiveProfileMap] = useState<Map<string, ProfileInfo>>(cachedProfileMap);
  const liveStreamRef = useRef<LiveEntry[]>(cachedLiveStream);
  const pendingProfilesRef = useRef<Set<string>>(new Set());
  const profileFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* --- Tauri event listeners ---------------------------------------- */
  const syncProgress = useTauriEvent<SyncProgress>("sync:progress");
  const tierComplete = useTauriEvent<{ tier: number }>("sync:tier_complete");

  /* --- live event stream listener ------------------------------------ */
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const queueProfileFetch = (pubkey: string) => {
      if (!pendingProfilesRef.current.has(pubkey)) {
        pendingProfilesRef.current.add(pubkey);
        if (!profileFlushTimerRef.current) {
          profileFlushTimerRef.current = setTimeout(() => {
            const pks = [...pendingProfilesRef.current];
            pendingProfilesRef.current.clear();
            profileFlushTimerRef.current = null;
            getProfiles(pks).then((profiles) => {
              setLiveProfileMap((prev) => {
                const next = new Map(prev);
                for (const [pk, info] of profiles) {
                  next.set(pk, info);
                }
                cachedProfileMap = next;
                return next;
              });
            });
          }, 200);
        }
      }
    };

    listen<StoredEventNotification>("event:stored", (event) => {
      const entry: LiveEntry = {
        id: event.payload.id,
        kind: event.payload.kind,
        pubkey: event.payload.pubkey,
        content: event.payload.content || "",
        ts: Date.now(),
        layer: event.payload.layer || "",
      };

      queueProfileFetch(entry.pubkey);
      liveStreamRef.current = [entry, ...liveStreamRef.current].slice(0, LIVE_STREAM_MAX);
      cachedLiveStream = liveStreamRef.current;
      setLiveStream(liveStreamRef.current);
    }).then((fn) => { unlisten = fn; });

    return () => {
      if (unlisten) unlisten();
      if (profileFlushTimerRef.current) clearTimeout(profileFlushTimerRef.current);
    };
  }, []);

  /* --- seed stream from DB on mount so dashboard isn't empty --------- */
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;

    // Skip seeding if we already have cached live entries
    if (cachedLiveStream.length > 0) return;

    invoke<{ id: string; pubkey: string; created_at: number; kind: number; content: string }[]>(
      "get_feed", { filter: { limit: 20 } }
    )
      .then(async (rawEvents) => {
        const entries: LiveEntry[] = rawEvents
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 20)
          .map((e, i) => ({
            id: e.id,
            kind: e.kind,
            pubkey: e.pubkey,
            content: e.content ? e.content.replace(/https?:\/\/\S+/g, "").trim().slice(0, 120) : "",
            ts: e.created_at * 1000,
            layer: "",
          }));

        if (entries.length > 0) {
          const pubkeys = [...new Set(entries.map((e) => e.pubkey))];
          const profiles = await getProfiles(pubkeys);
          const profileMap = new Map(profiles);
          cachedProfileMap = profileMap;
          setLiveProfileMap(profileMap);
          // Merge: keep any live events that arrived while we were fetching,
          // append seed entries behind them (deduped)
          const liveIds = new Set(liveStreamRef.current.map((e) => e.id));
          const merged = [
            ...liveStreamRef.current,
            ...entries.filter((e) => !liveIds.has(e.id)),
          ].slice(0, LIVE_STREAM_MAX);
          cachedLiveStream = merged;
          liveStreamRef.current = merged;
          setLiveStream(merged);
        }
      })
      .catch(() => {});
  }, []);

  /* --- profile retry for missing pictures ----------------------------- */
  useEffect(() => {
    const timer = setInterval(() => {
      const visible = liveStreamRef.current.slice(0, 20);
      const missing = visible
        .map((e) => e.pubkey)
        .filter((pk) => {
          const p = liveProfileMap.get(pk);
          return !p || !p.picture;
        });
      if (missing.length > 0) {
        const unique = [...new Set(missing)];
        // Invalidate cache so getProfiles re-queries the DB
        unique.forEach((pk) => invalidateProfileCache(pk));
        getProfiles(unique).then((profiles) => {
          setLiveProfileMap((prev) => {
            const next = new Map(prev);
            for (const [pk, info] of profiles) {
              next.set(pk, info);
            }
            cachedProfileMap = next;
            return next;
          });
        });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [liveProfileMap]);

  /* --- data loaders ------------------------------------------------- */
  const loadStats = useCallback(async () => {
    try {
      const s = await invoke<AppStatus>("get_status");
      setStatus(s);
      try {
        const u = await invoke<number>("get_uptime");
        setUptime(u);
      } catch (_) {
        /* get_uptime may not be available */
      }
    } catch (e) {
      console.error("[dashboard] Failed to load stats:", e);
    }
  }, []);

  const loadActivityChart = useCallback(async () => {
    try {
      const data = await invoke<number[]>("get_activity_data");
      setActivityData(data);
    } catch (_) {
      setActivityData(new Array(24).fill(0));
    }
  }, []);

  const loadRelayStatus = useCallback(async () => {
    try {
      const r = await invoke<RelayStatusInfo[]>("get_relay_status");
      setRelays(r);
      setRelaysLoaded(true);
    } catch (_) {
      setRelaysLoaded(true);
    }
  }, []);

  /* --- initial load ------------------------------------------------- */
  useEffect(() => {
    loadStats();
    loadActivityChart();
    loadRelayStatus();
  }, [loadStats, loadActivityChart, loadRelayStatus]);

  /* --- polling ------------------------------------------------------- */
  // Stats refresh every 1s
  useInterval(loadStats, 1000);

  // Activity chart, relays refresh every 15s
  useInterval(() => {
    loadActivityChart();
    loadRelayStatus();
  }, 15000);

  /* --- react to sync events ----------------------------------------- */
  useEffect(() => {
    if (syncProgress) {
      loadStats();
      loadActivityChart();
    }
  }, [syncProgress, loadStats, loadActivityChart]);

  useEffect(() => {
    if (tierComplete) {
      loadStats();
      loadRelayStatus();
    }
  }, [tierComplete, loadStats, loadRelayStatus]);

  /* --- derived values ------------------------------------------------ */
  const relayUrl = status ? `wss://localhost:${status.relay_port}` : "";
  const isSyncing =
    status !== null &&
    (status.sync_tier > 0 || (status.sync_stats.current_layer || "") !== "");
  const currentLayer = status?.sync_stats.current_layer || "";

  // Extract short relay progress string from syncProgress (e.g. "wss://relay.damus.io (3/12)" → "relay.damus.io (3/12)")
  const progressRelay = syncProgress?.relay
    ? syncProgress.relay.replace(/^wss?:\/\//, "")
    : undefined;

  const activityMax = Math.max(...activityData, 1);

  /* --- render -------------------------------------------------------- */
  return (
    <div className="screen-page dashboard-page">
      {/* Header */}
      <div className="dash-header">
        <div className="dash-header-left">
          <span className="dash-header-name">
            <span className="icon"><IconChili /></span> nostrito
          </span>
          {status ? (
            status.relay_running ? (
              <span className="status-badge">
                <span className="status-dot"></span> {relayUrl}
              </span>
            ) : (
              <span className="status-badge offline">
                &#9675; Offline
              </span>
            )
          ) : (
            <span className="status-badge offline">
              &#9675; Offline
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="dash-stats">
        <div className="dash-stat">
          <div className="dash-stat-val">
            {status ? status.events_stored.toLocaleString() : "\u2014"}
          </div>
          <div className="dash-stat-label">Events Synced</div>
        </div>
        <div className="dash-stat">
          <div className="dash-stat-val">
            {status ? status.wot_nodes.toLocaleString() : "\u2014"}
          </div>
          <div className="dash-stat-label">WoT Peers</div>
        </div>
        <div className="dash-stat">
          <div className="dash-stat-val">
            {status ? `${(status.media_stored / 1_073_741_824).toFixed(2)} GB` : "\u2014"}
          </div>
          <div className="dash-stat-label">Media Stored</div>
        </div>
        <div className="dash-stat">
          <div className="dash-stat-val">
            {status
              ? status.offline_mode
                ? "offline"
                : isSyncing
                  ? "~syncing"
                  : "idle"
              : "\u2014"}
          </div>
          <div className="dash-stat-label">Sync Rate</div>
        </div>
        <div className="dash-stat">
          <div className="dash-stat-val">
            {status ? formatUptime(uptime) : "\u2014"}
          </div>
          <div className="dash-stat-label">Uptime</div>
        </div>
      </div>

      {/* Activity chart */}
      <div className="dash-activity">
        <div className="dash-activity-label">Last 24h activity</div>
        <div className="dash-activity-bars">
          {activityData.map((val, i) => {
            const pct = Math.max((val / activityMax) * 100, 4);
            const isRecent = i >= 20;
            return (
              <div
                key={i}
                className={`dash-activity-bar${isRecent ? " recent" : ""}`}
                style={{
                  height: `${pct}%`,
                  background: isRecent
                    ? "var(--accent)"
                    : "rgba(124,58,237,0.2)",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Body: feed + sidebar */}
      <div className="dash-body">
        {/* Live Event Stream */}
        <div className="dash-live-events">
          <div className="dash-live-header">
            <span className="dash-live-title">
              {status?.offline_mode ? (
                <span className="stream-status idle">
                  <span className="stream-dot-idle"></span> Offline
                </span>
              ) : isSyncing ? (
                <span className="stream-status syncing">
                  <span className="stream-dot"></span> Syncing
                </span>
              ) : (
                <span className="stream-status idle">
                  <span className="stream-dot-idle"></span> Idle
                </span>
              )}
            </span>
            <span className="dash-live-count">
              {liveStream.length > 0 ? `${liveStream.length} events` : "\u2014"}
            </span>
          </div>
          <div className="dash-live-table">
            {liveStream.length === 0 ? (
              <div className="dash-live-empty">
                {status?.offline_mode
                  ? "Offline mode — sync disabled"
                  : isSyncing
                    ? "Waiting for events..."
                    : "Idle — waiting for next sync cycle"}
              </div>
            ) : (
              liveStream.slice(0, 20).map((entry) => {
                const profile = liveProfileMap.get(entry.pubkey);
                const name = profileDisplayName(profile, entry.pubkey);
                const kind = kindLabel(entry.kind);
                const kindCls = kindCssClass(entry.kind);
                const age = Math.max(0, Math.floor((Date.now() - entry.ts) / 1000));
                const ageStr = age < 2 ? "now" : age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`;
                const isNew = Date.now() - entry.ts < 1500;

                return (
                  <div
                    className={`dash-live-row${isNew ? " live-row-new" : ""}`}
                    key={entry.id}
                    onClick={() => navigate(`/note/${entry.id}`)}
                    style={{ cursor: "pointer" }}
                  >
                    <span
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                      onClick={(e) => { e.stopPropagation(); navigate(`/profile/${entry.pubkey}`); }}
                    >
                      <Avatar
                        picture={profile?.picture}
                        pubkey={entry.pubkey}
                        className="live-avatar"
                        fallbackClassName="live-avatar-fallback"
                      />
                      <span className="live-name">{name}</span>
                    </span>
                    <span className={`live-kind ${kindCls}`}>{kind}</span>
                    {entry.layer && (
                      <span className={`live-layer ${layerCssClass(entry.layer)}`}>
                        {layerLabel(entry.layer)}
                      </span>
                    )}
                    <span className="live-preview">
                      {entry.content || `${entry.pubkey.slice(0, 8)}...`}
                    </span>
                    <span className="live-time">{ageStr}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Sync Engine sidebar */}
        <div className="dash-sidebar">
          <div className="sync-engine-header">Sync Engine</div>

          {LAYER_IDS.map((lid) => {
            const wotNotes = status?.sync_wot_notes_per_cycle ?? 0;
            const badge = status
              ? getLayerBadge(lid, currentLayer, wotNotes)
              : { text: "IDLE", className: "sync-tier-badge idle" };
            const detail = status
              ? getLayerDetail(lid, status.sync_stats, currentLayer, progressRelay, wotNotes)
              : "\u2014";

            const backendLayer = LAYER_TO_BACKEND[lid];
            const isActive = currentLayer === backendLayer;
            const ss = status?.sync_stats;
            const pct = isActive && ss && ss.pass_pubkeys_total > 0
              ? Math.round((ss.pass_pubkeys_done / ss.pass_pubkeys_total) * 100)
              : 0;

            return (
              <div className="sync-tier" key={lid}>
                <div className="sync-tier-head">
                  <span className="sync-tier-label">{LAYER_LABELS[lid]}</span>
                  <span className={badge.className}>{badge.text}</span>
                </div>
                <div className="sync-tier-detail">{detail}</div>
                {isActive && pct > 0 && (
                  <div className="sync-tier-bar">
                    <div className="sync-tier-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}

          {/* Relays */}
          <div className="sync-tier">
            <div className="sync-tier-head">
              <span className="sync-tier-label">Relays</span>
            </div>
            <div style={{ paddingTop: 4 }}>
              {relays.length === 0 ? (
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "0.8rem",
                    padding: "4px 0",
                  }}
                >
                  {relaysLoaded ? "No relays configured" : "Connecting..."}
                </div>
              ) : (
                relays.map((r) => (
                  <div className="sync-relay-item" key={r.url}>
                    <div className={`relay-dot${r.connected ? " on" : ""}`} />
                    <span className="relay-name">{r.name}</span>
                    <span className="relay-latency">
                      {r.latency_ms != null ? `${r.latency_ms}ms` : "\u2014"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
