import React, { useMemo } from "react";

/* ------------------------------------------------------------------ */
/*  SVG Icons                                                          */
/* ------------------------------------------------------------------ */

export const kindIcons = {
  notes: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 1H3a1 1 0 00-1 1v12a1 1 0 001 1h7l4-4V2a1 1 0 00-1-1z"/>
      <path d="M10 14v-4h4M5 5h6M5 8h4"/>
    </svg>
  ),
  reposts: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 1l3 3-3 3"/>
      <path d="M14 4H5a3 3 0 00-3 3v1M5 15l-3-3 3-3"/>
      <path d="M2 12h9a3 3 0 003-3V8"/>
    </svg>
  ),
  reactions: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14s-5.5-3.5-5.5-7A3.5 3.5 0 018 4a3.5 3.5 0 015.5 3c0 3.5-5.5 7-5.5 7z"/>
    </svg>
  ),
  profiles: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="3"/>
      <path d="M2 14c0-3 2.5-5 6-5s6 2 6 5"/>
    </svg>
  ),
  contacts: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.5"/>
      <circle cx="11" cy="6" r="2"/>
      <path d="M1 14c0-2.5 2-4.5 5-4.5s5 2 5 4.5M11 8.5c2 0 4 1.2 4 3.5"/>
    </svg>
  ),
  articles: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="1" width="12" height="14" rx="1"/>
      <path d="M5 4h6M5 7h6M5 10h3"/>
    </svg>
  ),
  zaps: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1L3 9h5l-1 6 6-8H8l1-6z"/>
    </svg>
  ),
  dms: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="10" height="7" rx="1"/>
      <path d="M3 5l5 3.5L13 5"/>
    </svg>
  ),
  other: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2"/>
      <circle cx="8" cy="8" r="1.5"/>
    </svg>
  ),
  images: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2"/>
      <circle cx="6" cy="6" r="1.5"/>
      <path d="M14 11l-2.5-2.5a1.5 1.5 0 00-2 0L4 14"/>
    </svg>
  ),
  videos: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="10" height="8" rx="1"/>
      <path d="M11 7l4-2.5v7L11 9"/>
    </svg>
  ),
  audio: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 12V3l8-1.5v10"/>
      <circle cx="4" cy="12" r="2"/>
      <circle cx="12" cy="11.5" r="2"/>
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/*  Types & constants                                                  */
/* ------------------------------------------------------------------ */

export interface KindCategory {
  label: string;
  icon: React.ReactNode;
  color: string;
  kinds: number[];
}

export interface KindRow {
  label: string;
  icon: React.ReactNode;
  color: string;
  count: number;
}

export interface MediaRow {
  label: string;
  icon: React.ReactNode;
  color: string;
  count: number;
  bytes: number;
}

export const KIND_CATEGORIES: KindCategory[] = [
  { label: "Notes",      icon: kindIcons.notes,     color: "var(--green)",        kinds: [1] },
  { label: "Reposts",    icon: kindIcons.reposts,    color: "var(--blue)",         kinds: [6] },
  { label: "Reactions",  icon: kindIcons.reactions,  color: "var(--red)",          kinds: [7] },
  { label: "Profiles",   icon: kindIcons.profiles,   color: "var(--accent-light)", kinds: [0] },
  { label: "Contacts",   icon: kindIcons.contacts,   color: "var(--purple)",       kinds: [3] },
  { label: "Articles",   icon: kindIcons.articles,   color: "var(--orange)",       kinds: [30023] },
  { label: "Zaps",       icon: kindIcons.zaps,       color: "var(--yellow)",       kinds: [9735] },
  { label: "DMs",        icon: kindIcons.dms,        color: "var(--blue)",         kinds: [4, 1059] },
];

export const MEDIA_COLORS = {
  images: "var(--green)",
  videos: "var(--blue)",
  audio: "var(--orange)",
  other: "var(--text-dim)",
};

/* ------------------------------------------------------------------ */
/*  Aggregation helpers                                                */
/* ------------------------------------------------------------------ */

