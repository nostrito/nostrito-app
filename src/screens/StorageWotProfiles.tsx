import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Link } from "react-router-dom";
import { Badge } from "../components/Badge";
import { formatBytes } from "../utils/format";

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

export const StorageWotProfiles: React.FC = () => {
  const [stats, setStats] = useState<OwnershipStorageStats | null>(null);
  const [kindCounts, setKindCounts] = useState<Record<string, number> | null>(null);
  const [mediaBreakdown, setMediaBreakdown] = useState<MediaBreakdown | null>(null);

  useEffect(() => {
    invoke<OwnershipStorageStats>("get_ownership_storage_stats").then(setStats).catch(() => {});
    invoke<KindCountsResult>("get_kind_counts_for_category", { category: "wot" }).then(r => setKindCounts(r.counts)).catch(() => {});
    invoke<MediaBreakdown>("get_media_breakdown_for_category", { category: "wot" }).then(setMediaBreakdown).catch(() => {});
  }, []);

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
        <h2 className="storage-detail-title">WoT Profiles</h2>
        <Badge text="WOT" className="ownership-card-badge" variant="wot" />
      </div>

      <div className="storage-detail-stats">
        <div className="storage-detail-stat">
          <span className="storage-detail-stat-value">{stats ? stats.wot_events_count.toLocaleString() : "\u2014"}</span>
          <span className="storage-detail-stat-label">events</span>
        </div>
        <div className="storage-detail-stat">
          <span className="storage-detail-stat-value">{stats ? formatBytes(stats.wot_media_bytes) : "\u2014"}</span>
          <span className="storage-detail-stat-label">cached media</span>
        </div>
      </div>

      <div className="storage-detail-note">Subject to retention limits</div>

      {/* Media breakdown */}
      {mediaRows && mediaRows.length > 0 && (
        <>
          <div className="kind-breakdown-separator" />
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
        </>
      )}

      <div className="kind-breakdown-separator" />

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
    </div>
  );
};
