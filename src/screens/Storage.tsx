import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Link } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Avatar } from "../components/Avatar";
import { KindBreakdownChart } from "../components/KindBreakdownChart";
import { formatBytes } from "../utils/format";
import { useAppContext } from "../context/AppContext";
import { useProfileContext } from "../context/ProfileContext";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OwnershipStorageStats {
  own_events_count: number;
  own_media_bytes: number;
  tracked_events_count: number;
  tracked_media_bytes: number;
  wot_events_count: number;
  wot_media_bytes: number;
  total_events: number;
  db_size_bytes: number;
}

interface StorageStats {
  total_events: number;
  db_size_bytes: number;
  oldest_event: number;
  newest_event: number;
}

interface KindCountsResult {
  counts: Record<string, number>;
}

interface TrackedProfileSummary {
  pubkey: string;
  picture: string | null;
  picture_local: string | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Storage: React.FC = () => {
  const { ownProfile } = useAppContext();
  const { ensureProfiles, getProfile } = useProfileContext();

  /* --- state -------------------------------------------------------- */
  const [ownershipStats, setOwnershipStats] = useState<OwnershipStorageStats | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [kindCounts, setKindCounts] = useState<Record<string, number> | null>(null);
  const [ownershipError, setOwnershipError] = useState(false);
  const [kindError, setKindError] = useState(false);
  const [trackedAvatars, setTrackedAvatars] = useState<TrackedProfileSummary[]>([]);
  const [wotAvatarPubkeys, setWotAvatarPubkeys] = useState<string[]>([]);

  /* --- data loading ------------------------------------------------- */
  useEffect(() => {
    invoke<OwnershipStorageStats>("get_ownership_storage_stats")
      .then(setOwnershipStats)
      .catch((e) => {
        console.error("[storage] get_ownership_storage_stats failed:", e);
        setOwnershipError(true);
      });

    invoke<StorageStats>("get_storage_stats")
      .then(setStorageStats)
      .catch(() => {});

    invoke<KindCountsResult>("get_kind_counts")
      .then((r) => setKindCounts(r.counts))
      .catch((e) => {
        console.error("[storage] get_kind_counts failed:", e);
        setKindError(true);
      });

    // Fetch tracked profiles for avatar display
    invoke<{ pubkey: string; picture: string | null; picture_local: string | null }[]>("get_tracked_profiles_detail")
      .then((profiles) => {
        setTrackedAvatars(profiles.slice(0, 3).map((p) => ({ pubkey: p.pubkey, picture: p.picture, picture_local: p.picture_local ?? null })));
      })
      .catch((e) => {
        console.error("[storage] get_tracked_profiles_detail failed:", e);
      });

    // Fetch a few WoT events to get pubkeys for avatar display
    invoke<{ pubkey: string }[]>("get_events_for_category", {
      category: "wot",
      kinds: [1],
      limit: 30,
    })
      .then((events) => {
        const unique = [...new Set(events.map((e) => e.pubkey))];
        // Pick 3 random pubkeys
        const shuffled = unique.sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, 3);
        if (picked.length > 0) ensureProfiles(picked);
        setWotAvatarPubkeys(picked);
      })
      .catch(() => {});

    // Trigger immediate download of tracked profile media, then refresh stats
    invoke<number>("download_tracked_media")
      .then((downloaded) => {
        if (downloaded > 0) {
          // Refresh stats after downloading
          invoke<OwnershipStorageStats>("get_ownership_storage_stats")
            .then(setOwnershipStats)
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Refresh stats when media is deleted from Gallery
  useEffect(() => {
    const unlisten = listen("media-deleted", () => {
      invoke<OwnershipStorageStats>("get_ownership_storage_stats")
        .then(setOwnershipStats)
        .catch(() => {});
      invoke<StorageStats>("get_storage_stats")
        .then(setStorageStats)
        .catch(() => {});
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  /* --- derived values ----------------------------------------------- */
  const title = useMemo(() => {
    if (ownershipError) return "storage usage \u2014 no data";
    if (!ownershipStats) return "storage usage \u2014 calculating...";
    return `storage usage \u2014 ${ownershipStats.total_events.toLocaleString()} events \u00B7 ${formatBytes(ownershipStats.db_size_bytes)}`;
  }, [ownershipStats, ownershipError]);

  const { ownPct, trackedPct, wotPct } = useMemo(() => {
    if (!ownershipStats) return { ownPct: 0, trackedPct: 0, wotPct: 0 };
    const total = ownershipStats.total_events || 1;
    const own = (ownershipStats.own_events_count / total) * 100;
    const tracked = (ownershipStats.tracked_events_count / total) * 100;
    const wot = Math.max(0, 100 - own - tracked);
    return { ownPct: own, trackedPct: tracked, wotPct: wot };
  }, [ownershipStats]);

  const eventRange = useMemo(() => {
    if (!storageStats) return null;
    const oldest =
      storageStats.oldest_event > 0
        ? new Date(storageStats.oldest_event * 1000).toLocaleDateString()
        : "\u2014";
    const newest =
      storageStats.newest_event > 0
        ? new Date(storageStats.newest_event * 1000).toLocaleDateString()
        : "\u2014";
    return `event range: ${oldest} \u2192 ${newest}`;
  }, [storageStats]);

  /* --- render ------------------------------------------------------- */
  return (
    <div className="storage-page-inner">
      {/* ---- Usage bar ---- */}
      <div className="storage-usage-bar">
        <div className="storage-usage-title">{title}</div>
        <div className="storage-usage-visual">
          <div
            className="storage-seg"
            style={{ width: `${ownPct}%`, background: "var(--accent)" }}
          />
          <div
            className="storage-seg"
            style={{ width: `${trackedPct}%`, background: "var(--purple)" }}
          />
          <div
            className="storage-seg"
            style={{ width: `${wotPct}%`, background: "var(--blue)" }}
          />
        </div>
        <div className="storage-legend">
          <div className="storage-legend-item">
            <div className="storage-legend-dot" style={{ background: "var(--accent)" }} />
            <span>own events</span>
          </div>
          <div className="storage-legend-item">
            <div className="storage-legend-dot" style={{ background: "var(--purple)" }} />
            <span>tracked profiles</span>
          </div>
          <div className="storage-legend-item">
            <div className="storage-legend-dot" style={{ background: "var(--blue)" }} />
            <span>wot profiles</span>
          </div>
        </div>
      </div>

      {/* ---- Ownership grid ---- */}
      <div className="ownership-grid">
        {/* Own Events */}
        <Link to="/storage/own-events" className="ownership-card own" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="ownership-card-header">
            <div className="ownership-card-header-left">
              {ownProfile && (
                <Avatar
                  picture={ownProfile.picture}
                  pictureLocal={ownProfile.picture_local}
                  pubkey={ownProfile.pubkey}
                  className="ownership-avatar"
                  fallbackClassName="ownership-avatar-fallback"
                />
              )}
              <span className="ownership-card-label">own events</span>
            </div>
            <Badge text="you" className="ownership-card-badge" variant="own" />
          </div>
          <div className="ownership-card-body">
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? ownershipStats.own_events_count.toLocaleString() : "\u2014"}
              </span>
              <span className="ownership-stat-label">events</span>
            </div>
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? formatBytes(ownershipStats.own_media_bytes) : "\u2014"}
              </span>
              <span className="ownership-stat-label">media</span>
            </div>
          </div>
          <div className="ownership-card-footer">
            always kept &mdash; never pruned &middot; &infin; unlimited
          </div>
        </Link>

        {/* Tracked Profiles */}
        <Link to="/storage/tracked-profiles" className="ownership-card tracked" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="ownership-card-header">
            <div className="ownership-card-header-left">
              {trackedAvatars.length > 0 && (
                <div className="ownership-avatar-row">
                  {trackedAvatars.map((p) => (
                    <Avatar
                      key={p.pubkey}
                      picture={p.picture}
                      pictureLocal={p.picture_local}
                      pubkey={p.pubkey}
                      className="ownership-avatar-sm"
                      fallbackClassName="ownership-avatar-sm-fallback"
                    />
                  ))}
                </div>
              )}
              <span className="ownership-card-label">tracked profiles</span>
            </div>
            <Badge text="tracked" className="ownership-card-badge" variant="tracked" />
          </div>
          <div className="ownership-card-body">
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? ownershipStats.tracked_events_count.toLocaleString() : "\u2014"}
              </span>
              <span className="ownership-stat-label">events</span>
            </div>
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? formatBytes(ownershipStats.tracked_media_bytes) : "\u2014"}
              </span>
              <span className="ownership-stat-label">media</span>
            </div>
          </div>
          <div className="ownership-card-footer">
            always kept &mdash; never pruned
          </div>
        </Link>

        {/* WoT Profiles */}
        <Link to="/storage/wot-profiles" className="ownership-card wot" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="ownership-card-header">
            <div className="ownership-card-header-left">
              {wotAvatarPubkeys.length > 0 && (
                <div className="ownership-avatar-stack">
                  {wotAvatarPubkeys.map((pk, i) => {
                    const p = getProfile(pk);
                    return (
                      <Avatar
                        key={pk}
                        picture={p?.picture}
                        pictureLocal={p?.picture_local}
                        pubkey={pk}
                        className={`ownership-avatar-sm ownership-avatar-bubble ownership-avatar-bubble-${i}`}
                        fallbackClassName="ownership-avatar-sm-fallback"
                      />
                    );
                  })}
                </div>
              )}
              <span className="ownership-card-label">wot profiles</span>
            </div>
            <Badge text="wot" className="ownership-card-badge" variant="wot" />
          </div>
          <div className="ownership-card-body">
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? ownershipStats.wot_events_count.toLocaleString() : "\u2014"}
              </span>
              <span className="ownership-stat-label">events</span>
            </div>
            <div className="ownership-stat">
              <span className="ownership-stat-value">
                {ownershipStats ? formatBytes(ownershipStats.wot_media_bytes) : "\u2014"}
              </span>
              <span className="ownership-stat-label">cached media</span>
            </div>
          </div>
          <div className="ownership-card-footer">
            subject to retention limits
          </div>
        </Link>
      </div>

      {/* ---- DB info ---- */}
      {eventRange && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 12 }}>
          {eventRange}
        </div>
      )}

      {/* ---- Kind breakdown ---- */}
      <div className="kind-breakdown-separator" />

      <KindBreakdownChart title="event breakdown" kindCounts={kindCounts} error={kindError} />
    </div>
  );
};
