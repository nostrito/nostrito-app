import React, { useState, useEffect, useMemo, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Avatar } from "../components/Avatar";
import { NoteCard } from "../components/NoteCard";
import { EmptyState } from "../components/EmptyState";
import { KindBreakdownChart } from "../components/KindBreakdownChart";
import { formatBytes, shortPubkey } from "../utils/format";
import { initMediaViewer } from "../utils/media";
import { useProfileContext } from "../context/ProfileContext";
import type { NostrEvent } from "../types/nostr";

interface TrackedProfileDetail {
  pubkey: string;
  tracked_at: number;
  note: string | null;
  name: string | null;
  display_name: string | null;
  picture: string | null;
  picture_local: string | null;
  event_count: number;
}

interface OwnershipStorageStats {
  own_events_count: number;
  tracked_events_count: number;
  wot_events_count: number;
  total_events: number;
  db_size_bytes: number;
  media_disk_bytes: number;
}

interface KindCountsResult {
  counts: Record<string, number>;
}

interface EventMediaRef {
  url: string;
  local_path: string | null;
  mime_type: string;
  size_bytes: number;
  downloaded: boolean;
  pubkey: string;
  created_at: number;
}

type Tab = "overview" | "notes" | "media";
type MediaFilter = "all" | "images" | "videos" | "audio";

