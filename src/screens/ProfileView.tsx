import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  IconCheck, IconBookOpen, IconFeed, IconZap,
  IconMoreVertical, IconCopy, IconShare, IconVolumeX, IconVolume,
  IconExternalLink, IconDatabase,
} from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { NoteCard } from "../components/NoteCard";
import { ZapModal } from "../components/ZapModal";
import { ArticleCard } from "../components/ArticleCard";
import { EmptyState } from "../components/EmptyState";
import { shortPubkey } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { initMediaViewer } from "../utils/media";
import { invalidateInteractionCounts } from "../hooks/useInteractionCounts";
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

type ProfileTab = "notes" | "articles";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TAB_OPTIONS: { key: ProfileTab; label: string }[] = [
  { key: "notes", label: "notes" },
  { key: "articles", label: "articles" },
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
  const [followers, setFollowers] = useState<string[]>([]);
  const [followingCount, setFollowingCount] = useState<number>(0);
  const [followerCount, setFollowerCount] = useState<number>(0);

  // Followers/following popup
  const [listPopup, setListPopup] = useState<"following" | "followers" | null>(null);
  const [listSearch, setListSearch] = useState("");
  const listPopupRef = useRef<HTMLDivElement>(null);

  // Relationship badges
  const [followsMe, setFollowsMe] = useState(false);
  const [isTracked, setIsTracked] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // Three-dots menu
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Zap modal
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);

  const handleLike = useCallback(async (event: NostrEvent) => {
    try {
      await invoke("publish_reaction", { eventId: event.id, eventPubkey: event.pubkey });
      invalidateInteractionCounts([event.id]);
    } catch (err) {
      console.warn("[profile] Failed to publish reaction:", err);
    }
  }, []);

  // Tab data
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [articles, setArticles] = useState<NostrEvent[]>([]);
  const [hasMoreNotes, setHasMoreNotes] = useState(true);
  const [loadingMoreNotes, setLoadingMoreNotes] = useState(false);
  const notesSentinelRef = useRef<HTMLDivElement>(null);

  // Loading states
  const [profileLoading, setProfileLoading] = useState(true);
  const [notesLoading, setNotesLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);

  /* --- profile context for batch operations ------------------------- */
  const { ensureProfiles, getProfile } = useProfileContext();

  /* --- init media viewer -------------------------------------------- */
  useEffect(() => {
    if (activeTab === "notes") {
      initMediaViewer();
    }
  }, [activeTab]);

  /* --- close menu on outside click ---------------------------------- */
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [menuOpen]);

  /* --- close list popup on outside click / Escape ------------------- */
  useEffect(() => {
    if (!listPopup) return;
    const handleClick = (e: MouseEvent) => {
      if (listPopupRef.current && !listPopupRef.current.contains(e.target as Node)) {
        setListPopup(null);
        setListSearch("");
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setListPopup(null);
        setListSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [listPopup]);

  /* --- profile loading ---------------------------------------------- */
  useEffect(() => {
    if (!pubkey) return;

    let ownPubkey: string | null = null;

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
        if (ownProfile) {
          ownPubkey = ownProfile.pubkey;
          if (ownProfile.pubkey === pubkey) {
            setIsOwn(true);
          }
        }
      } catch (_) {
        // Not critical
      }

      // Load follows
      try {
        const followList = await invoke<string[]>("get_follows", { pubkey });
        setFollows(followList);
        setFollowingCount(followList.length);

        // Check if this profile follows us
        if (ownPubkey && ownPubkey !== pubkey) {
          setFollowsMe(followList.includes(ownPubkey));
        }

        // Batch-load follow profiles via context
        if (followList.length > 0) {
          ensureProfiles(followList.slice(0, 200));
        }
      } catch (_) {
        // Not critical
      }

      // Load followers
      try {
        const followerList = await invoke<string[]>("get_followers", { pubkey });
        setFollowers(followerList);
        setFollowerCount(followerList.length);

        // Batch-load follower profiles via context
        if (followerList.length > 0) {
          ensureProfiles(followerList.slice(0, 200));
        }
      } catch (_) {
        // Not critical
      }

      // Check tracked status
      try {
        const tracked = await invoke<boolean>("is_tracked_profile", { pubkey });
        setIsTracked(tracked);
      } catch (_) {
        // Not critical
      }

      // Check muted status
      try {
        const muted = await invoke<boolean>("is_pubkey_muted_cmd", { pubkey });
        setIsMuted(muted);
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
    setHasMoreNotes(true);
    try {
      const events = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [1], limit: 50, author: pubkey },
      });
      const sorted = events.sort((a, b) => b.created_at - a.created_at);
      setNotes(sorted);
      ensureProfiles(events.map((e) => e.pubkey));
      if (events.length < 50) setHasMoreNotes(false);
    } catch (e) {
      console.error("[profile] Failed to load notes:", e);
    } finally {
      setNotesLoading(false);
    }
  }, [pubkey, ensureProfiles]);

  /* --- load more notes (pagination) -------------------------------- */
  const loadMoreNotes = useCallback(async () => {
    if (!pubkey || loadingMoreNotes || !hasMoreNotes || notes.length === 0) return;
    setLoadingMoreNotes(true);
    try {
      const oldest = notes[notes.length - 1].created_at;
      const events = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [1], limit: 50, author: pubkey, until: oldest - 1 },
      });
      if (events.length === 0) {
        setHasMoreNotes(false);
      } else {
        const sorted = events.sort((a, b) => b.created_at - a.created_at);
        setNotes((prev) => [...prev, ...sorted]);
        ensureProfiles(events.map((e) => e.pubkey));
        if (events.length < 50) setHasMoreNotes(false);
      }
    } catch (e) {
      console.error("[profile] Failed to load more notes:", e);
    } finally {
      setLoadingMoreNotes(false);
    }
  }, [pubkey, notes, loadingMoreNotes, hasMoreNotes, ensureProfiles]);

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

  /* --- load tab content on tab change ------------------------------- */
  useEffect(() => {
    switch (activeTab) {
      case "notes":
        if (notes.length === 0) loadNotes();
        break;
      case "articles":
        if (articles.length === 0) loadArticles();
        break;
    }
  }, [activeTab, loadNotes, loadArticles]);

  /* --- initial notes load ------------------------------------------- */
  useEffect(() => {
    if (pubkey && !profileLoading) {
      loadNotes();
    }
  }, [pubkey, profileLoading]);

  /* --- IntersectionObserver for notes pagination -------------------- */
  useEffect(() => {
    if (!notesSentinelRef.current || !hasMoreNotes || activeTab !== "notes") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreNotes();
      },
      { threshold: 0.1 },
    );
    observer.observe(notesSentinelRef.current);
    return () => observer.disconnect();
  }, [loadMoreNotes, hasMoreNotes, activeTab]);

  /* --- menu actions ------------------------------------------------- */
  const handleCopyNpub = useCallback(async () => {
    if (!pubkey) return;
    try {
      const npub = await invoke<string>("hex_to_npub", { pubkey });
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[profile] Failed to copy npub:", e);
    }
  }, [pubkey]);

  const handleShareNjump = useCallback(async () => {
    if (!pubkey) return;
    try {
      const npub = await invoke<string>("hex_to_npub", { pubkey });
      const url = `https://njump.me/${npub}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[profile] Failed to share:", e);
    }
    setMenuOpen(false);
  }, [pubkey]);

  const handleToggleMute = useCallback(async () => {
    if (!pubkey) return;
    try {
      if (isMuted) {
        await invoke("unmute_pubkey", { pubkey });
        setIsMuted(false);
      } else {
        await invoke("mute_pubkey", { pubkey });
        setIsMuted(true);
      }
    } catch (e) {
      console.error("[profile] Failed to toggle mute:", e);
    }
    setMenuOpen(false);
  }, [pubkey, isMuted]);

  const handleToggleTrack = useCallback(async () => {
    if (!pubkey) return;
    try {
      if (isTracked) {
        await invoke("untrack_profile", { pubkey });
        setIsTracked(false);
      } else {
        await invoke("track_profile", { pubkey, note: null });
        setIsTracked(true);
      }
    } catch (e) {
      console.error("[profile] Failed to toggle track:", e);
    }
    setMenuOpen(false);
  }, [pubkey, isTracked]);

  /* --- popup list filtering ----------------------------------------- */
  const filteredListItems = useMemo(() => {
    const source = listPopup === "following" ? follows : listPopup === "followers" ? followers : [];
    if (!listSearch.trim()) return source;
    const q = listSearch.toLowerCase();
    return source.filter((pk) => {
      const fp = getProfile(pk);
      const name = fp ? (fp.name || fp.display_name || "") : "";
      const nip05 = fp?.nip05 || "";
      return name.toLowerCase().includes(q) || nip05.toLowerCase().includes(q) || pk.toLowerCase().includes(q);
    });
  }, [listPopup, follows, followers, getProfile, listSearch]);

  /* --- derived values ----------------------------------------------- */
  const displayName = useMemo(() => {
    return profile ? profileDisplayName(profile, pubkey || "") : shortPubkey(pubkey || "");
  }, [profile, pubkey]);

  const truncatedPubkey = useMemo(() => shortPubkey(pubkey || ""), [pubkey]);

  /* --- helper: make website URL clickable --------------------------- */
  const websiteHref = useMemo(() => {
    if (!profile?.website) return null;
    const w = profile.website.trim();
    if (w.startsWith("http://") || w.startsWith("https://")) return w;
    return `https://${w}`;
  }, [profile?.website]);

  /* --- early return if no pubkey ------------------------------------ */
  if (!pubkey) {
    return (
      <div className="screen-page">
        <EmptyState message="no profile pubkey specified." />
      </div>
    );
  }

  /* ================================================================== */
  /*  RENDER                                                            */
  /* ================================================================== */

  return (
    <div className="screen-page profile-page">
      {/* Back button */}
      <div className="profile-back-row">
        <button className="btn btn-secondary profile-back-btn" onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          back
        </button>
      </div>

      {profileLoading ? (
        <div style={{ color: "var(--text-muted)", padding: 24 }}>loading profile...</div>
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
              <div className="profile-hero-name-row">
                <div className="profile-hero-name">{displayName}</div>

                {/* Badges */}
                <div className="profile-badges">
                  {followsMe && (
                    <span className="profile-badge profile-badge-follows">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                      follows you
                    </span>
                  )}
                  {isTracked && (
                    <span className="profile-badge profile-badge-tracked">
                      <span className="icon" style={{ width: 12, height: 12 }}><IconDatabase /></span>
                      tracked
                    </span>
                  )}
                  {isMuted && (
                    <span className="profile-badge profile-badge-muted">
                      <span className="icon" style={{ width: 12, height: 12 }}><IconVolumeX /></span>
                      muted
                    </span>
                  )}
                </div>

                {/* Three-dots menu */}
                {!isOwn && (
                  <div className="profile-menu-container" ref={menuRef}>
                    <button
                      className="profile-menu-btn"
                      onClick={() => setMenuOpen(!menuOpen)}
                      title="profile actions"
                    >
                      <IconMoreVertical />
                    </button>

                    {menuOpen && (
                      <div className="profile-menu-dropdown">
                        <button className="profile-menu-item" onClick={handleCopyNpub}>
                          <span className="icon"><IconCopy /></span>
                          {copied ? "copied!" : "copy npub"}
                        </button>
                        <button className="profile-menu-item" onClick={handleShareNjump}>
                          <span className="icon"><IconShare /></span>
                          share via njump.me
                        </button>
                        <div className="profile-menu-divider" />
                        <button className="profile-menu-item" onClick={handleToggleTrack}>
                          <span className="icon"><IconDatabase /></span>
                          {isTracked ? "untrack profile" : "track profile"}
                        </button>
                        <button
                          className={`profile-menu-item${isMuted ? " profile-menu-item-danger" : ""}`}
                          onClick={handleToggleMute}
                        >
                          <span className="icon">{isMuted ? <IconVolume /> : <IconVolumeX />}</span>
                          {isMuted ? "unmute user" : "mute user"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="profile-hero-npub">{truncatedPubkey}</div>
              {profile?.nip05 && (
                <div className="profile-hero-nip05">
                  <span className="icon"><IconCheck /></span> {profile.nip05}
                </div>
              )}
              <div className="profile-hero-stats">
                <span className="profile-stat profile-stat-clickable" onClick={() => { setListPopup("following"); setListSearch(""); }}>
                  <strong>{followingCount}</strong> following
                </span>
                <span className="profile-stat profile-stat-clickable" onClick={() => { setListPopup("followers"); setListSearch(""); }}>
                  <strong>{followerCount}</strong> followers
                </span>
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
                  <a
                    className="profile-meta-item profile-meta-link"
                    href={websiteHref ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="icon"><IconExternalLink /></span>
                    {profile.website}
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Tabbed content */}
          <div className="profile-body">
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
                      <div style={{ color: "var(--text-muted)", padding: 16 }}>loading notes...</div>
                    )}
                    {!notesLoading && notes.length === 0 && (
                      <EmptyState
                        icon={<span className="icon"><IconFeed /></span>}
                        message="no notes found for this profile."
                      />
                    )}
                    {notes.map((note) => (
                      <NoteCard
                        key={note.id}
                        event={note}
                        profile={getProfile(note.pubkey) ?? profile ?? undefined}
                        compact
                        onClick={() => navigate(`/note/${note.id}`)}
                        onZap={setZapTarget}
                        onLike={handleLike}
                      />
                    ))}
                    {hasMoreNotes && notes.length > 0 && (
                      <div ref={notesSentinelRef} style={{ padding: 16, color: "var(--text-muted)" }}>
                        {loadingMoreNotes ? "loading more notes..." : ""}
                      </div>
                    )}
                  </div>
                )}

                {/* --- Articles tab --- */}
                {activeTab === "articles" && (
                  <div className="profile-articles">
                    {articlesLoading && articles.length === 0 && (
                      <div style={{ color: "var(--text-muted)", padding: 16 }}>loading articles...</div>
                    )}
                    {!articlesLoading && articles.length === 0 && (
                      <EmptyState
                        icon={<span className="icon"><IconBookOpen /></span>}
                        message="no articles found for this profile."
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

              </div>
            </div>

          </div>
        </>
      )}

      {/* Followers / Following popup */}
      {listPopup && (
        <div className="profile-list-overlay">
          <div className="profile-list-popup" ref={listPopupRef}>
            <div className="profile-list-header">
              <h3>{listPopup === "following" ? "following" : "followers"}</h3>
              <button
                className="profile-list-close"
                onClick={() => { setListPopup(null); setListSearch(""); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
            <div className="profile-list-search">
              <input
                type="text"
                placeholder="search by name, nip05, pubkey..."
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="profile-list-items">
              {filteredListItems.length === 0 && (
                <div className="profile-list-empty">
                  {listSearch.trim() ? "no matches found" : listPopup === "following" ? "not following anyone" : "no followers found"}
                </div>
              )}
              {filteredListItems.map((pk) => {
                const fp = getProfile(pk);
                return (
                  <div
                    key={pk}
                    className="profile-list-item"
                    onClick={() => { setListPopup(null); setListSearch(""); navigate(`/profile/${pk}`); }}
                  >
                    <Avatar
                      picture={fp?.picture ?? null}
                      pubkey={pk}
                      className="profile-follow-avatar"
                      fallbackClassName="profile-follow-avatar-fallback"
                    />
                    <div className="profile-follow-info">
                      <div className="profile-follow-name">{profileDisplayName(fp, pk)}</div>
                      <div className="profile-follow-npub">
                        {fp?.nip05 ? fp.nip05 : shortPubkey(pk)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {zapTarget && (
        <ZapModal
          eventId={zapTarget.id}
          recipientPubkey={zapTarget.pubkey}
          recipientLud16={getProfile(zapTarget.pubkey)?.lud16 ?? profile?.lud16 ?? null}
          onClose={() => setZapTarget(null)}
        />
      )}
    </div>
  );
};
