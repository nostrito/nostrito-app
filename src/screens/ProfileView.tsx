import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { IconCheck, IconImage, IconBookOpen, IconFeed } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { formatBytes, shortPubkey, formatDate } from "../utils/format";
import { getProfiles, profileDisplayName, invalidateProfileCache, type ProfileInfo } from "../utils/profiles";
import { initMediaViewer } from "../utils/media";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface MediaItem {
  hash: string;
  url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  downloaded_at: number;
}

interface CacheStatus {
  cached: boolean;
  stale: boolean;
  last_fetched: number | null;
}

type ProfileTab = "notes" | "articles" | "media";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TAB_OPTIONS: { key: ProfileTab; label: string }[] = [
  { key: "notes", label: "Notes" },
  { key: "articles", label: "Articles" },
  { key: "media", label: "Media" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const ProfileView: React.FC = () => {
  const { pubkey } = useParams<{ pubkey: string }>();
  const navigate = useNavigate();

  /* --- state -------------------------------------------------------- */
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [isOwn, setIsOwn] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>("notes");
  const [showFetchButton, setShowFetchButton] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchMessage, setFetchMessage] = useState<{ type: "success" | "error" | "empty"; text: string } | null>(null);

  // Tab data
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [articles, setArticles] = useState<NostrEvent[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);

  // Loading states
  const [profileLoading, setProfileLoading] = useState(true);
  const [notesLoading, setNotesLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);

  /* --- init media viewer -------------------------------------------- */
  useEffect(() => {
    if (activeTab === "media") {
      initMediaViewer();
    }
  }, [activeTab]);

  /* --- profile loading ---------------------------------------------- */
  useEffect(() => {
    if (!pubkey) return;

    const loadProfile = async () => {
      setProfileLoading(true);

      // Check if this is the own profile
      try {
        const ownProfile = await invoke<ProfileInfo | null>("get_own_profile");
        if (ownProfile && ownProfile.pubkey === pubkey) {
          setIsOwn(true);
        }
      } catch (_) {
        // Not critical
      }

      // Fetch profile
      try {
        const profiles = await getProfiles([pubkey]);
        const p = profiles.get(pubkey) ?? null;
        setProfile(p);
      } catch (_) {
        // Profile not available
      }

      // Check cache status to decide if fetch button is needed
      try {
        const cacheStatus = await invoke<CacheStatus>("get_profile_cache_status", { pubkey });
        if (!cacheStatus.cached || cacheStatus.stale) {
          setShowFetchButton(true);
        }
      } catch (_) {
        // If cache status check fails, show fetch button as fallback
        setShowFetchButton(true);
      }

      setProfileLoading(false);
    };

    loadProfile();
  }, [pubkey]);

  /* --- load notes --------------------------------------------------- */
  const loadNotes = useCallback(async () => {
    if (!pubkey || notesLoading) return;
    setNotesLoading(true);
    try {
      const events = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [1], limit: 50, author: pubkey },
      });
      setNotes(events.sort((a, b) => b.created_at - a.created_at));
    } catch (e) {
      console.error("[profile] Failed to load notes:", e);
    } finally {
      setNotesLoading(false);
    }
  }, [pubkey]);

  /* --- load articles ------------------------------------------------ */
  const loadArticles = useCallback(async () => {
    if (!pubkey || articlesLoading) return;
    setArticlesLoading(true);
    try {
      const events = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [30023], limit: 20, author: pubkey },
      });
      setArticles(events.sort((a, b) => b.created_at - a.created_at));
    } catch (e) {
      console.error("[profile] Failed to load articles:", e);
    } finally {
      setArticlesLoading(false);
    }
  }, [pubkey]);

  /* --- load media --------------------------------------------------- */
  const loadMedia = useCallback(async () => {
    if (!pubkey || mediaLoading) return;
    setMediaLoading(true);
    try {
      let items: MediaItem[];
      if (isOwn) {
        items = await invoke<MediaItem[]>("get_own_media");
      } else {
        items = await invoke<MediaItem[]>("get_profile_media", { pubkey });
      }
      setMedia(items);
    } catch (e) {
      console.error("[profile] Failed to load media:", e);
    } finally {
      setMediaLoading(false);
    }
  }, [pubkey, isOwn]);

  /* --- load tab content on tab change ------------------------------- */
  useEffect(() => {
    switch (activeTab) {
      case "notes":
        if (notes.length === 0) loadNotes();
        break;
      case "articles":
        if (articles.length === 0) loadArticles();
        break;
      case "media":
        if (media.length === 0) loadMedia();
        break;
    }
  }, [activeTab, loadNotes, loadArticles, loadMedia]);

  /* --- initial notes load ------------------------------------------- */
  useEffect(() => {
    if (pubkey && !profileLoading) {
      loadNotes();
    }
  }, [pubkey, profileLoading]);

  /* --- fetch profile from relays ------------------------------------ */
  const handleFetchProfile = useCallback(async () => {
    if (!pubkey || fetching) return;
    setFetching(true);
    setFetchMessage(null);

    try {
      await invoke("fetch_profile", { pubkey });

      // Invalidate cache and re-fetch profile
      invalidateProfileCache(pubkey);
      const profiles = await getProfiles([pubkey]);
      const updated = profiles.get(pubkey) ?? null;

      if (updated && (updated.name || updated.display_name)) {
        setProfile(updated);
        setFetchMessage({ type: "success", text: "Profile fetched successfully." });
        setShowFetchButton(false);
      } else {
        setFetchMessage({ type: "empty", text: "Profile fetched, but no display data found." });
      }

      // Re-check cache status
      try {
        const cacheStatus = await invoke<CacheStatus>("get_profile_cache_status", { pubkey });
        if (cacheStatus.cached && !cacheStatus.stale) {
          setShowFetchButton(false);
        }
      } catch (_) {
        // Not critical
      }

      // Reload active tab data
      switch (activeTab) {
        case "notes": loadNotes(); break;
        case "articles": loadArticles(); break;
        case "media": loadMedia(); break;
      }
    } catch (e) {
      console.error("[profile] Failed to fetch profile:", e);
      setFetchMessage({ type: "error", text: `Failed to fetch profile: ${e}` });
    } finally {
      setFetching(false);
    }
  }, [pubkey, fetching, activeTab, loadNotes, loadArticles, loadMedia]);

  /* --- media viewer opener ------------------------------------------ */
  const openViewer = useCallback((url: string) => {
    if (typeof (window as any).openMediaViewer === "function") {
      (window as any).openMediaViewer(url);
    }
  }, []);

  const handleImageError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const card = e.currentTarget.parentElement;
      if (card) card.classList.add("broken");
    },
    [],
  );

  /* --- derived values ----------------------------------------------- */
  const displayName = useMemo(() => {
    return profile ? profileDisplayName(profile, pubkey || "") : shortPubkey(pubkey || "");
  }, [profile, pubkey]);

  const truncatedPubkey = useMemo(() => shortPubkey(pubkey || ""), [pubkey]);

  /* --- early return if no pubkey ------------------------------------ */
  if (!pubkey) {
    return (
      <div className="main-content">
        <EmptyState message="No profile pubkey specified." />
      </div>
    );
  }

  /* ================================================================== */
  /*  RENDER                                                            */
  /* ================================================================== */

  return (
    <div className="main-content">
      {/* ---- Back button ---- */}
      <div className="profile-back-row">
        <button className="btn btn-secondary profile-back-btn" onClick={() => navigate(-1)}>
          ← Back
        </button>
      </div>

      {/* ---- Profile header ---- */}
      {profileLoading ? (
        <div className="profile-header">
          <div style={{ color: "var(--text-muted)", padding: 24 }}>Loading profile...</div>
        </div>
      ) : (
        <div className="profile-header">
          <Avatar
            picture={profile?.picture ?? null}
            pubkey={pubkey}
            className="profile-avatar"
            fallbackClassName="profile-avatar-fallback"
          />
          <div className="profile-header-info">
            <div className="profile-name">{displayName}</div>
            <div className="profile-npub">{truncatedPubkey}</div>
            {profile?.nip05 && (
              <div className="profile-nip05">
                <span className="icon"><IconCheck /></span> {profile.nip05}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- About section ---- */}
      {profile?.about && (
        <div className="profile-about">
          <p>{profile.about}</p>
        </div>
      )}

      {/* ---- Fetch banner ---- */}
      {showFetchButton && !isOwn && (
        <div className="profile-fetch-banner">
          <span className="profile-fetch-text">
            This profile may have limited data. Fetch the latest from relays?
          </span>
          <button
            className={`btn btn-primary profile-fetch-btn${fetching ? " disabled" : ""}`}
            disabled={fetching}
            onClick={handleFetchProfile}
          >
            {fetching ? "Fetching..." : "Fetch profile"}
          </button>
        </div>
      )}

      {/* ---- Fetch message ---- */}
      {fetchMessage && (
        <div className={`profile-fetch-message profile-fetch-${fetchMessage.type}`}>
          {fetchMessage.text}
        </div>
      )}

      {/* ---- Tab bar ---- */}
      <div className="profile-tabs">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.key}
            className={`profile-tab${activeTab === tab.key ? " active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Tab content ---- */}
      <div className="profile-tab-content">
        {/* --- Notes tab --- */}
        {activeTab === "notes" && (
          <div className="profile-notes">
            {notesLoading && notes.length === 0 && (
              <div style={{ color: "var(--text-muted)", padding: 16 }}>Loading notes...</div>
            )}
            {!notesLoading && notes.length === 0 && (
              <EmptyState
                icon={<span className="icon"><IconFeed /></span>}
                message="No notes found for this profile."
              />
            )}
            {notes.map((note) => {
              const preview = note.content.length > 300
                ? note.content.slice(0, 300) + "..."
                : note.content;
              const date = formatDate(note.created_at);

              return (
                <div key={note.id} className="profile-note-card">
                  <div className="profile-note-date">{date}</div>
                  <div className="profile-note-content">{preview}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* --- Articles tab --- */}
        {activeTab === "articles" && (
          <div className="profile-articles">
            {articlesLoading && articles.length === 0 && (
              <div style={{ color: "var(--text-muted)", padding: 16 }}>Loading articles...</div>
            )}
            {!articlesLoading && articles.length === 0 && (
              <EmptyState
                icon={<span className="icon"><IconBookOpen /></span>}
                message="No articles found for this profile."
              />
            )}
            {articles.map((article) => {
              const titleTag = article.tags.find((t) => t[0] === "title");
              const summaryTag = article.tags.find((t) => t[0] === "summary");
              const title = titleTag ? titleTag[1] : "Untitled";
              const summary = summaryTag
                ? summaryTag[1]
                : article.content.slice(0, 200) + (article.content.length > 200 ? "..." : "");
              const date = formatDate(article.created_at);

              return (
                <div key={article.id} className="profile-article-card">
                  <div className="profile-article-title">{title}</div>
                  <div className="profile-article-date">{date}</div>
                  <div className="profile-article-summary">{summary}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* --- Media tab --- */}
        {activeTab === "media" && (
          <div className="profile-media">
            {mediaLoading && media.length === 0 && (
              <div style={{ color: "var(--text-muted)", padding: 16 }}>Loading media...</div>
            )}
            {!mediaLoading && media.length === 0 && (
              <EmptyState
                icon={<span className="icon"><IconImage /></span>}
                message="No media found for this profile."
              />
            )}
            <div className="profile-media-grid">
              {media.map((item) => {
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
                      onClick={() => openViewer(localSrc)}
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
        )}
      </div>
    </div>
  );
};