export const StorageTrackedProfiles: React.FC = () => {
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();
  const [tab, setTab] = useState<Tab>("overview");

  // Overview state
  const [profiles, setProfiles] = useState<TrackedProfileDetail[]>([]);
  const [stats, setStats] = useState<OwnershipStorageStats | null>(null);
  const [kindCounts, setKindCounts] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);

  // Notes state
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesHasMore, setNotesHasMore] = useState(true);

  // Media state
  const [allMedia, setAllMedia] = useState<EventMediaRef[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");

  useEffect(() => {
    initMediaViewer();
  }, []);

  useEffect(() => {
    invoke<TrackedProfileDetail[]>("get_tracked_profiles_detail")
      .then(p => { setProfiles(p); setLoading(false); })
      .catch(() => setLoading(false));
    invoke<OwnershipStorageStats>("get_ownership_storage_stats")
      .then(setStats)
      .catch(() => {});
    invoke<KindCountsResult>("get_kind_counts_for_category", { category: "tracked" })
      .then(r => setKindCounts(r.counts))
      .catch(() => {});
  }, []);

  const openViewer = useCallback((url: string, type?: "image" | "video", originalUrl?: string, pubkey?: string) => {
    if (typeof (window as any).openMediaViewer === "function") {
      (window as any).openMediaViewer(url, type, { pubkey, originalUrl: originalUrl || url });
    }
  }, []);

  const handleImageError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const card = e.currentTarget.parentElement;
      if (card) card.classList.add("broken");
    },
    [],
  );

  // Notes loading
  const loadNotes = useCallback(async (until?: number) => {
    setNotesLoading(true);
    try {
      const events = await invoke<NostrEvent[]>("get_events_for_category", {
        category: "tracked",
        kinds: [1, 6, 30023],
        until,
        limit: 50,
      });
      const pubkeys = [...new Set(events.map(e => e.pubkey))];
      if (pubkeys.length > 0) ensureProfiles(pubkeys);
      if (until) {
        setNotes(prev => [...prev, ...events]);
      } else {
        setNotes(events);
      }
      setNotesHasMore(events.length >= 50);
    } catch (e) {
      console.error("[storage:tracked] load notes failed:", e);
    }
    setNotesLoading(false);
  }, [ensureProfiles]);

  useEffect(() => {
    if (tab === "notes" && notes.length === 0) loadNotes();
  }, [tab]);

  const loadMoreNotes = useCallback(() => {
    if (notes.length > 0) {
      loadNotes(notes[notes.length - 1].created_at);
    }
  }, [notes, loadNotes]);

  // Media loading
  useEffect(() => {
    if (tab === "media" && allMedia.length === 0) {
      setMediaLoading(true);
      invoke<EventMediaRef[]>("get_event_media_for_category", { category: "tracked", limit: 500 })
        .then(setAllMedia)
        .catch(e => console.error("[storage:tracked] load media failed:", e))
        .finally(() => setMediaLoading(false));
    }
  }, [tab]);

  const filteredMedia = useMemo(() => {
    switch (mediaFilter) {
      case "images": return allMedia.filter(m => m.mime_type.startsWith("image/"));
      case "videos": return allMedia.filter(m => m.mime_type.startsWith("video/"));
      case "audio": return allMedia.filter(m => m.mime_type.startsWith("audio/"));
      default: return allMedia;
    }
  }, [allMedia, mediaFilter]);

  const sortedProfiles = useMemo(() =>
    [...profiles].sort((a, b) => b.event_count - a.event_count),
    [profiles]
  );

  return (
    <div className="storage-detail-page">
      <div className="storage-detail-header">
        <Link to="/settings/analytics" className="storage-back-link">
          <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          storage
        </Link>
        <h2 className="storage-detail-title">tracked profiles</h2>
        <Badge text="tracked" className="ownership-card-badge" variant="tracked" />
      </div>

      <div className="storage-detail-stats">
        <div className="storage-detail-stat">
          <span className="storage-detail-stat-value">{stats ? stats.tracked_events_count.toLocaleString() : "\u2014"}</span>
          <span className="storage-detail-stat-label">events</span>
        </div>
        <div className="storage-detail-stat">
          <span className="storage-detail-stat-value">{profiles.length}</span>
          <span className="storage-detail-stat-label">profiles</span>
        </div>
      </div>

      <div className="storage-detail-note">always kept &mdash; never pruned</div>

      {/* Tabs */}
      <div className="storage-detail-tabs">
        <button className={`storage-detail-tab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>overview</button>
        <button className={`storage-detail-tab${tab === "notes" ? " active" : ""}`} onClick={() => setTab("notes")}>notes</button>
        <button className={`storage-detail-tab${tab === "media" ? " active" : ""}`} onClick={() => setTab("media")}>media</button>
      </div>

      {/* Overview tab */}
      {tab === "overview" && (
        <>
          {/* Profile list */}
          <div className="tracked-profiles-section">
            <div className="kind-breakdown-title">profiles</div>

            {loading && <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", padding: 16 }}>loading...</div>}

            {!loading && profiles.length === 0 && (
              <EmptyState
                icon={<svg className="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
                message="no tracked profiles yet."
                hint="track profiles in settings to keep their data safe from pruning."
              />
            )}

            {!loading && sortedProfiles.map(p => (
                <div key={p.pubkey} className="tracked-profile-row">
                    <div className="tracked-profile-info">
                      <Avatar
                        picture={p.picture}
                        pictureLocal={p.picture_local}
                        pubkey={p.pubkey}
                        className="tracked-profile-avatar"
                      />
                      <div className="tracked-profile-meta">
                        <span className="tracked-profile-name">
                          {p.display_name || p.name || shortPubkey(p.pubkey)}
                        </span>
                        <span className="tracked-profile-pubkey" title={p.pubkey}>{shortPubkey(p.pubkey)}</span>
                      </div>
                    </div>
                    <div className="tracked-profile-stats">
                      <div className="tracked-profile-stat">
                        <span className="tracked-profile-stat-value">{p.event_count.toLocaleString()}</span>
                        <span className="tracked-profile-stat-label">events</span>
                      </div>
                    </div>
                </div>
            ))}
          </div>

          {/* Kind breakdown */}
          {kindCounts && (
            <>
              <div className="kind-breakdown-separator" />
              <KindBreakdownChart title="event breakdown (all tracked)" kindCounts={kindCounts} />
            </>
          )}
        </>
      )}

      {/* Notes tab */}
      {tab === "notes" && (
        <div className="storage-notes-list">
          {notesLoading && notes.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: 24, textAlign: "center" }}>loading notes...</div>
          )}
          {!notesLoading && notes.length === 0 && (
            <EmptyState
              icon={<svg className="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>}
              message="no notes from tracked profiles yet."
              hint="notes from your tracked profiles will appear here as they sync."
            />
          )}
          {notes.map(event => (
            <NoteCard
              key={event.id}
              event={event}
              profile={getProfile(event.pubkey)}
              compact
              onClick={() => navigate(`/note/${event.id}`)}
            />
          ))}
          {notesHasMore && notes.length > 0 && (
            <div className="storage-load-more">
              <button className="storage-load-more-btn" onClick={loadMoreNotes} disabled={notesLoading}>
                {notesLoading ? "loading..." : "load more"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Media tab */}
      {tab === "media" && (
        <>
          <div className="my-media-filters">
            {(["all", "images", "videos", "audio"] as MediaFilter[]).map(f => (
              <button
                key={f}
                className={`my-media-filter${mediaFilter === f ? " active" : ""}`}
                onClick={() => setMediaFilter(f)}
              >
                {f}
              </button>
            ))}
            <span className="my-media-stats" style={{ marginLeft: "auto" }}>
              {filteredMedia.length} files
            </span>
          </div>
          <div className="storage-media-grid">
            {mediaLoading && (
              <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.85rem" }}>loading media...</div>
            )}
            {!mediaLoading && filteredMedia.length === 0 && (
              <EmptyState
                icon={<svg className="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>}
                message="no media cached yet."
                hint="media from tracked profiles will appear here as it downloads."
              />
            )}
            {!mediaLoading && filteredMedia.map((item, idx) => {
              const src = item.local_path ? convertFileSrc(item.local_path) : item.url;
              const date = new Date(item.created_at * 1000).toLocaleDateString();
              const sizeLabel = item.size_bytes > 0 ? formatBytes(item.size_bytes) : "";
              const tooltip = `${date}${sizeLabel ? ` \u00B7 ${sizeLabel}` : ""}`;
              const key = `${item.url}-${idx}`;

              if (item.mime_type.startsWith("image/")) {
                return (
                  <div key={key} className={`my-media-card`} onClick={() => openViewer(src, "image", item.url, item.pubkey)} title={tooltip}>
                    <img src={src} loading="lazy" onError={handleImageError} />
                    <div className="my-media-card-overlay">{sizeLabel}</div>
                  </div>
                );
              }
              if (item.mime_type.startsWith("video/")) {
                return (
                  <div key={key} className={`my-media-card video`} onClick={() => openViewer(src, "video", item.url, item.pubkey)} title={tooltip}>
                    <video src={src} preload="metadata" muted />
                    <div className="my-media-card-play">{"\u25B6"}</div>
                    <div className="my-media-card-overlay">{sizeLabel}</div>
                  </div>
                );
              }
              if (item.mime_type.startsWith("audio/")) {
                return (
                  <div key={key} className={`my-media-card audio`} title={tooltip}>
                    <audio src={src} controls preload="metadata" onClick={e => e.stopPropagation()} />
                    <div className="my-media-card-overlay">{sizeLabel}</div>
                  </div>
                );
              }
              return null;
            })}
          </div>
        </>
      )}
    </div>
  );
};
