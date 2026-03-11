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

  const { getProfile, ensureProfiles } = useProfileContext();

  const renderedEventIdsRef = useRef(new Set<string>());
  const feedLoadingRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for sync tier completion to trigger refresh
  const tierEvent = useTauriEvent<{ tier: number }>("sync:tier_complete");

  // Init media viewer on mount
  useEffect(() => {
    initMediaViewer();
  }, []);

  const loadEvents = useCallback(async () => {
    if (feedLoadingRef.current) return;
    feedLoadingRef.current = true;

    try {
      let rawEvents: NostrEvent[];

      if (feedMode === "global") {
        // Fetch from relays for global mode
        rawEvents = await invoke<NostrEvent[]>("fetch_global_feed", { limit: 50 });
      } else {
        // WoT mode: query local DB
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
        const notes = merged.filter((e) => e.kind !== 30023).slice(0, 100);
        return [...articles, ...notes];
      });

      setLoading(false);
    } catch {
      console.warn("[feed] Failed to load events");
      setLoading(false);
    } finally {
      feedLoadingRef.current = false;
    }
  }, [feedMode, ensureProfiles]);

  // Reset feed when mode changes
  useEffect(() => {
    renderedEventIdsRef.current.clear();
    setFeedEvents([]);
    setLoading(true);
  }, [feedMode]);

  // Initial load
  useEffect(() => {
    if (!isSearchMode) {
      loadEvents();
    }
  }, [loadEvents, isSearchMode]);

  // Refresh on sync tier complete
  useEffect(() => {
    if (tierEvent && !isSearchMode) {
      loadEvents();
    }
  }, [tierEvent, loadEvents, isSearchMode]);

  // 30s refresh interval
  useInterval(() => {
    if (!isSearchMode) {
      loadEvents();
    }
  }, 30000);

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
  }, []);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

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
  const showArticleGrid = activeFilter === "all" || activeFilter === "long-form";
  const filteredNotes = activeFilter === "all"
    ? notes
    : notes.filter((e) => kindTag(e.kind) === activeFilter);

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "note", label: "Notes" },
    { key: "long-form", label: "Long-form" },
    { key: "repost", label: "Reposts" },
  ];

  return (
    <>
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

      <div id="feedList">
        {loading && !isSearchMode && (
          <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
            Loading events...
          </div>
        )}

        {!loading && feedEvents.length === 0 && !isSearchMode && (
          <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
            No events yet
          </div>
        )}

        {isSearchMode && feedEvents.length === 0 && searchStatus && !searchStatus.includes("Searching") && !searchStatus.includes("Resolving") && (
          <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
            No events found
          </div>
        )}

        {showArticleGrid && articles.length > 0 && (
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
        )}

        {filteredNotes.map((event) => (
          <NoteCard
            key={event.id}
            event={event}
            profile={getProfile(event.pubkey)}
          />
        ))}
      </div>
    </>
  );
};
