import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { IconCheck, IconImage, IconBookOpen, IconFeed, IconZap } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { NoteCard } from "../components/NoteCard";
import { ArticleCard } from "../components/ArticleCard";
import { EmptyState } from "../components/EmptyState";
import { formatBytes, shortPubkey } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { initMediaViewer } from "../utils/media";
import { useProfileContext, useProfile } from "../context/ProfileContext";
import type { ProfileInfo } from "../utils/profiles";

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

  /* --- profile from context ----------------------------------------- */
  const profile = useProfile(pubkey);

  /* --- state -------------------------------------------------------- */
  const [isOwn, setIsOwn] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>("notes");
  const [follows, setFollows] = useState<string[]>([]);
  const [followSearch, setFollowSearch] = useState("");
  const [followingCount, setFollowingCount] = useState<number>(0);

  // Tab data
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [articles, setArticles] = useState<NostrEvent[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);

  // Loading states
  const [profileLoading, setProfileLoading] = useState(true);
  const [notesLoading, setNotesLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);

  /* --- profile context for batch operations ------------------------- */
  const { ensureProfiles, getProfile } = useProfileContext();

  /* --- init media viewer -------------------------------------------- */
  useEffect(() => {
    if (activeTab === "media" || activeTab === "notes") {
      initMediaViewer();
    }
  }, [activeTab]);

  /* --- profile loading ---------------------------------------------- */
  useEffect(() => {
    if (!pubkey) return;

    const load = async () => {
      setProfileLoading(true);

      // Trigger refresh if stale
      try {
        await invoke<ProfileInfo | null>("get_profile_with_refresh", { pubkey });
      } catch (_) {
        // Profile not available
      }

      // Check if this is the own profile
      try {
        const ownProfile = await invoke<ProfileInfo | null>("get_own_profile");
        if (ownProfile && ownProfile.pubkey === pubkey) {
          setIsOwn(true);
        }
      } catch (_) {
        // Not critical
      }

      // Load follows
      try {
        const followList = await invoke<string[]>("get_follows", { pubkey });
        setFollows(followList);
        setFollowingCount(followList.length);

        // Batch-load follow profiles via context
        if (followList.length > 0) {
          ensureProfiles(followList.slice(0, 200));
        }
      } catch (_) {
        // Not critical
      }

      setProfileLoading(false);
    };

    load();
  }, [pubkey, ensureProfiles]);

  /* --- load notes --------------------------------------------------- */
  const loadNotes = useCallback(async () => {
    if (!pubkey || notesLoading) return;
    setNotesLoading(true);
    try {
      const events = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [1], limit: 50, author: pubkey },
      });
      setNotes(events.sort((a, b) => b.created_at - a.created_at));
      // Ensure profiles for note authors (mostly same pubkey but reposts may differ)
      ensureProfiles(events.map((e) => e.pubkey));
    } catch (e) {
      console.error("[profile] Failed to load notes:", e);
    } finally {
      setNotesLoading(false);
    }
  }, [pubkey, ensureProfiles]);

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

  /* --- follows filtering -------------------------------------------- */
  const filteredFollows = useMemo(() => {
    if (!followSearch.trim()) return follows;
    const q = followSearch.toLowerCase();
    return follows.filter((pk) => {
      const fp = getProfile(pk);
      const name = fp ? (fp.name || fp.display_name || "") : "";
      return name.toLowerCase().includes(q) || pk.toLowerCase().includes(q);
    });
  }, [follows, getProfile, followSearch]);

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
      {/* Back button */}
      <div className="profile-back-row">
        <button className="btn btn-secondary profile-back-btn" onClick={() => navigate(-1)}>
          ← Back
        </button>
      </div>

      {profileLoading ? (
        <div style={{ color: "var(--text-muted)", padding: 24 }}>Loading profile...</div>
      ) : (
        <>
          {/* Banner */}
          <div
            className="profile-banner"
            style={profile?.banner ? { backgroundImage: `url(${profile.banner})` } : undefined}
          >
            <div className="profile-banner-overlay" />
          </div>

          {/* Hero info */}
          <div className="profile-hero-info">
            <Avatar
              picture={profile?.picture ?? null}
              pubkey={pubkey}
              className="profile-hero-avatar"
              fallbackClassName="profile-hero-avatar-fallback"
            />
            <div className="profile-hero-details">
              <div className="profile-hero-name">{displayName}</div>
              <div className="profile-hero-npub">{truncatedPubkey}</div>
              {profile?.nip05 && (
                <div className="profile-hero-nip05">
                  <span className="icon"><IconCheck /></span> {profile.nip05}
                </div>
              )}
              <div className="profile-hero-stats">
                <span className="profile-stat"><strong>{followingCount}</strong> Following</span>
              </div>
            </div>
          </div>

          {/* Bio + metadata */}
          {(profile?.about || profile?.lud16 || profile?.website) && (
            <div className="profile-bio-section">
              {profile?.about && <p className="profile-bio-text">{profile.about}</p>}
              <div className="profile-meta-row">
                {profile?.lud16 && (
                  <span className="profile-meta-item">
                    <span className="icon"><IconZap /></span> {profile.lud16}
                  </span>
                )}
                {profile?.website && (
                  <span className="profile-meta-item">
                    <span className="icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                    </span> {profile.website}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Split: content + sidebar */}
          <div className="profile-body">
            {/* Left: tabbed content */}
            <div className="profile-content">
              {/* Tab bar */}
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

              {/* Tab content */}
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
                    {notes.map((note) => (
                      <NoteCard
                        key={note.id}
                        event={note}
                        profile={getProfile(note.pubkey) ?? profile ?? undefined}
                        compact
                      />
                    ))}
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
                    {articles.length > 0 && (
                      <div className="article-cards-grid">
                        {articles.map((article) => (
                          <ArticleCard
                            key={article.id}
                            event={article}
                            profile={getProfile(article.pubkey) ?? profile ?? undefined}
                          />
                        ))}
                      </div>
                    )}
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

            {/* Right: follows sidebar */}
            <div className="profile-follows-sidebar">
              <div className="profile-follows-search">
                <input
                  type="text"
                  placeholder="Search follows..."
                  value={followSearch}
                  onChange={(e) => setFollowSearch(e.target.value)}
                />
              </div>
              <div className="profile-follows-list">
                {filteredFollows.slice(0, 50).map((pk) => {
                  const fp = getProfile(pk);
                  return (
                    <div
                      key={pk}
                      className="profile-follow-item"
                      onClick={() => navigate(`/profile/${pk}`)}
                    >
                      <Avatar
                        picture={fp?.picture ?? null}
                        pubkey={pk}
                        className="profile-follow-avatar"
                        fallbackClassName="profile-follow-avatar-fallback"
                      />
                      <div className="profile-follow-info">
                        <div className="profile-follow-name">{profileDisplayName(fp, pk)}</div>
                        <div className="profile-follow-npub">{shortPubkey(pk)}</div>
                      </div>
                    </div>
                  );
                })}
                {filteredFollows.length > 50 && (
                  <div className="profile-follows-more">+ {filteredFollows.length - 50} more</div>
                )}
                {follows.length === 0 && !profileLoading && (
                  <div className="profile-follows-more">No follows found</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
