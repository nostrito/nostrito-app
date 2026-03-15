import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { EmptyState } from "../components/EmptyState";
import { Avatar } from "../components/Avatar";
import { IconImage } from "../components/Icon";
import { formatBytes, shortPubkey } from "../utils/format";
import { initMediaViewer } from "../utils/media";
import { useProfileContext } from "../context/ProfileContext";
import { profileDisplayName } from "../utils/profiles";
import type { NostrEvent } from "../types/nostr";

interface EventMediaRef {
  url: string;
  local_path: string | null;
  mime_type: string;
  size_bytes: number;
  downloaded: boolean;
  pubkey: string;
  created_at: number;
}

interface BookmarkedMediaItem {
  event_id: string;
  media_url: string;
  event: NostrEvent;
  profile: Record<string, unknown>;
  bookmarked_at: number;
}

type GalleryTab = "mine" | "others" | "favorites";
type MediaFilter = "all" | "images" | "videos" | "audio";
type WotFilter = "all" | "wot2" | "wot3";

interface PersonEntry {
  pubkey: string;
  count: number;
  totalBytes: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  url: string;
  pubkey: string;
}

interface ConfirmDialogState {
  message: string;
  onConfirm: () => void;
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

  // Favorites
  const [favoritesMedia, setFavoritesMedia] = useState<BookmarkedMediaItem[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(new Set());

  // WoT filtering
  const [wotFilter, setWotFilter] = useState<WotFilter>("all");
  const [hopDistances, setHopDistances] = useState<Map<string, number>>(new Map());

  // Selection mode
  const [selectMode, setSelectMode] = useState(false);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());

  // Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

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

  // Load others media + WoT distances
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