export function aggregateKindRows(counts: Record<string, number>): KindRow[] {
  const remaining = new Map<number, number>();
  for (const [k, v] of Object.entries(counts)) {
    remaining.set(Number(k), v);
  }

  const rows: KindRow[] = [];

  for (const cat of KIND_CATEGORIES) {
    let total = 0;
    for (const k of cat.kinds) {
      total += remaining.get(k) || 0;
      remaining.delete(k);
    }
    if (total > 0) {
      rows.push({ label: cat.label, icon: cat.icon, color: cat.color, count: total });
    }
  }

  let otherCount = 0;
  for (const v of remaining.values()) otherCount += v;
  if (otherCount > 0) {
    rows.push({ label: "Other", icon: kindIcons.other, color: "var(--text-dim)", count: otherCount });
  }

  rows.sort((a, b) => b.count - a.count);
  return rows;
}

export interface MediaBreakdown {
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

export function buildMediaRows(mb: MediaBreakdown): MediaRow[] {
  return [
    { label: "Images", icon: kindIcons.images, color: MEDIA_COLORS.images, count: mb.image_count, bytes: mb.image_bytes },
    { label: "Videos", icon: kindIcons.videos, color: MEDIA_COLORS.videos, count: mb.video_count, bytes: mb.video_bytes },
    { label: "Audio",  icon: kindIcons.audio,  color: MEDIA_COLORS.audio,  count: mb.audio_count, bytes: mb.audio_bytes },
    { label: "Other",  icon: kindIcons.other,  color: MEDIA_COLORS.other,  count: mb.other_count, bytes: mb.other_bytes },
  ].filter(r => r.count > 0).sort((a, b) => b.bytes - a.bytes);
}

/* ------------------------------------------------------------------ */
/*  Donut + bar list component (event breakdown)                       */
/* ------------------------------------------------------------------ */

interface KindBreakdownChartProps {
  title: string;
  kindCounts: Record<string, number> | null;
  error?: boolean;
}

export const KindBreakdownChart: React.FC<KindBreakdownChartProps> = ({ title, kindCounts, error }) => {
  const kindRows = useMemo(() => kindCounts ? aggregateKindRows(kindCounts) : null, [kindCounts]);
  const maxKindCount = useMemo(() => kindRows && kindRows.length > 0 ? kindRows[0].count : 0, [kindRows]);

  return (
    <div className="kind-breakdown-section">
      <div className="kind-breakdown-title">{title}</div>

      {!kindCounts && !error && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Loading...</div>
      )}
      {error && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Unable to load breakdown</div>
      )}
      {kindRows && kindRows.length === 0 && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>No events stored</div>
      )}

      {kindRows && kindRows.length > 0 && (
        <div className="kind-breakdown-layout">
          {/* Donut chart */}
          <div className="kind-donut-wrap">
            <svg viewBox="0 0 100 100" className="kind-donut">
              {(() => {
                const totalCount = kindRows.reduce((s, r) => s + r.count, 0);
                let cumulative = 0;
                const radius = 38;
                const circumference = 2 * Math.PI * radius;
                return kindRows.map((row, i) => {
                  const fraction = totalCount > 0 ? row.count / totalCount : 0;
                  const dashLength = fraction * circumference;
                  const dashOffset = -cumulative * circumference;
                  cumulative += fraction;
                  return (
                    <circle
                      key={row.label}
                      cx="50"
                      cy="50"
                      r={radius}
                      fill="none"
                      stroke={row.color}
                      strokeWidth="10"
                      strokeDasharray={`${dashLength} ${circumference - dashLength}`}
                      strokeDashoffset={dashOffset}
                      className="kind-donut-segment"
                      style={{ animationDelay: `${i * 80}ms` }}
                    />
                  );
                });
              })()}
            </svg>
            <div className="kind-donut-center">
              <span className="kind-donut-total">
                {kindRows.reduce((s, r) => s + r.count, 0).toLocaleString()}
              </span>
              <span className="kind-donut-total-label">events</span>
            </div>
          </div>

          {/* Bar list */}
          <div className="kind-breakdown-list">
            {kindRows.map((row, i) => {
              const pct = maxKindCount > 0 ? (row.count / maxKindCount) * 100 : 0;
              const totalCount = kindRows.reduce((s, r) => s + r.count, 0);
              const share = totalCount > 0 ? ((row.count / totalCount) * 100).toFixed(1) : "0";
              return (
                <div
                  className="kind-breakdown-row"
                  key={row.label}
                  style={{ "--row-color": row.color, animationDelay: `${i * 60}ms` } as React.CSSProperties}
                >
                  <span className="kind-breakdown-icon" style={{ color: row.color }}>
                    {row.icon}
                  </span>
                  <span className="kind-breakdown-label">{row.label}</span>
                  <div className="kind-breakdown-bar-wrap">
                    <div
                      className="kind-breakdown-bar"
                      style={{ width: `${pct}%`, background: row.color, animationDelay: `${i * 60 + 200}ms` }}
                    />
                  </div>
                  <span className="kind-breakdown-count" style={{ color: row.color }}>
                    {row.count.toLocaleString()}
                  </span>
                  <span className="kind-breakdown-pct">{share}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Donut + bar list component (media breakdown)                       */
/* ------------------------------------------------------------------ */

interface MediaBreakdownChartProps {
  mediaBreakdown: MediaBreakdown;
  formatBytes: (bytes: number) => string;
}

export const MediaBreakdownChart: React.FC<MediaBreakdownChartProps> = ({ mediaBreakdown, formatBytes }) => {
  const mediaRows = useMemo(() => buildMediaRows(mediaBreakdown), [mediaBreakdown]);
  const maxMediaBytes = useMemo(() => mediaRows.length > 0 ? mediaRows[0].bytes : 0, [mediaRows]);

  if (mediaRows.length === 0) return null;

  return (
    <div className="kind-breakdown-section">
      <div className="kind-breakdown-title">Media Breakdown</div>
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

      <div className="kind-breakdown-layout">
        {/* Donut chart */}
        <div className="kind-donut-wrap">
          <svg viewBox="0 0 100 100" className="kind-donut">
            {(() => {
              const totalBytes = mediaBreakdown.total_bytes;
              let cumulative = 0;
              const radius = 38;
              const circumference = 2 * Math.PI * radius;
              return mediaRows.map((row, i) => {
                const fraction = totalBytes > 0 ? row.bytes / totalBytes : 0;
                const dashLength = fraction * circumference;
                const dashOffset = -cumulative * circumference;
                cumulative += fraction;
                return (
                  <circle
                    key={row.label}
                    cx="50"
                    cy="50"
                    r={radius}
                    fill="none"
                    stroke={row.color}
                    strokeWidth="10"
                    strokeDasharray={`${dashLength} ${circumference - dashLength}`}
                    strokeDashoffset={dashOffset}
                    className="kind-donut-segment"
                    style={{ animationDelay: `${i * 80}ms` }}
                  />
                );
              });
            })()}
          </svg>
          <div className="kind-donut-center">
            <span className="kind-donut-total">{formatBytes(mediaBreakdown.total_bytes)}</span>
            <span className="kind-donut-total-label">total</span>
          </div>
        </div>

        {/* Bar list */}
        <div className="kind-breakdown-list">
          {mediaRows.map((row, i) => {
            const pct = maxMediaBytes > 0 ? (row.bytes / maxMediaBytes) * 100 : 0;
            const share = mediaBreakdown.total_bytes > 0 ? ((row.bytes / mediaBreakdown.total_bytes) * 100).toFixed(1) : "0";
            return (
              <div
                className="kind-breakdown-row"
                key={row.label}
                style={{ "--row-color": row.color, animationDelay: `${i * 60}ms` } as React.CSSProperties}
              >
                <span className="kind-breakdown-icon" style={{ color: row.color }}>
                  {row.icon}
                </span>
                <span className="kind-breakdown-label">{row.label}</span>
                <div className="kind-breakdown-bar-wrap">
                  <div
                    className="kind-breakdown-bar"
                    style={{ width: `${pct}%`, background: row.color, animationDelay: `${i * 60 + 200}ms` }}
                  />
                </div>
                <span className="kind-breakdown-count" style={{ color: row.color }}>
                  {row.count.toLocaleString()} &middot; {formatBytes(row.bytes)}
                </span>
                <span className="kind-breakdown-pct">{share}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
