/** Feed -- event feed view. All data from get_feed backend command. */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconX } from "../components/Icon";
import { NoteCard } from "../components/NoteCard";
import { ArticleCard, getArticleTitle, getArticleImage, getArticleTimestamp } from "../components/ArticleCard";
import { Avatar } from "../components/Avatar";
import { formatDate } from "../utils/format";
import { renderMarkdown } from "../utils/markdown";
import { initMediaViewer } from "../utils/media";
import { useProfileContext } from "../context/ProfileContext";
import { profileDisplayName } from "../utils/profiles";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useInterval } from "../hooks/useInterval";
import type { NostrEvent } from "../types/nostr";

/** Kinds that belong in the feed */
const FEED_KINDS = [1, 6, 30023];

/** Resolve NIP-05 identifier (name@domain) to hex pubkey */
async function resolveNip05(nip05: string): Promise<string | null> {
  const parts = nip05.split("@");
  if (parts.length !== 2) return null;
  const [name, domain] = parts;
  try {
    const resp = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const pubkey = data?.names?.[name];
    return typeof pubkey === "string" ? pubkey : null;
  } catch {
    return null;
  }
}

function isNip05(input: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input);
}

// -- Article reader (inline, uses shared helpers) --

interface ArticleReaderProps {
  event: NostrEvent;
  onBack: () => void;
}

const ArticleReader: React.FC<ArticleReaderProps> = ({ event, onBack }) => {
  const { getProfile, ensureProfiles } = useProfileContext();
  useEffect(() => { ensureProfiles([event.pubkey]); }, [event.pubkey, ensureProfiles]);
  const profile = getProfile(event.pubkey);

  const title = getArticleTitle(event);
  const ts = getArticleTimestamp(event);
  const displayName = profileDisplayName(profile, event.pubkey);
  const image = getArticleImage(event);
  const renderedContent = renderMarkdown(event.content);

  return (
    <div className="article-reader">
      <div className="reader-header">
        <button className="reader-back-btn" onClick={onBack}>
          &#x2190; Back to feed
        </button>
      </div>
      <article className="reader-article">
        {image && (
          <div className="reader-cover">
            <img src={image} alt="" loading="lazy" />
          </div>
        )}
        <h1 className="reader-title">{title}</h1>
        <div className="reader-meta">
          <div className="reader-author">
            <Avatar
              picture={profile?.picture}
              pubkey={event.pubkey}
              className="reader-author-avatar"
              fallbackClassName="reader-author-avatar reader-author-avatar-fallback"
            />
            <span className="reader-author-name">{displayName}</span>
          </div>
          <span className="reader-date">{formatDate(ts)}</span>
        </div>
        <div className="reader-content" dangerouslySetInnerHTML={{ __html: renderedContent }} />
      </article>
    </div>
  );
};

// -- Main Feed component --

type FeedView =
  | { kind: "feed" }
  | { kind: "article"; event: NostrEvent };

type FilterTab = "all" | "note" | "long-form" | "repost";
type FeedMode = "wot" | "global";

function kindTag(kind: number): FilterTab {
  if (kind === 1) return "note";
  if (kind === 6) return "repost";
  if (kind === 30023) return "long-form";
  return "note";
}

