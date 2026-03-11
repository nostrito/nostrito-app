import React, { useState, useEffect, useMemo, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { IconImage } from "../components/Icon";
import { EmptyState } from "../components/EmptyState";
import { formatBytes } from "../utils/format";
import { initMediaViewer } from "../utils/media";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MediaItem {
  hash: string;
  url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  downloaded_at: number;
}

type MediaFilter = "all" | "images" | "videos" | "audio";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MyMedia: React.FC = () => {
  /* --- state -------------------------------------------------------- */
  const [allMedia, setAllMedia] = useState<MediaItem[]>([]);
  const [currentFilter, setCurrentFilter] = useState<MediaFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  /* --- initialise media viewer (lightbox) once ---------------------- */
  useEffect(() => {
    initMediaViewer();
  }, []);

  /* --- data loading ------------------------------------------------- */
  useEffect(() => {
    invoke<MediaItem[]>("get_own_media")
      .then((items) => {
        setAllMedia(items);
        setLoading(false);
      })
      .catch((e) => {
        console.error("[my-media] Failed to load:", e);
        setError(true);
        setLoading(false);
      });
  }, []);

  /* --- derived values ----------------------------------------------- */
  const statsText = useMemo(() => {
    if (loading) return "Loading...";
    const totalSize = allMedia.reduce((sum, m) => sum + m.size_bytes, 0);
    return `${allMedia.length} files \u00B7 ${formatBytes(totalSize)}`;
  }, [allMedia, loading]);

  const filtered = useMemo(() => {
    switch (currentFilter) {
      case "images":
        return allMedia.filter((m) => m.mime_type.startsWith("image/"));
      case "videos":
        return allMedia.filter((m) => m.mime_type.startsWith("video/"));
      case "audio":
        return allMedia.filter((m) => m.mime_type.startsWith("audio/"));
      default:
        return allMedia;
    }
  }, [allMedia, currentFilter]);

  /* --- helpers ------------------------------------------------------ */
  const openViewer = useCallback((url: string, type?: "image" | "video") => {
    if (typeof (window as any).openMediaViewer === "function") {
      (window as any).openMediaViewer(url, type);
    }
  }, []);

  const handleImageError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const card = e.currentTarget.parentElement;
      if (card) card.classList.add("broken");
    },
    [],
  );

  /* --- filter buttons ----------------------------------------------- */
  const filters: { key: MediaFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "images", label: "Images" },
    { key: "videos", label: "Videos" },
    { key: "audio", label: "Audio" },
  ];

  /* --- render ------------------------------------------------------- */
  return (
    <div className="my-media-page">
      {/* ---- Header ---- */}
      <div className="my-media-header">
        <h2 className="my-media-title">
          <IconImage /> My Media
        </h2>
        <div className="my-media-stats">{statsText}</div>
      </div>

      {/* ---- Filter buttons ---- */}
      <div className="my-media-filters">
        {filters.map((f) => (
          <button
            key={f.key}
            className={`my-media-filter${currentFilter === f.key ? " active" : ""}`}
            onClick={() => setCurrentFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ---- Grid ---- */}
      <div className="my-media-grid">
        {/* Loading */}
        {loading && <div className="my-media-loading">Loading media...</div>}

        {/* Error */}
        {error && !loading && (
          <div className="my-media-empty">Failed to load media</div>
        )}

        {/* Empty state */}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            icon={<IconImage />}
            message={`No ${currentFilter === "all" ? "" : currentFilter + " "}media cached yet.`}
            hint="Your own media will appear here as it syncs from relays."
          />
        )}

        {/* Media cards */}
        {!loading &&
          !error &&
          filtered.map((item) => {
            const localSrc = convertFileSrc(item.local_path);
            const date = new Date(item.downloaded_at * 1000).toLocaleDateString();
            const tooltip = `${date} \u00B7 ${formatBytes(item.size_bytes)}`;

            if (item.mime_type.startsWith("image/")) {
              return (
                <div
                  key={item.hash}
                  className="my-media-card"
                  onClick={() => openViewer(localSrc)}
                  title={tooltip}
                >
                  <img
                    src={localSrc}
                    loading="lazy"
                    onError={handleImageError}
                  />
                  <div className="my-media-card-overlay">
                    {formatBytes(item.size_bytes)}
                  </div>
                </div>
              );
            }

            if (item.mime_type.startsWith("video/")) {
              return (
                <div
                  key={item.hash}
                  className="my-media-card video"
                  onClick={() => openViewer(localSrc, "video")}
                  title={tooltip}
                >
                  <video src={localSrc} preload="metadata" muted />
                  <div className="my-media-card-play">{"\u25B6"}</div>
                  <div className="my-media-card-overlay">
                    {formatBytes(item.size_bytes)}
                  </div>
                </div>
              );
            }

            if (item.mime_type.startsWith("audio/")) {
              return (
                <div
                  key={item.hash}
                  className="my-media-card audio"
                  title={tooltip}
                >
                  <div className="my-media-audio-icon">{"\uD83C\uDFB5"}</div>
                  <audio src={localSrc} controls preload="metadata" />
                  <div className="my-media-card-overlay">
                    {formatBytes(item.size_bytes)}
                  </div>
                </div>
              );
            }

            return null;
          })}
      </div>
    </div>
  );
};
