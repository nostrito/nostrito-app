import React, { useState, useEffect, useMemo, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/Badge";
import { NoteCard } from "../components/NoteCard";
import { EmptyState } from "../components/EmptyState";
import { formatBytes } from "../utils/format";
import { initMediaViewer } from "../utils/media";
import { useProfileContext } from "../context/ProfileContext";
import type { NostrEvent } from "../types/nostr";

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

interface KindCountsResult {
  counts: Record<string, number>;
}

interface MediaBreakdown {
  image_count: number;
  image_bytes: number;
  video_count: number;
  video_bytes: number;
  audio_count: number;
  audio_bytes: number;
  other_count: number;
  other_bytes: number;
  total_count: number;
  total_bytes: number;
  oldest_media: number;
  newest_media: number;
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

interface KindCategory {
  label: string;
  icon: React.ReactNode;
  kinds: number[];
}

const KIND_CATEGORIES: KindCategory[] = [
  { label: "Notes", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>, kinds: [1] },
  { label: "Reposts", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>, kinds: [6] },
  { label: "Reactions", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/></svg>, kinds: [7] },
  { label: "Profiles", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>, kinds: [0] },
  { label: "Contacts", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>, kinds: [3] },
  { label: "Articles", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>, kinds: [30023] },
  { label: "Zaps", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>, kinds: [9735] },
  { label: "DMs", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>, kinds: [4, 1059] },
];

interface KindRow { label: string; icon: React.ReactNode; count: number; }

function aggregateKindRows(counts: Record<string, number>): KindRow[] {
  const remaining = new Map<number, number>();
  for (const [k, v] of Object.entries(counts)) remaining.set(Number(k), v);
  const rows: KindRow[] = [];
  for (const cat of KIND_CATEGORIES) {
    let total = 0;
    for (const k of cat.kinds) { total += remaining.get(k) || 0; remaining.delete(k); }
    if (total > 0) rows.push({ label: cat.label, icon: cat.icon, count: total });
  }
  let otherCount = 0;
  for (const v of remaining.values()) otherCount += v;
  if (otherCount > 0) rows.push({ label: "Other", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>, count: otherCount });
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

type Tab = "overview" | "notes" | "media";
type MediaFilter = "all" | "images" | "videos" | "audio";

export const StorageOwnEvents: React.FC = () => {
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();
  const [tab, setTab] = useState<Tab>("overview");

  // Overview state
  const [stats, setStats] = useState<OwnershipStorageStats | null>(null);
  const [kindCounts, setKindCounts] = useState<Record<string, number> | null>(null);
  const [mediaBreakdown, setMediaBreakdown] = useState<MediaBreakdown | null>(null);

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
    invoke<OwnershipStorageStats>("get_ownership_storage_stats").then(setStats).catch(() => {});
    invoke<KindCountsResult>("get_kind_counts_for_category", { category: "own" }).then(r => setKindCounts(r.counts)).catch(() => {});
    invoke<MediaBreakdown>("get_media_breakdown_for_category", { category: "own" }).then(setMediaBreakdown).catch(() => {});
  }, []);

  // Load notes when tab changes
  const loadNotes = useCallback(async (until?: number) => {
    setNotesLoading(true);
    try {
      const events = await invoke<NostrEvent[]>("get_events_for_category", {
        category: "own",
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
      console.error("[storage:own] load notes failed:", e);
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

  // Load media when tab changes — scans events for all media references
  useEffect(() => {
    if (tab === "media" && allMedia.length === 0) {
      setMediaLoading(true);
      invoke<EventMediaRef[]>("get_event_media_for_category", { category: "own", limit: 500 })
        .then(setAllMedia)
        .catch(e => console.error("[storage:own] load media failed:", e))
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

  const openViewer = useCallback((url: string, type?: "image" | "video") => {
    if (typeof (window as any).openMediaViewer === "function") {
      (window as any).openMediaViewer(url, type);
    }
  }, []);

  const handleImageError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const card = e.currentTarget.parentElement;
    if (card) card.classList.add("broken");
  }, []);

  // Overview derived
  const kindRows = useMemo(() => kindCounts ? aggregateKindRows(kindCounts) : null, [kindCounts]);
  const maxKindCount = useMemo(() => kindRows && kindRows.length > 0 ? kindRows[0].count : 0, [kindRows]);
  const mediaRows = useMemo(() => {
    if (!mediaBreakdown || mediaBreakdown.total_count === 0) return null;
    return [
      { label: "Images", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>, count: mediaBreakdown.image_count, bytes: mediaBreakdown.image_bytes },
      { label: "Videos", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.934a.5.5 0 0 0-.777-.416L16 11"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>, count: mediaBreakdown.video_count, bytes: mediaBreakdown.video_bytes },
      { label: "Audio", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>, count: mediaBreakdown.audio_count, bytes: mediaBreakdown.audio_bytes },
      { label: "Other", icon: <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>, count: mediaBreakdown.other_count, bytes: mediaBreakdown.other_bytes },
    ].filter(r => r.count > 0).sort((a, b) => b.bytes - a.bytes);
  }, [mediaBreakdown]);
  const maxMediaBytes = useMemo(() => mediaRows && mediaRows.length > 0 ? mediaRows[0].bytes : 0, [mediaRows]);

  return (
    <div className="storage-detail-page">
      <div className="storage-detail-header">
        <Link to="/storage" className="storage-back-link">
          <svg className="icon-sm" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          Storage
        </Link>
        <h2 className="storage-detail-title">Own Events</h2>
        <Badge text="YOU" className="ownership-card-badge" variant="own" />
      </div>

      <div className="storage-detail-stats">
        <div className="storage-detail-stat">
          <span className="storage-detail-stat-value">{stats ? stats.own_events_count.toLocaleString() : "\u2014"}</span>
          <span className="storage-detail-stat-label">events</span>
        </div>
        <div className="storage-detail-stat">
          <span className="storage-detail-stat-value">{stats ? formatBytes(stats.own_media_bytes) : "\u2014"}</span>
          <span className="storage-detail-stat-label">media</span>
        </div>
      </div>

      <div className="storage-detail-note">Always kept &mdash; never pruned &middot; unlimited</div>

      {/* Tabs */}
      <div className="storage-detail-tabs">
        <button className={`storage-detail-tab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`storage-detail-tab${tab === "notes" ? " active" : ""}`} onClick={() => setTab("notes")}>Notes</button>
        <button className={`storage-detail-tab${tab === "media" ? " active" : ""}`} onClick={() => setTab("media")}>Media</button>
      </div>

      {/* Overview tab */}
      {tab === "overview" && (
        <>
          {mediaRows && mediaRows.length > 0 && (
            <>
              <div className="kind-breakdown-section">
                <div className="kind-breakdown-title">Media Breakdown</div>
                {mediaBreakdown && (
                  <div className="media-summary-stats">
                    <span>{mediaBreakdown.total_count.toLocaleString()} files</span>
                    <span>{formatBytes(mediaBreakdown.total_bytes)}</span>
                    {mediaBreakdown.total_count > 0 && (
                      <span>avg {formatBytes(Math.round(mediaBreakdown.total_bytes / mediaBreakdown.total_count))}</span>
                    )}
                    {mediaBreakdown.oldest_media > 0 && (
                      <span>{new Date(mediaBreakdown.oldest_media * 1000).toLocaleDateString()} &mdash; {new Date(mediaBreakdown.newest_media * 1000).toLocaleDateString()}</span>
                    )}
                  </div>
                )}
                <div className="kind-breakdown-list">
                  {mediaRows.map(row => {
                    const pct = maxMediaBytes > 0 ? (row.bytes / maxMediaBytes) * 100 : 0;
                    return (
                      <div className="kind-breakdown-row" key={row.label}>
                        <span className="kind-breakdown-icon">{row.icon}</span>
                        <span className="kind-breakdown-label">{row.label}</span>
                        <div className="kind-breakdown-bar-wrap">
                          <div className="kind-breakdown-bar media-bar" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="kind-breakdown-count">{row.count.toLocaleString()} &middot; {formatBytes(row.bytes)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="kind-breakdown-separator" />
            </>
          )}

          <div className="kind-breakdown-section">
            <div className="kind-breakdown-title">Event Breakdown</div>
            <div className="kind-breakdown-list">
              {!kindCounts && <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Loading...</div>}
              {kindRows && kindRows.length === 0 && <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>No events stored</div>}
              {kindRows && kindRows.length > 0 && kindRows.map(row => {
                const pct = maxKindCount > 0 ? (row.count / maxKindCount) * 100 : 0;
                return (
                  <div className="kind-breakdown-row" key={row.label}>
                    <span className="kind-breakdown-icon">{row.icon}</span>
                    <span className="kind-breakdown-label">{row.label}</span>
                    <div className="kind-breakdown-bar-wrap">
                      <div className="kind-breakdown-bar" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="kind-breakdown-count">{row.count.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Notes tab */}
      {tab === "notes" && (
        <div className="storage-notes-list">
          {notesLoading && notes.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: 24, textAlign: "center" }}>Loading notes...</div>
          )}
          {!notesLoading && notes.length === 0 && (
            <EmptyState
              icon={<svg className="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>}
              message="No notes stored yet."
              hint="Your own notes will appear here as they sync from relays."
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
                {notesLoading ? "Loading..." : "Load more"}
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
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            <span className="my-media-stats" style={{ marginLeft: "auto" }}>
              {filteredMedia.length} files
            </span>
          </div>
          <div className="storage-media-grid">
            {mediaLoading && (
              <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading media...</div>
            )}
            {!mediaLoading && filteredMedia.length === 0 && (
              <EmptyState
                icon={<svg className="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>}
                message="No media cached yet."
                hint="Media from your posts will appear here as it downloads."
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
                  <div key={key} className={`my-media-card`} onClick={() => openViewer(src)} title={tooltip}>
                    <img src={src} loading="lazy" onError={handleImageError} />
                    <div className="my-media-card-overlay">{sizeLabel}</div>
                  </div>
                );
              }
              if (item.mime_type.startsWith("video/")) {
                return (
                  <div key={key} className={`my-media-card video`} onClick={() => openViewer(src, "video")} title={tooltip}>
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
