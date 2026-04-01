import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  IconCheck, IconBookOpen, IconFeed, IconZap,
  IconMoreVertical, IconCopy, IconShare, IconVolumeX, IconVolume,
  IconExternalLink, IconDatabase, IconMessageCircle, IconTrash,
  IconPenSquare, IconX, IconKey, IconUsers,
} from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { NoteCard } from "../components/NoteCard";
import { ZapModal } from "../components/ZapModal";
import { ArticleCard } from "../components/ArticleCard";
import { EmptyState } from "../components/EmptyState";
import { ImageUploadField } from "../components/ImageUploadField";
import { shortPubkey } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { initMediaViewer } from "../utils/media";
import { invalidateInteractionCounts } from "../hooks/useInteractionCounts";
import { markReacted, markUnreacted } from "../hooks/useReactionStatus";
import { useSigningContext } from "../context/SigningContext";
import { useOnDemandFetch } from "../hooks/useOnDemandFetch";
import { useProfileContext, useProfile } from "../context/ProfileContext";
import { listen } from "@tauri-apps/api/event";
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
  const { canWrite } = useSigningContext();

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
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [isTracked, setIsTracked] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // Three-dots menu
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Zap modal
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<NostrEvent | null>(null);

  // Edit profile
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", about: "", picture: "", banner: "", nip05: "", lud16: "", website: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleLike = useCallback(async (event: NostrEvent) => {
    markReacted(event.id);
    try {
      await invoke("publish_reaction", { eventId: event.id, eventPubkey: event.pubkey });
      invalidateInteractionCounts([event.id]);
    } catch (err) {
      console.warn("[profile] Failed to publish reaction:", err);
    }
  }, []);

  const handleUnlike = useCallback(async (event: NostrEvent) => {
    markUnreacted(event.id);
    try {
      await invoke("publish_unreaction", { eventId: event.id });
      invalidateInteractionCounts([event.id]);
    } catch (err) {
      console.warn("[profile] Failed to publish unreaction:", err);
      markReacted(event.id);
    }
  }, []);

  const handleDelete = useCallback((event: NostrEvent) => {
    setDeleteConfirm(event);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const event = deleteConfirm;
    setDeleteConfirm(null);
    try {
      await invoke("publish_deletion", { eventId: event.id });
      setNotes((prev) => prev.filter((e) => e.id !== event.id));
    } catch (err) {
      console.warn("[profile] Failed to delete event:", err);
    }
  }, [deleteConfirm]);

  const handleStartEdit = useCallback(() => {
    setSaveError(null);
    setEditForm({
      name: profile?.name ?? "",
      about: profile?.about ?? "",
      picture: profile?.picture ?? "",
      banner: profile?.banner ?? "",
      nip05: profile?.nip05 ?? "",
      lud16: profile?.lud16 ?? "",
      website: profile?.website ?? "",
    });
    setEditing(true);
  }, [profile]);

  const handleSaveProfile = useCallback(async () => {
    setSaveError(null);
    setSaving(true);
    try {
      await invoke("publish_metadata", {
        name: editForm.name.trim() || null,
        about: editForm.about.trim() || null,
        picture: editForm.picture.trim() || null,
        nip05: editForm.nip05.trim() || null,
        lud16: editForm.lud16.trim() || null,
        banner: editForm.banner.trim() || null,
        website: editForm.website.trim() || null,
      });
      setEditing(false);
      // Refresh profile
      try { await invoke("get_profile_with_refresh", { pubkey }); } catch (_) {}
    } catch (err) {
      const msg = typeof err === "string" ? err : (err as any)?.message || "Failed to save";
      setSaveError(msg);
      console.warn("[profile] Failed to save profile:", err);
    } finally {
      setSaving(false);
    }
  }, [editForm, pubkey]);

  const handleFollow = useCallback(async () => {
    if (!pubkey || followLoading) return;
    setFollowLoading(true);
    try {
      const ownProfile = await invoke<ProfileInfo | null>("get_own_profile");
      if (!ownProfile) return;
      const currentFollows = await invoke<string[]>("get_follows", { pubkey: ownProfile.pubkey });
      if (!currentFollows.includes(pubkey)) {
        const newFollows = [...currentFollows, pubkey];
        await invoke("publish_contact_list", { follows: newFollows });
        setIsFollowing(true);
      }
    } catch (err) {
      console.warn("[profile] Failed to follow:", err);
    } finally {
      setFollowLoading(false);
    }
  }, [pubkey, followLoading]);

  const handleUnfollow = useCallback(async () => {
    if (!pubkey || followLoading) return;
    setFollowLoading(true);
    try {
      const ownProfile = await invoke<ProfileInfo | null>("get_own_profile");
      if (!ownProfile) return;
      const currentFollows = await invoke<string[]>("get_follows", { pubkey: ownProfile.pubkey });
      const newFollows = currentFollows.filter((pk) => pk !== pubkey);
      await invoke("publish_contact_list", { follows: newFollows });
      setIsFollowing(false);
    } catch (err) {
      console.warn("[profile] Failed to unfollow:", err);
    } finally {
      setFollowLoading(false);
    }
  }, [pubkey, followLoading]);

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
  const { fetchIfStale } = useOnDemandFetch();

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
      setIsOwn(false);
      setMenuOpen(false);

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

        // Check if we follow this profile
        if (ownPubkey && ownPubkey !== pubkey) {
          try {
            const ownFollows = await invoke<string[]>("get_follows", { pubkey: ownPubkey });
            setIsFollowing(ownFollows.includes(pubkey));
          } catch (_) {}
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

      // Trigger background relay fetch for fresh content
      fetchIfStale(`profile:${pubkey}`, () =>
        invoke("fetch_profile_content_from_relays", { pubkey })
      );
    };

    load();
  }, [pubkey, ensureProfiles, fetchIfStale]);

  /* --- load notes --------------------------------------------------- */
  const loadNotes = useCallback(async () => {
    if (!pubkey || notesLoading) return;
    setNotesLoading(true);
    setHasMoreNotes(true);
    try {
      const events = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [1, 6], limit: 50, author: pubkey },
      });
      const sorted = events.sort((a, b) => b.created_at - a.created_at);
      setNotes(sorted);
      const pubkeys = new Set(events.map((e) => e.pubkey));
      for (const e of events) {
        if (e.kind === 6) {
          try { const orig = JSON.parse(e.content); if (orig?.pubkey) pubkeys.add(orig.pubkey); } catch {}
        }
      }
      ensureProfiles([...pubkeys]);
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
        filter: { kinds: [1, 6], limit: 50, author: pubkey, until: oldest - 1 },
      });
      if (events.length === 0) {
        setHasMoreNotes(false);
      } else {
        const sorted = events.sort((a, b) => b.created_at - a.created_at);
        setNotes((prev) => [...prev, ...sorted]);
        const pubkeys = new Set(events.map((e) => e.pubkey));
        for (const e of events) {
          if (e.kind === 6) {
            try { const orig = JSON.parse(e.content); if (orig?.pubkey) pubkeys.add(orig.pubkey); } catch {}
          }
        }
        ensureProfiles([...pubkeys]);
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

  /* --- pick up own notes published from compose ---------------------- */
  useEffect(() => {
    if (!pubkey) return;
    const handler = (e: Event) => {
      const event = (e as CustomEvent).detail as NostrEvent;
      if (event && event.pubkey === pubkey) {
        setNotes((prev) => {
          if (prev.some((n) => n.id === event.id)) return prev;
          return [event, ...prev];
        });
      }
    };
    window.addEventListener("nostrito:note-published", handler);
    return () => window.removeEventListener("nostrito:note-published", handler);
  }, [pubkey]);

  /* --- listen for relay content updates ------------------------------ */
  useEffect(() => {
    if (!pubkey) return;
    const unlisten = listen<string>("profile-content-updated", async (ev) => {
      if (ev.payload !== pubkey) return;
      try {
        const followList = await invoke<string[]>("get_follows", { pubkey });
        setFollows(followList);
        setFollowingCount(followList.length);
      } catch (_) {}
      try {
        const followerList = await invoke<string[]>("get_followers", { pubkey });
        setFollowers(followerList);
        setFollowerCount(followerList.length);
      } catch (_) {}
      // Reload notes to pick up any new content from relays
      loadNotes();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [pubkey, loadNotes]);

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
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for Tauri webview
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }, []);

  const handleCopyNpub = useCallback(async () => {
    if (!pubkey) return;
    try {
      const npub = await invoke<string>("hex_to_npub", { pubkey });
      await copyToClipboard(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[profile] Failed to copy npub:", e);
    }
    setMenuOpen(false);
  }, [pubkey, copyToClipboard]);

  const handleShareNjump = useCallback(async () => {
    if (!pubkey) return;
    try {
      const npub = await invoke<string>("hex_to_npub", { pubkey });
      const url = `https://njump.me/${npub}`;
      await copyToClipboard(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[profile] Failed to share:", e);
    }
    setMenuOpen(false);
  }, [pubkey, copyToClipboard]);

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
              pictureLocal={profile?.picture_local ?? null}
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

                {/* Edit profile button (own) or connect key prompt */}
                {isOwn && canWrite && (
                  <button className="profile-edit-btn" onClick={handleStartEdit} title="edit profile">
                    <span className="icon"><IconPenSquare /></span>
                    edit profile
                  </button>
                )}
                {isOwn && !canWrite && (
                  <button className="profile-edit-btn" onClick={() => navigate("/settings")} title="connect signing key to edit profile">
                    <span className="icon"><IconKey /></span>
                    connect key to edit
                  </button>
                )}

                {/* Follow / Unfollow button */}
                {!isOwn && canWrite && (
                  <button
                    className={`profile-follow-btn${isFollowing ? " following" : ""}`}
                    onClick={isFollowing ? handleUnfollow : handleFollow}
                    disabled={followLoading}
                  >
                    <span className="icon">{isFollowing ? <IconCheck /> : <IconUsers />}</span>
                    {followLoading ? "..." : isFollowing ? "following" : "follow"}
                  </button>
                )}

                {/* Send message button */}
                {!isOwn && (
                  <button
                    className="profile-dm-btn"
                    onClick={() => navigate("/dms", { state: { partner: pubkey } })}
                    title="send message"
                  >
                    <span className="icon"><IconMessageCircle /></span>
                    message
                  </button>
                )}

                {/* Three-dots menu */}
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
                      {!isOwn && (
                        <>
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
                        </>
                      )}
                    </div>
                  )}
                </div>
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
                        onClick={() => { console.log("[profile] navigate to note:", note.id.slice(0, 12)); navigate(`/note/${note.id}`); }}
                        onZap={setZapTarget}
                        onLike={handleLike}
                        onUnlike={handleUnlike}
                        onDelete={isOwn ? handleDelete : undefined}
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
                            onClick={() => navigate(`/note/${article.id}`)}
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
                      pictureLocal={fp?.picture_local ?? null}
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

      {deleteConfirm && (
        <div className="wallet-modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="wallet-modal" onClick={(e) => e.stopPropagation()} style={{ width: 380 }}>
            <div className="wallet-modal-header">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="icon"><IconTrash /></span>
                delete note
              </span>
              <button className="wallet-modal-close" onClick={() => setDeleteConfirm(null)}><IconX /></button>
            </div>
            <div className="wallet-modal-body">
              <p style={{ fontSize: "0.88rem", color: "var(--text-dim)", marginBottom: 12 }}>
                Delete this note? A deletion request will be published to relays. Other relays may not honor the request.
              </p>
              <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", borderLeft: "2px solid var(--border)", paddingLeft: 10, marginBottom: 16, maxHeight: 120, overflow: "hidden" }}>
                {deleteConfirm.content.slice(0, 200)}{deleteConfirm.content.length > 200 ? "\u2026" : ""}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="wallet-setup-connect-btn" style={{ background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)" }} onClick={() => setDeleteConfirm(null)}>cancel</button>
                <button className="wallet-setup-connect-btn" style={{ background: "#dc2626" }} onClick={confirmDelete}>delete</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="wallet-modal-overlay" onClick={() => setEditing(false)}>
          <div className="wallet-modal" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
            <div className="wallet-modal-header">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="icon"><IconPenSquare /></span>
                edit profile
              </span>
              <button className="wallet-modal-close" onClick={() => setEditing(false)}><IconX /></button>
            </div>
            <div className="wallet-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label className="profile-edit-label">
                name
                <input type="text" className="profile-edit-input" value={editForm.name}
                  onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))} />
              </label>
              <label className="profile-edit-label">
                about
                <textarea className="profile-edit-textarea" rows={3} value={editForm.about}
                  onChange={(e) => setEditForm(f => ({ ...f, about: e.target.value }))} />
              </label>
              <ImageUploadField
                label="picture"
                value={editForm.picture}
                onChange={(url) => setEditForm(f => ({ ...f, picture: url }))}
              />
              <ImageUploadField
                label="banner"
                value={editForm.banner}
                onChange={(url) => setEditForm(f => ({ ...f, banner: url }))}
              />
              <label className="profile-edit-label">
                NIP-05 identifier
                <input type="text" className="profile-edit-input" value={editForm.nip05}
                  onChange={(e) => setEditForm(f => ({ ...f, nip05: e.target.value }))}
                  placeholder="name@domain.com" />
              </label>
              <label className="profile-edit-label">
                lightning address
                <input type="text" className="profile-edit-input" value={editForm.lud16}
                  onChange={(e) => setEditForm(f => ({ ...f, lud16: e.target.value }))}
                  placeholder="name@walletprovider.com" />
              </label>
              <label className="profile-edit-label">
                website
                <input type="text" className="profile-edit-input" value={editForm.website}
                  onChange={(e) => setEditForm(f => ({ ...f, website: e.target.value }))}
                  placeholder="https://..." />
              </label>
              {saveError && (
                <div style={{ fontSize: "0.82rem", color: "#e55", padding: "8px 10px", background: "rgba(255,60,60,0.08)", borderRadius: 6 }}>
                  {saveError.includes("signer") || saveError.includes("nsec") || saveError.includes("signing")
                    ? <>no signing method configured — <span style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }} onClick={() => { setEditing(false); navigate("/settings"); }}>go to settings</span> to connect your key</>
                    : saveError
                  }
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button className="wallet-setup-connect-btn" style={{ background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)" }} onClick={() => setEditing(false)}>cancel</button>
                <button className="wallet-setup-connect-btn" onClick={handleSaveProfile} disabled={saving}>
                  {saving ? "saving..." : "save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
