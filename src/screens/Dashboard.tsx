import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconChili } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useInterval } from "../hooks/useInterval";
import { timeAgo } from "../utils/format";
import { getProfiles, profileDisplayName, type ProfileInfo } from "../utils/profiles";
import type {
  NostrEvent,
  AppStatus,
  SyncProgress,
  SyncStats,
  RelayStatusInfo,
} from "../types/nostr";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

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

function formatUptime(seconds: number): string {
  if (seconds > 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds > 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

function contentPreview(content: string): string {
  return content.replace(/https?:\/\/\S+/g, "").trim().slice(0, 60) || "\u2014";
}

/* ------------------------------------------------------------------ */
/*  Sync layer badge helpers                                           */
/* ------------------------------------------------------------------ */

interface LayerBadge {
  text: string;
  className: string;
}

function getLayerBadge(layerId: LayerId, currentLayer: string): LayerBadge {
  const backendLayer = LAYER_TO_BACKEND[layerId];
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
  currentLayer: string
): string {
  const backendLayer = LAYER_TO_BACKEND[layerId];
  const s = syncStats;

  let detail = "";
  switch (layerId) {
    case "0":
      if (s.tier1_fetched > 0) detail = `${s.tier1_fetched} events`;
      break;
    case "05":
      if ((s.tracked_fetched || 0) > 0) detail = `${s.tracked_fetched} events`;
      break;
    case "1":
      if (s.tier2_fetched > 0) detail = `${s.tier2_fetched} events`;
      break;
    case "2": {
      const total = (s.tier3_fetched || 0) + (s.tier4_fetched || 0);
      if (total > 0) detail = `${total} events`;
      break;
    }
  }

  if (detail) return detail;

  const isDone =
    currentLayer !== "" &&
    LAYER_ORDER.indexOf(backendLayer) < LAYER_ORDER.indexOf(currentLayer);
  return isDone ? "complete" : "\u2014";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Dashboard: React.FC = () => {
  /* --- state -------------------------------------------------------- */
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [uptime, setUptime] = useState<number>(0);
  const [activityData, setActivityData] = useState<number[]>(new Array(24).fill(0));
  const [relays, setRelays] = useState<RelayStatusInfo[]>([]);
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [profileMap, setProfileMap] = useState<Map<string, ProfileInfo>>(new Map());
  const feedLoadingRef = useRef(false);

  /* --- Tauri event listeners ---------------------------------------- */
  const syncProgress = useTauriEvent<SyncProgress>("sync:progress");
  const tierComplete = useTauriEvent<{ tier: number }>("sync:tier_complete");

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
    } catch (_) {
      /* ignore */
    }
  }, []);

  const loadFeed = useCallback(async () => {
    if (feedLoadingRef.current) return;
    feedLoadingRef.current = true;
    try {
      const rawEvents = await invoke<NostrEvent[]>("get_feed", {
        filter: { limit: 30 },
      });
      const seen = new Set<string>();
      const deduped = rawEvents
        .filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        })
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 10);

      const pubkeys = [...new Set(deduped.map((e) => e.pubkey))];
      const profiles = await getProfiles(pubkeys);
      setProfileMap(new Map(profiles));
      setEvents(deduped);
    } catch (_) {
      /* ignore */
    } finally {
      feedLoadingRef.current = false;
    }
  }, []);

  /* --- initial load ------------------------------------------------- */
  useEffect(() => {
    loadStats();
    loadFeed();
    loadActivityChart();
    loadRelayStatus();
  }, [loadStats, loadFeed, loadActivityChart, loadRelayStatus]);

  /* --- polling ------------------------------------------------------- */
  // Stats refresh every 1s
  useInterval(loadStats, 1000);

  // Feed, activity chart, relays refresh every 15s
  useInterval(() => {
    loadFeed();
    loadActivityChart();
    loadRelayStatus();
  }, 15000);

  /* --- react to sync events ----------------------------------------- */
  useEffect(() => {
    if (syncProgress) {
      loadStats();
    }
  }, [syncProgress, loadStats]);

  useEffect(() => {
    if (tierComplete) {
      loadStats();
      loadFeed();
    }
  }, [tierComplete, loadStats, loadFeed]);

  /* --- derived values ------------------------------------------------ */
  const relayUrl = status ? `wss://localhost:${status.relay_port}` : "";
  const isSyncing =
    status !== null &&
    (status.sync_tier > 0 || (status.sync_stats.current_layer || "") !== "");
  const currentLayer = status?.sync_stats.current_layer || "";

  const activityMax = Math.max(...activityData, 1);

  /* --- render -------------------------------------------------------- */
  return (
    <div className="main-content">
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
          <div className="dash-stat-val">{"\u2014"}</div>
          <div className="dash-stat-label">Media Cached</div>
        </div>
        <div className="dash-stat">
          <div className="dash-stat-val">
            {status ? (isSyncing ? "~syncing" : "idle") : "\u2014"}
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
        {/* Latest Events */}
        <div className="dash-live-events">
          <div className="dash-live-header">
            <span className="dash-live-title">Latest Events</span>
            <span className="dash-live-count">
              {events.length > 0 ? `${events.length} events` : "\u2014"}
            </span>
          </div>
          <div className="dash-live-table">
            {events.length === 0 ? (
              <div className="dash-live-empty">Waiting for events...</div>
            ) : (
              events.map((e) => {
                const profile = profileMap.get(e.pubkey);
                const name = profileDisplayName(profile, e.pubkey);
                const kind = kindLabel(e.kind);
                const kindCls = kindCssClass(e.kind);
                const preview = contentPreview(e.content);

                return (
                  <div className="dash-live-row" key={e.id}>
                    <Avatar
                      picture={profile?.picture}
                      pubkey={e.pubkey}
                      className="live-avatar"
                      fallbackClassName="live-avatar-fallback"
                    />
                    <span className="live-name">{name}</span>
                    <span className={`live-kind ${kindCls}`}>{kind}</span>
                    <span className="live-preview">{preview}</span>
                    <span className="live-time">{timeAgo(e.created_at)}</span>
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
            const badge = status
              ? getLayerBadge(lid, currentLayer)
              : { text: "IDLE", className: "sync-tier-badge idle" };
            const detail = status
              ? getLayerDetail(lid, status.sync_stats, currentLayer)
              : "\u2014";

            return (
              <div className="sync-tier" key={lid}>
                <div className="sync-tier-head">
                  <span className="sync-tier-label">{LAYER_LABELS[lid]}</span>
                  <span className={badge.className}>{badge.text}</span>
                </div>
                <div className="sync-tier-detail">{detail}</div>
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
                  No relays configured
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