export const Feed: React.FC = () => {
  const [view, setView] = useState<FeedView>({ kind: "feed" });
  const [feedMode, setFeedMode] = useState<FeedMode>("wot");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [feedEvents, setFeedEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [globalConsent, setGlobalConsent] = useState(false);
  const [savedEventIds, setSavedEventIds] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMoreArticles, setLoadingMoreArticles] = useState(false);
  const [hasMoreArticles, setHasMoreArticles] = useState(true);

  const { getProfile, ensureProfiles } = useProfileContext();

  const renderedEventIdsRef = useRef(new Set<string>());
  const feedLoadingRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oldestNoteTimestamp = useRef<number | null>(null);
  const oldestArticleTimestamp = useRef<number | null>(null);
  const articleLoadingRef = useRef(false);

  // Listen for sync tier completion to trigger refresh
  const tierEvent = useTauriEvent<{ tier: number }>("sync:tier_complete");

  // Init media viewer on mount
  useEffect(() => {
    initMediaViewer();
  }, []);

  const saveEvent = useCallback(async (event: NostrEvent) => {
    try {
      await invoke("save_event", { event });
      setSavedEventIds((prev) => new Set(prev).add(event.id));
    } catch (err) {
      console.warn("[feed] Failed to save event:", err);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    if (feedLoadingRef.current) return;
    feedLoadingRef.current = true;

    try {
      let rawEvents: NostrEvent[];

      if (feedMode === "global") {
        // Fetch from relays for global mode (events are NOT persisted)
        rawEvents = await invoke<NostrEvent[]>("fetch_global_feed", { limit: 50 });
      } else {
        // WoT mode: query local DB (follows only)
        const [rawNotes, rawArticles] = await Promise.all([
          invoke<NostrEvent[]>("get_feed", { filter: { kinds: [1, 6], limit: 50, wot_only: true } }),
          invoke<NostrEvent[]>("get_feed", { filter: { kinds: [30023], limit: 20, wot_only: true } }),
        ]);
        rawEvents = [...rawArticles, ...rawNotes];
      }

      const kindFiltered = rawEvents.filter((e) => FEED_KINDS.includes(e.kind));
      const newEvents = kindFiltered.filter((e) => !renderedEventIdsRef.current.has(e.id));
      if (newEvents.length === 0) {
        setLoading(false);
        return;
      }

      const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
      ensureProfiles(pubkeys);

      for (const e of newEvents) {
        renderedEventIdsRef.current.add(e.id);
      }

      setFeedEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
        const merged = [...toAdd, ...prev];
        const articles = merged.filter((e) => e.kind === 30023);
        const notes = merged.filter((e) => e.kind !== 30023);
        return [...articles, ...notes];
      });

      setLoading(false);
    } catch (err) {
      console.warn("[feed] Failed to load events:", err);
      setLoading(false);
    } finally {
      feedLoadingRef.current = false;
    }
  }, [feedMode, ensureProfiles]);

  // Track oldest timestamps for pagination
  useEffect(() => {
    const notes = feedEvents.filter((e) => e.kind !== 30023);
    if (notes.length > 0) {
      oldestNoteTimestamp.current = Math.min(...notes.map((e) => e.created_at));
    } else {
      oldestNoteTimestamp.current = null;
    }
    const arts = feedEvents.filter((e) => e.kind === 30023);
    if (arts.length > 0) {
      oldestArticleTimestamp.current = Math.min(...arts.map((e) => e.created_at));
    } else {
      oldestArticleTimestamp.current = null;
    }
  }, [feedEvents]);

  const loadMoreEvents = useCallback(async () => {
    if (feedLoadingRef.current || isSearchMode || !hasMore) return;
    const oldest = oldestNoteTimestamp.current;
    if (oldest === null) return;
    const until = oldest - 1;

    feedLoadingRef.current = true;
    setLoadingMore(true);

    try {
      let rawEvents: NostrEvent[];

      if (feedMode === "global") {
        rawEvents = await invoke<NostrEvent[]>("fetch_global_feed", { limit: 50, until });
      } else {
        rawEvents = await invoke<NostrEvent[]>("get_feed", {
          filter: { kinds: [1, 6], limit: 50, wot_only: true, until },
        });
      }

      // Only mark end when backend returned fewer than requested
      if (rawEvents.length === 0) {
        setHasMore(false);
        return;
      }

      const kindFiltered = rawEvents.filter((e) => FEED_KINDS.includes(e.kind));
      const newEvents = kindFiltered.filter((e) => !renderedEventIdsRef.current.has(e.id));

      if (newEvents.length === 0) return;

      const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
      ensureProfiles(pubkeys);

      for (const e of newEvents) {
        renderedEventIdsRef.current.add(e.id);
      }

      setFeedEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
        return [...prev, ...toAdd];
      });
    } catch (err) {
      console.warn("[feed] Failed to load more events:", err);
    } finally {
      feedLoadingRef.current = false;
      setLoadingMore(false);
    }
  }, [feedMode, isSearchMode, hasMore, ensureProfiles]);

  const loadMoreArticles = useCallback(async () => {
    if (articleLoadingRef.current || isSearchMode || !hasMoreArticles || feedMode === "global") return;
    const oldest = oldestArticleTimestamp.current;
    if (oldest === null) return;
    const until = oldest - 1;

    articleLoadingRef.current = true;
    setLoadingMoreArticles(true);

    try {
      const rawEvents = await invoke<NostrEvent[]>("get_feed", {
        filter: { kinds: [30023], limit: 20, wot_only: true, until },
      });

      if (rawEvents.length === 0) {
        setHasMoreArticles(false);
        return;
      }

      const newEvents = rawEvents.filter((e) => !renderedEventIdsRef.current.has(e.id));
      if (newEvents.length === 0) return;

      const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
      ensureProfiles(pubkeys);

      for (const e of newEvents) {
        renderedEventIdsRef.current.add(e.id);
      }

      setFeedEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
        return [...prev, ...toAdd];
      });
    } catch (err) {
      console.warn("[feed] Failed to load more articles:", err);
    } finally {
      articleLoadingRef.current = false;
      setLoadingMoreArticles(false);
    }
  }, [isSearchMode, hasMoreArticles, feedMode, ensureProfiles]);

  // Reset feed when mode changes
  useEffect(() => {
    renderedEventIdsRef.current.clear();
    setFeedEvents([]);
    setSavedEventIds(new Set());
    setHasMore(true);
    setHasMoreArticles(true);
    if (feedMode === "global") {
      setGlobalConsent(false);
      setLoading(false);
    } else {
      setLoading(true);
    }
  }, [feedMode]);

  // Initial load (WoT mode auto-loads; global waits for consent)
  useEffect(() => {
    if (!isSearchMode && feedMode === "wot") {
      loadEvents();
    }
  }, [loadEvents, isSearchMode, feedMode]);

  // Refresh on sync tier complete (WoT only)
  useEffect(() => {
    if (tierEvent && !isSearchMode && feedMode === "wot") {
      loadEvents();
    }
  }, [tierEvent, loadEvents, isSearchMode, feedMode]);

  // 30s refresh interval (WoT only)
  useInterval(() => {
    if (!isSearchMode && feedMode === "wot") {
      loadEvents();
    }
  }, 30000);

  // Handle global consent — fetch once user clicks
  const handleGlobalConsent = useCallback(() => {
    setGlobalConsent(true);
    setLoading(true);
    loadEvents();
  }, [loadEvents]);

  const performSearch = useCallback(async (query: string) => {
    setSearchStatus("Searching\u2026");
    setIsSearchMode(true);

    let sq = query;

    if (isNip05(query)) {
      setSearchStatus(`Resolving ${query}\u2026`);
      const resolved = await resolveNip05(query);
      if (resolved) {
        sq = resolved;
      } else {
        setSearchStatus(`Could not resolve ${query}`);
        setFeedEvents([]);
        return;
      }
    }

    // Local search first
    try {
      const localResults = await invoke<NostrEvent[]>("search_events", { query: sq, limit: 50 });

      const localCount = localResults.length;
      setSearchStatus(`${localCount} local result${localCount !== 1 ? "s" : ""} for "${query}" \u2014 searching relays\u2026`);

      if (localResults.length > 0) {
        const pubkeys = [...new Set(localResults.map((e) => e.pubkey))];
        ensureProfiles(pubkeys);
      }
      setFeedEvents([...localResults]);

      // Global search from relays (async, appends results)
      try {
        const globalResults = await invoke<NostrEvent[]>("search_global", { query: sq, limit: 50 });
        const localIds = new Set(localResults.map((e) => e.id));
        const newResults = globalResults.filter((e) => !localIds.has(e.id));

        if (newResults.length > 0) {
          const pubkeys = [...new Set(newResults.map((e) => e.pubkey))];
          ensureProfiles(pubkeys);
          setFeedEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.id));
            const toAdd = newResults.filter((e) => !existingIds.has(e.id));
            return [...prev, ...toAdd];
          });
        }

        const totalCount = localCount + newResults.length;
        setSearchStatus(`${totalCount} result${totalCount !== 1 ? "s" : ""} for "${query}" (${localCount} local, ${newResults.length} relay)`);
      } catch {
        // Relay search failed, keep local results
        setSearchStatus(`${localCount} result${localCount !== 1 ? "s" : ""} for "${query}" (local only)`);
      }
    } catch {
      setSearchStatus("Search failed");
      setFeedEvents([]);
    }
  }, [ensureProfiles]);

  const handleSearchInput = useCallback(
    (val: string) => {
      setSearchQuery(val);

      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

      if (!val.trim()) {
        setIsSearchMode(false);
        setSearchStatus(null);
        renderedEventIdsRef.current.clear();
        setFeedEvents([]);
        setLoading(true);
        setHasMore(true);
        setHasMoreArticles(true);
        return;
      }

      searchTimerRef.current = setTimeout(() => {
        performSearch(val.trim());
      }, 300);
    },
    [performSearch],
  );

  const handleSearchClear = useCallback(() => {
    setSearchQuery("");
    setIsSearchMode(false);
    setSearchStatus(null);
    renderedEventIdsRef.current.clear();
    setFeedEvents([]);
    setLoading(true);
    setHasMore(true);
    setHasMoreArticles(true);
  }, []);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // Scroll handlers for infinite scroll (must be before any conditional returns — Rules of Hooks)
  const handleNotesScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
        loadMoreEvents();
      }
    },
    [loadMoreEvents],
  );

  const handleArticlesScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
        loadMoreArticles();
      }
    },
    [loadMoreArticles],
  );

  // Article reader view
  if (view.kind === "article") {
    return (
      <ArticleReader
        event={view.event}
        onBack={() => setView({ kind: "feed" })}
      />
    );
  }

  // Separate articles and notes for rendering
  const articles = feedEvents.filter((e) => e.kind === 30023);
  const notes = feedEvents.filter((e) => e.kind !== 30023);

  // Apply filter visibility
  const filteredNotes = activeFilter === "all"
    ? notes
    : notes.filter((e) => kindTag(e.kind) === activeFilter);

  // Layout: articles on left carousel, notes on right
  const showArticleColumn = (activeFilter === "all" || activeFilter === "long-form") && articles.length > 0;
  const showNotesColumn = activeFilter !== "long-form";

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "note", label: "Notes" },
    { key: "long-form", label: "Long-form" },
    { key: "repost", label: "Reposts" },
  ];

  return (
    <div className="feed-page">
      <div className="feed-header-row">
        <div className="feed-mode-toggle">
          <button
            className={`feed-mode-btn${feedMode === "wot" ? " active" : ""}`}
            onClick={() => setFeedMode("wot")}
          >
            WoT
          </button>
          <button
            className={`feed-mode-btn${feedMode === "global" ? " active" : ""}`}
            onClick={() => setFeedMode("global")}
          >
            Global
          </button>
        </div>
        <div className="feed-filters">
          {filterTabs.map((tab) => (
            <div
              key={tab.key}
              className={`feed-filter${activeFilter === tab.key ? " active" : ""}`}
              data-filter={tab.key}
              onClick={() => setActiveFilter(tab.key)}
            >
              {tab.label}
            </div>
          ))}
        </div>
        <div className="feed-search-wrap">
          <input
            type="text"
            className="feed-search-input"
            placeholder="Search notes, npub, name@domain\u2026"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
          />
          {searchQuery && (
            <button className="feed-search-clear" onClick={handleSearchClear}>
              <span className="icon"><IconX /></span>
            </button>
          )}
        </div>
      </div>

      {searchStatus && (
        <div className="feed-search-status">{searchStatus}</div>
      )}

      <div className="feed-layout">
        {/* Notes column (left) with infinite scroll */}
        {showNotesColumn && (
          <div className="feed-notes-column" onScroll={handleNotesScroll}>
            {feedMode === "global" && !globalConsent && !isSearchMode && (
              <div className="global-consent">
                <div className="global-consent-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </div>
                <h3 className="global-consent-title">Global Feed</h3>
                <p className="global-consent-text">
                  This will fetch recent notes from public relays. These events are temporary and won't be saved to your local database unless you explicitly save them.
                </p>
                <button className="global-consent-btn" onClick={handleGlobalConsent}>
                  Fetch Global Feed
                </button>
              </div>
            )}

            {loading && !isSearchMode && (feedMode === "wot" || globalConsent) && (
              <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
                Loading events...
              </div>
            )}

            {!loading && feedEvents.length === 0 && !isSearchMode && (feedMode === "wot" || globalConsent) && (
              <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
                No events yet
              </div>
            )}

            {isSearchMode && feedEvents.length === 0 && searchStatus && !searchStatus.includes("Searching") && !searchStatus.includes("Resolving") && (
              <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
                No events found
              </div>
            )}

            {filteredNotes.map((event) => (
              <NoteCard
                key={event.id}
                event={event}
                profile={getProfile(event.pubkey)}
                onSave={feedMode === "global" ? saveEvent : undefined}
                saved={savedEventIds.has(event.id)}
              />
            ))}

            {!loading && !isSearchMode && hasMore && filteredNotes.length > 0 && (feedMode === "wot" || globalConsent) && (
              <div className="feed-sentinel">
                {loadingMore && <span className="feed-sentinel-text">Loading more...</span>}
              </div>
            )}

            {!isSearchMode && !hasMore && filteredNotes.length > 0 && (
              <div className="feed-end">No more events to load</div>
            )}
          </div>
        )}

        {/* Articles column (right vertical carousel) — split view */}
        {showArticleColumn && showNotesColumn && (
          <div className="feed-articles-column" onScroll={handleArticlesScroll}>
            {articles.map((event) => (
              <ArticleCard
                key={event.id}
                event={event}
                profile={getProfile(event.pubkey)}
                onClick={() => setView({ kind: "article", event })}
              />
            ))}
            {hasMoreArticles && articles.length > 0 && (
              <div className="feed-sentinel">
                {loadingMoreArticles && <span className="feed-sentinel-text">Loading more...</span>}
              </div>
            )}
          </div>
        )}

        {/* Articles grid — full width when long-form filter only */}
        {showArticleColumn && !showNotesColumn && (
          <div className="feed-articles-full" onScroll={handleArticlesScroll}>
            <div className="article-cards-grid">
              {articles.map((event) => (
                <ArticleCard
                  key={event.id}
                  event={event}
                  profile={getProfile(event.pubkey)}
                  onClick={() => setView({ kind: "article", event })}
                />
              ))}
            </div>
            {hasMoreArticles && articles.length > 0 && (
              <div className="feed-sentinel">
                {loadingMoreArticles && <span className="feed-sentinel-text">Loading more...</span>}
              </div>
            )}
          </div>
        )}

        {/* Empty state for long-form filter with no articles */}
        {!showArticleColumn && !showNotesColumn && !loading && (
          <div className="feed-notes-column">
            <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
              No long-form events yet
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