      // Load WoT hop distances
      invoke<Record<string, number>>("get_wot_hop_distances")
        .then((distances) => {
          setHopDistances(new Map(Object.entries(distances)));
        })
        .catch((e) => console.error("[gallery] load wot distances failed:", e));
    }
  }, [tab]);

  // Load favorites + favorite URLs set
  useEffect(() => {
    if (tab === "favorites" && favoritesMedia.length === 0) {
      setFavoritesLoading(true);
      invoke<BookmarkedMediaItem[]>("get_bookmarked_media")
        .then((items) => {
          setFavoritesMedia(items);
          setFavoriteUrls(new Set(items.map((i) => i.media_url)));
          const pubkeys = [...new Set(items.map((i) => i.event.pubkey))];
          if (pubkeys.length > 0) ensureProfiles(pubkeys);
        })
        .catch((e) => console.error("[gallery] load favorites failed:", e))
        .finally(() => setFavoritesLoading(false));
    }
  }, [tab]);

  // Load favorite URLs on mount for context menu checks
  useEffect(() => {
    invoke<BookmarkedMediaItem[]>("get_bookmarked_media")
      .then((items) => setFavoriteUrls(new Set(items.map((i) => i.media_url))))
      .catch(() => {});
  }, []);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  // Build people list from others media (filtered by WoT)
  const wotFilteredOthers = useMemo(() => {
    if (wotFilter === "all") return othersMedia;
    const maxHop = wotFilter === "wot2" ? 2 : 3;
    return othersMedia.filter((m) => {
      const hop = hopDistances.get(m.pubkey);
      return hop !== undefined && hop <= maxHop;
    });
  }, [othersMedia, wotFilter, hopDistances]);

  const people = useMemo(() => {
    const map = new Map<string, PersonEntry>();
    for (const item of wotFilteredOthers) {
      const existing = map.get(item.pubkey);
      if (existing) {
        existing.count++;
        existing.totalBytes += item.size_bytes;
      } else {
        map.set(item.pubkey, { pubkey: item.pubkey, count: 1, totalBytes: item.size_bytes });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [wotFilteredOthers]);

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
    const base = selectedPubkey ? wotFilteredOthers.filter((m) => m.pubkey === selectedPubkey) : wotFilteredOthers;
    return filterByType(base);
  }, [wotFilteredOthers, selectedPubkey, filterByType]);

  // Convert bookmarked items to EventMediaRef-like for grid rendering
  const filteredFavorites = useMemo(() => {
    const asMedia: EventMediaRef[] = favoritesMedia.map((item) => {
      const mime = item.media_url.match(/\.(mp4|webm|mov)(\?|$)/i)
        ? "video/mp4"
        : item.media_url.match(/\.(mp3|ogg|wav|flac)(\?|$)/i)
        ? "audio/mpeg"
        : "image/jpeg";
      return {
        url: item.media_url,
        local_path: null,
        mime_type: mime,
        size_bytes: 0,
        downloaded: false,
        pubkey: item.event.pubkey,
        created_at: item.event.created_at,
      };
    });
    return filterByType(asMedia);
  }, [favoritesMedia, filterByType]);

  const openViewer = useCallback((url: string, type?: "image" | "video", originalUrl?: string, pubkey?: string) => {
    if (typeof (window as any).openMediaViewer === "function") {
      (window as any).openMediaViewer(url, type, { pubkey, originalUrl: originalUrl || url });
    }
  }, []);

  const handleImageError = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const card = e.currentTarget.parentElement;
    if (card) card.classList.add("broken");
  }, []);

  // Selection helpers
  const toggleSelect = useCallback((url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedUrls(new Set());
  }, []);

  // Delete media files
  const deleteMediaFiles = useCallback(async (urls: string[]) => {
    try {
      await invoke("delete_media_files", { urls });
      // Remove from local state
      setOthersMedia((prev) => prev.filter((m) => !urls.includes(m.url)));
      setOwnMedia((prev) => prev.filter((m) => !urls.includes(m.url)));
    } catch (e) {
      console.error("[gallery] delete failed:", e);
    }
  }, []);

  // Favorite / unfavorite
  const toggleFavorite = useCallback(async (url: string, pubkey: string) => {
    const isFav = favoriteUrls.has(url);
    try {
      if (isFav) {
        // Find event_id for this media to unbookmark
        const event = await invoke<NostrEvent | null>("find_event_for_media", { mediaUrl: url, pubkey });
        if (event) {
          await invoke("unbookmark_media", { eventId: event.id, mediaUrl: url });
          setFavoriteUrls((prev) => {
            const next = new Set(prev);
            next.delete(url);
            return next;
          });
          setFavoritesMedia((prev) => prev.filter((f) => f.media_url !== url));
        }
      } else {
        const event = await invoke<NostrEvent | null>("find_event_for_media", { mediaUrl: url, pubkey });
        if (event) {
          await invoke("bookmark_media", { eventId: event.id, mediaUrl: url });
          setFavoriteUrls((prev) => new Set(prev).add(url));
          // Reload favorites next time tab is selected
          setFavoritesMedia([]);
        }
      }
    } catch (e) {
      console.error("[gallery] toggle favorite failed:", e);
    }
  }, [favoriteUrls]);

  const handleContextMenu = useCallback((e: React.MouseEvent, url: string, pubkey: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, url, pubkey });
  }, []);

  const renderMediaGrid = (media: EventMediaRef[], loading: boolean, showSelect?: boolean) => {
    if (loading) {
      return (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.85rem" }}>
          loading media...
        </div>
      );
    }
    if (media.length === 0) {
      return (
        <EmptyState
          icon={<IconImage />}
          message="no media found."
          hint="media will appear here as it downloads from relays."
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
          const isSelected = showSelect && selectMode && selectedUrls.has(item.url);

          const tileClick = showSelect && selectMode
            ? () => toggleSelect(item.url)
            : undefined;

          const cardContent = (
            <>
              {showSelect && selectMode && (
                <input
                  type="checkbox"
                  className="gallery-tile-select"
                  checked={isSelected || false}
                  onChange={() => toggleSelect(item.url)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </>
          );

          if (item.mime_type.startsWith("image/")) {
            return (
              <div
                key={key}
                className="my-media-card"
                style={{ position: "relative" }}
                onClick={tileClick || (() => openViewer(src, "image", item.url, item.pubkey))}
                onContextMenu={(e) => handleContextMenu(e, item.url, item.pubkey)}
                title={tooltip}
              >
                {cardContent}
                <img src={src} loading="lazy" onError={handleImageError} />
                <div className="my-media-card-overlay">{sizeLabel}</div>
              </div>
            );
          }
          if (item.mime_type.startsWith("video/")) {
            return (
              <div
                key={key}
                className="my-media-card video"
                style={{ position: "relative" }}
                onClick={tileClick || (() => openViewer(src, "video", item.url, item.pubkey))}
                onContextMenu={(e) => handleContextMenu(e, item.url, item.pubkey)}
                title={tooltip}
              >
                {cardContent}
                <video src={src} preload="metadata" muted />
                <div className="my-media-card-play">{"\u25B6"}</div>
                <div className="my-media-card-overlay">{sizeLabel}</div>
              </div>
            );
          }
          if (item.mime_type.startsWith("audio/")) {
            return (
              <div
                key={key}
                className="my-media-card audio"
                style={{ position: "relative" }}
                onContextMenu={(e) => handleContextMenu(e, item.url, item.pubkey)}
                title={tooltip}
              >
                {cardContent}
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
          my content
        </button>
        <button className={`gallery-tab${tab === "others" ? " active" : ""}`} onClick={() => setTab("others")}>
          others
        </button>
        <button className={`gallery-tab${tab === "favorites" ? " active" : ""}`} onClick={() => setTab("favorites")}>
          <span className="icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </span>
          {" "}favorites
        </button>
      </div>

      {/* Content area */}
      <div className="gallery-content">
        {tab === "mine" && (
          <div style={{ padding: 24 }}>
            <div className="gallery-actions-bar">
              <button
                className={`gallery-action-btn${selectMode ? " active" : ""}`}
                onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
              >
                {selectMode ? "cancel" : "select"}
              </button>
              {selectMode && selectedUrls.size > 0 && (
                <button
                  className="gallery-action-btn danger"
                  onClick={() =>
                    setConfirmDialog({
                      message: `delete ${selectedUrls.size} selected file${selectedUrls.size === 1 ? "" : "s"}?`,
                      onConfirm: async () => {
                        await deleteMediaFiles([...selectedUrls]);
                        exitSelectMode();
                        setConfirmDialog(null);
                      },
                    })
                  }
                >
                  delete selected ({selectedUrls.size})
                </button>
              )}
            </div>
            <div className="my-media-filters">
              {(["all", "images", "videos", "audio"] as MediaFilter[]).map((f) => (
                <button key={f} className={`my-media-filter${mediaFilter === f ? " active" : ""}`} onClick={() => setMediaFilter(f)}>
                  {f}
                </button>
              ))}
              <span className="my-media-stats" style={{ marginLeft: "auto" }}>
                {filteredOwn.length} files
              </span>
            </div>
            {renderMediaGrid(filteredOwn, ownLoading, true)}
          </div>
        )}

        {tab === "favorites" && (
          <div style={{ padding: 24 }}>
            <div className="gallery-actions-bar">
              <button
                className={`gallery-action-btn${selectMode ? " active" : ""}`}
                onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
              >
                {selectMode ? "cancel" : "select"}
              </button>
              {selectMode && selectedUrls.size > 0 && (
                <button
                  className="gallery-action-btn danger"
                  onClick={() =>
                    setConfirmDialog({
                      message: `delete ${selectedUrls.size} selected file${selectedUrls.size === 1 ? "" : "s"}?`,
                      onConfirm: async () => {
                        await deleteMediaFiles([...selectedUrls]);
                        exitSelectMode();
                        setConfirmDialog(null);
                      },
                    })
                  }
                >
                  delete selected ({selectedUrls.size})
                </button>
              )}
            </div>
            <div className="my-media-filters">
              {(["all", "images", "videos", "audio"] as MediaFilter[]).map((f) => (
                <button key={f} className={`my-media-filter${mediaFilter === f ? " active" : ""}`} onClick={() => setMediaFilter(f)}>
                  {f}
                </button>
              ))}
              <span className="my-media-stats" style={{ marginLeft: "auto" }}>
                {filteredFavorites.length} files
              </span>
            </div>
            {renderMediaGrid(filteredFavorites, favoritesLoading, true)}
          </div>
        )}

        {tab === "others" && (
          <div className="gallery-split">
            {/* People sidebar */}
            <div className="gallery-people">
              <div className="gallery-people-header">
                <span>people</span>
                <span className="gallery-people-count">{people.length}</span>
              </div>
              {othersLoading && people.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  loading...
                </div>
              )}
              {!othersLoading && people.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  no media from others yet.
                </div>
              )}
              <div
                className={`gallery-person-item${selectedPubkey === null ? " active" : ""}`}
                onClick={() => setSelectedPubkey(null)}
              >
                <div className="gallery-person-info">
                  <span style={{ fontWeight: 600, fontSize: "0.84rem" }}>all people</span>
                </div>
                <span className="gallery-person-count">{wotFilteredOthers.length}</span>
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
                {/* WoT filter bar */}
                <div className="gallery-wot-filters">
                  {([["all", "all"], ["wot2", "wot \u2264 2"], ["wot3", "wot \u2264 3"]] as [WotFilter, string][]).map(([value, label]) => (
                    <button
                      key={value}
                      className={`gallery-wot-filter-btn${wotFilter === value ? " active" : ""}`}
                      onClick={() => setWotFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Actions bar */}
                <div className="gallery-actions-bar">
                  <button
                    className={`gallery-action-btn${selectMode ? " active" : ""}`}
                    onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
                  >
                    {selectMode ? "cancel" : "select"}
                  </button>
                  {selectMode && selectedUrls.size > 0 && (
                    <button
                      className="gallery-action-btn danger"
                      onClick={() =>
                        setConfirmDialog({
                          message: `delete ${selectedUrls.size} selected file${selectedUrls.size === 1 ? "" : "s"}?`,
                          onConfirm: async () => {
                            await deleteMediaFiles([...selectedUrls]);
                            exitSelectMode();
                            setConfirmDialog(null);
                          },
                        })
                      }
                    >
                      delete selected ({selectedUrls.size})
                    </button>
                  )}
                  {!selectMode && filteredOthers.length > 0 && (
                    <button
                      className="gallery-action-btn danger"
                      onClick={() =>
                        setConfirmDialog({
                          message: `delete all ${filteredOthers.length} file${filteredOthers.length === 1 ? "" : "s"} from others?`,
                          onConfirm: async () => {
                            await deleteMediaFiles(filteredOthers.map((m) => m.url));
                            setConfirmDialog(null);
                          },
                        })
                      }
                    >
                      delete all
                    </button>
                  )}
                </div>

                <div className="my-media-filters">
                  {(["all", "images", "videos", "audio"] as MediaFilter[]).map((f) => (
                    <button key={f} className={`my-media-filter${mediaFilter === f ? " active" : ""}`} onClick={() => setMediaFilter(f)}>
                      {f}
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
                {renderMediaGrid(filteredOthers, othersLoading, true)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="gallery-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="gallery-context-menu-item"
            onClick={async () => {
              await toggleFavorite(contextMenu.url, contextMenu.pubkey);
              setContextMenu(null);
            }}
          >
            <span className="icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill={favoriteUrls.has(contextMenu.url) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </span>
            {favoriteUrls.has(contextMenu.url) ? "unfavorite" : "favorite"}
          </div>
          <div
            className="gallery-context-menu-item danger"
            onClick={() => {
              const url = contextMenu.url;
              setContextMenu(null);
              setConfirmDialog({
                message: "delete this media file?",
                onConfirm: async () => {
                  await deleteMediaFiles([url]);
                  setConfirmDialog(null);
                },
              });
            }}
          >
            <span className="icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
            delete
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmDialog && (
        <div className="gallery-confirm-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="gallery-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p>{confirmDialog.message}</p>
            <div className="gallery-confirm-actions">
              <button onClick={() => setConfirmDialog(null)}>cancel</button>
              <button className="danger" onClick={confirmDialog.onConfirm}>delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
