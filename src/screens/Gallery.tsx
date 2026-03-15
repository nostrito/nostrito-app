import React, { useState, useEffect, useMemo, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { EmptyState } from "../components/EmptyState";
import { Avatar } from "../components/Avatar";
import { IconImage } from "../components/Icon";
import { formatBytes, shortPubkey } from "../utils/format";
import { initMediaViewer } from "../utils/media";
import { useProfileContext } from "../context/ProfileContext";
import { profileDisplayName } from "../utils/profiles";

interface EventMediaRef {
  url: string;
  local_path: string | null;
  mime_type: string;
  size_bytes: number;
  downloaded: boolean;
  pubkey: string;
  created_at: number;
}

type GalleryTab = "mine" | "others";
type MediaFilter = "all" | "images" | "videos" | "audio";

interface PersonEntry {
  pubkey: string;
  count: number;
  totalBytes: number;
}

export const Gallery: React.FC = () => {
  const { ensureProfiles, getProfile, profileVersion } = useProfileContext();

  const [tab, setTab] = useState<GalleryTab>("mine");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);

  // Own media
  const [ownMedia, setOwnMedia] = useState<EventMediaRef[]>([]);
  const [ownLoading, setOwnLoading] = useState(false);

  // Others media
  const [othersMedia, setOthersMedia] = useState<EventMediaRef[]>([]);
  const [othersLoading, setOthersLoading] = useState(false);

  useEffect(() => {
    initMediaViewer();
  }, []);

  // Load own media
  useEffect(() => {
    if (tab === "mine" && ownMedia.length === 0) {
      setOwnLoading(true);
      invoke<EventMediaRef[]>("get_event_media_for_category", { category: "own", limit: 1000 })
        .then((media) => {
          setOwnMedia(media);
          const pubkeys = [...new Set(media.map((m) => m.pubkey))];
          if (pubkeys.length > 0) ensureProfiles(pubkeys);
        })
        .catch((e) => console.error("[gallery] load own media failed:", e))
        .finally(() => setOwnLoading(false));
    }
  }, [tab]);

  // Load others media
  useEffect(() => {
    if (tab === "others" && othersMedia.length === 0) {
      setOthersLoading(true);
      Promise.all([
        invoke<EventMediaRef[]>("get_event_media_for_category", { category: "tracked", limit: 1000 }),
        invoke<EventMediaRef[]>("get_event_media_for_category", { category: "wot", limit: 1000 }),
      ])
        .then(([tracked, wot]) => {
          const combined = [...tracked, ...wot];
          setOthersMedia(combined);
          const pubkeys = [...new Set(combined.map((m) => m.pubkey))];
          if (pubkeys.length > 0) ensureProfiles(pubkeys);
        })
        .catch((e) => console.error("[gallery] load others media failed:", e))
        .finally(() => setOthersLoading(false));
    }
  }, [tab]);

  // Build people list from others media
  const people = useMemo(() => {
    const map = new Map<string, PersonEntry>();
    for (const item of othersMedia) {
      const existing = map.get(item.pubkey);
      if (existing) {
        existing.count++;
        existing.totalBytes += item.size_bytes;
      } else {
        map.set(item.pubkey, { pubkey: item.pubkey, count: 1, totalBytes: item.size_bytes });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [othersMedia]);

  // Filter media by type
  const filterByType = useCallback(
    (media: EventMediaRef[]) => {
      switch (mediaFilter) {
        case "images":
          return media.filter((m) => m.mime_type.startsWith("image/"));
        case "videos":
          return media.filter((m) => m.mime_type.startsWith("video/"));
        case "audio":
          return media.filter((m) => m.mime_type.startsWith("audio/"));
        default:
          return media;
      }
    },
    [mediaFilter],
  );

  const filteredOwn = useMemo(() => filterByType(ownMedia), [ownMedia, filterByType]);

  const filteredOthers = useMemo(() => {
    const base = selectedPubkey ? othersMedia.filter((m) => m.pubkey === selectedPubkey) : othersMedia;
    return filterByType(base);
  }, [othersMedia, selectedPubkey, filterByType]);

  const openViewer = useCallback((url: string, type?: "image" | "video", originalUrl?: string, pubkey?: string) => {
    if (typeof (window as any).openMediaViewer === "function") {
      (window as any).openMediaViewer(url, type, { pubkey, originalUrl: originalUrl || url });
    }
  }, []);

  const handleImageError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const card = e.currentTarget.parentElement;
    if (card) card.classList.add("broken");
  }, []);

  const renderMediaGrid = (media: EventMediaRef[], loading: boolean) => {
    if (loading) {
      return (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Loading media...
        </div>
      );
    }
    if (media.length === 0) {
      return (
        <EmptyState
          icon={<IconImage />}
          message="No media found."
          hint="Media will appear here as it downloads from relays."
        />
      );
    }
    return (
      <div className="my-media-grid">
        {media.map((item, idx) => {
          const src = item.local_path ? convertFileSrc(item.local_path) : item.url;
          const date = new Date(item.created_at * 1000).toLocaleDateString();
          const sizeLabel = item.size_bytes > 0 ? formatBytes(item.size_bytes) : "";
          const tooltip = `${date}${sizeLabel ? ` \u00B7 ${sizeLabel}` : ""}`;
          const key = `${item.url}-${idx}`;

          if (item.mime_type.startsWith("image/")) {
            return (
              <div key={key} className="my-media-card" onClick={() => openViewer(src, "image", item.url, item.pubkey)} title={tooltip}>
                <img src={src} loading="lazy" onError={handleImageError} />
                <div className="my-media-card-overlay">{sizeLabel}</div>
              </div>
            );
          }
          if (item.mime_type.startsWith("video/")) {
            return (
              <div key={key} className="my-media-card video" onClick={() => openViewer(src, "video", item.url, item.pubkey)} title={tooltip}>
                <video src={src} preload="metadata" muted />
                <div className="my-media-card-play">{"\u25B6"}</div>
                <div className="my-media-card-overlay">{sizeLabel}</div>
              </div>
            );
          }
          if (item.mime_type.startsWith("audio/")) {
            return (
              <div key={key} className="my-media-card audio" title={tooltip}>
                <audio src={src} controls preload="metadata" onClick={(e) => e.stopPropagation()} />
                <div className="my-media-card-overlay">{sizeLabel}</div>
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  };

  // Use profileVersion to trigger re-renders when profiles load
  void profileVersion;

  return (
    <div className="gallery-container">
      {/* Tab bar */}
      <div className="gallery-tabs">
        <button className={`gallery-tab${tab === "mine" ? " active" : ""}`} onClick={() => setTab("mine")}>
          My Content
        </button>
        <button className={`gallery-tab${tab === "others" ? " active" : ""}`} onClick={() => setTab("others")}>
          Others
        </button>
      </div>

      {/* Content area */}
      <div className="gallery-content">
        {tab === "mine" && (
          <div style={{ padding: 24 }}>
            <div className="my-media-filters">
              {(["all", "images", "videos", "audio"] as MediaFilter[]).map((f) => (
                <button key={f} className={`my-media-filter${mediaFilter === f ? " active" : ""}`} onClick={() => setMediaFilter(f)}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
              <span className="my-media-stats" style={{ marginLeft: "auto" }}>
                {filteredOwn.length} files
              </span>
            </div>
            {renderMediaGrid(filteredOwn, ownLoading)}
          </div>
        )}

        {tab === "others" && (
          <div className="gallery-split">
            {/* People sidebar */}
            <div className="gallery-people">
              <div className="gallery-people-header">
                <span>People</span>
                <span className="gallery-people-count">{people.length}</span>
              </div>
              {othersLoading && people.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  Loading...
                </div>
              )}
              {!othersLoading && people.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  No media from others yet.
                </div>
              )}
              <div
                className={`gallery-person-item${selectedPubkey === null ? " active" : ""}`}
                onClick={() => setSelectedPubkey(null)}
              >
                <div className="gallery-person-info">
                  <span style={{ fontWeight: 600, fontSize: "0.84rem" }}>All People</span>
                </div>
                <span className="gallery-person-count">{othersMedia.length}</span>
              </div>
              {people.map((person) => {
                const profile = getProfile(person.pubkey);
                return (
                  <div
                    key={person.pubkey}
                    className={`gallery-person-item${selectedPubkey === person.pubkey ? " active" : ""}`}
                    onClick={() => setSelectedPubkey(person.pubkey === selectedPubkey ? null : person.pubkey)}
                  >
                    <Avatar
                      picture={profile?.picture}
                      pubkey={person.pubkey}
                      className="gallery-person-avatar"
                      clickable={false}
                    />
                    <div className="gallery-person-meta">
                      <span className="gallery-person-name">
                        {profileDisplayName(profile, person.pubkey)}
                      </span>
                      <span className="gallery-person-npub">{shortPubkey(person.pubkey)}</span>
                    </div>
                    <div className="gallery-person-stats">
                      <span className="gallery-person-count">{person.count}</span>
                      <span className="gallery-person-size">{formatBytes(person.totalBytes)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Media grid panel */}
            <div className="gallery-grid-panel">
              <div style={{ padding: 24 }}>
                <div className="my-media-filters">
                  {(["all", "images", "videos", "audio"] as MediaFilter[]).map((f) => (
                    <button key={f} className={`my-media-filter${mediaFilter === f ? " active" : ""}`} onClick={() => setMediaFilter(f)}>
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                  <span className="my-media-stats" style={{ marginLeft: "auto" }}>
                    {filteredOthers.length} files
                    {selectedPubkey && (
                      <>
                        {" "}
                        &middot;{" "}
                        <span
                          style={{ color: "var(--accent-light)", cursor: "pointer" }}
                          onClick={() => setSelectedPubkey(null)}
                        >
                          clear filter
                        </span>
                      </>
                    )}
                  </span>
                </div>
                {renderMediaGrid(filteredOthers, othersLoading)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
