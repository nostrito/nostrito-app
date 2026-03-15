/** Feed -- event feed view. All data from get_feed backend command. */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconX } from "../components/Icon";
import { NoteCard, GroupedRepostCard, getRepostOriginalId, type GroupedRepost } from "../components/NoteCard";
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

/** Deduplicate kind:30023 articles by pubkey:d-tag, keeping the newest version. */
function deduplicateArticles(events: NostrEvent[]): NostrEvent[] {
  const articles = events.filter((e) => e.kind === 30023);
  const rest = events.filter((e) => e.kind !== 30023);
  const best = new Map<string, NostrEvent>();
  for (const e of articles) {
    const dTag = e.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const key = `${e.pubkey}:${dTag}`;
    const existing = best.get(key);
    if (!existing || e.created_at > existing.created_at) {
      best.set(key, e);
    }
  }
  return [...Array.from(best.values()), ...rest];
}

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
          &#x2190; back to feed
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  // Article fetch stages: "local" → "relay-follows" → "relay-wot" → "done"
  const articleStageRef = useRef<"local" | "relay-follows" | "relay-wot" | "done">("local");
  const [fetchingRelay, setFetchingRelay] = useState(false);
  const [relayFetched, setRelayFetched] = useState(false);

  const { getProfile, ensureProfiles } = useProfileContext();

  const [groupedReposts, setGroupedReposts] = useState<Map<string, GroupedRepost>>(new Map());
  const fetchedOriginalIdsRef = useRef(new Set<string>());

  const renderedEventIdsRef = useRef(new Set<string>());
  const feedLoadingRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oldestNoteTimestamp = useRef<number | null>(null);
  const oldestArticleTimestamp = useRef<number | null>(null);
  const articleLoadingRef = useRef(false);
  const feedColumnRef = useRef<HTMLDivElement>(null);
  const [newPostCount, setNewPostCount] = useState(0);

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
        rawEvents = await invoke<NostrEvent[]>("fetch_global_feed", { limit: 50 });
      } else {
        rawEvents = await invoke<NostrEvent[]>("get_feed", {
          filter: { kinds: [1, 6, 30023], limit: 50, wot_only: true },
        });
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

      // Track new posts for banner when user is scrolled down
      const scrollEl = feedColumnRef.current;
      if (scrollEl && scrollEl.scrollTop > 50 && feedEvents.length > 0) {
        setNewPostCount((prev) => prev + newEvents.length);
      }

      setFeedEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
        return deduplicateArticles([...toAdd, ...prev]);
      });

      setLoading(false);
    } catch (err) {
      console.warn("[feed] Failed to load events:", err);
      setLoading(false);
    } finally {
      feedLoadingRef.current = false;
    }
  }, [feedMode, ensureProfiles, feedEvents.length]);

  // Track oldest note timestamp for pagination (articles tracked separately in loadMoreArticles)
  useEffect(() => {
    const notes = feedEvents.filter((e) => e.kind !== 30023);
    if (notes.length > 0) {
      oldestNoteTimestamp.current = Math.min(...notes.map((e) => e.created_at));
    } else {
      oldestNoteTimestamp.current = null;
    }
  }, [feedEvents]);

  // Group reposts by original event ID and auto-fetch missing originals (3+ reposts threshold)
  useEffect(() => {
    const reposts = feedEvents.filter((e) => e.kind === 6);
    if (reposts.length === 0) return;

    // Count reposts per original event ID
    const repostsByOriginal = new Map<string, NostrEvent[]>();
    for (const ev of reposts) {
      const origId = getRepostOriginalId(ev);
      if (!origId) continue;
      const list = repostsByOriginal.get(origId) || [];
      list.push(ev);
      repostsByOriginal.set(origId, list);
    }

    // Only group when 3+ reposts reference the same original
    const groups = new Map<string, GroupedRepost>();
    const idsToFetch: string[] = [];

    for (const [origId, reposters] of repostsByOriginal) {
      if (reposters.length < 3) continue;

      // Check if the original event already exists in feedEvents (as a kind:1 note)
      const existingOriginal = feedEvents.find((e) => e.id === origId && e.kind !== 6);

      // Or check if any repost has the full content embedded
      let embeddedOriginal: NostrEvent | null = null;
      if (!existingOriginal) {
        for (const r of reposters) {
          try {
            const parsed = JSON.parse(r.content);
            if (parsed && parsed.id && parsed.content && parsed.pubkey) {
              embeddedOriginal = {
                id: parsed.id,
                pubkey: parsed.pubkey,
                created_at: parsed.created_at ?? r.created_at,
                kind: parsed.kind ?? 1,
                tags: parsed.tags ?? [],
                content: parsed.content,
                sig: parsed.sig ?? "",
              };
              break;
            }
          } catch { /* no embedded content */ }
        }
      }

      const originalEvent = existingOriginal ?? embeddedOriginal;

      if (originalEvent) {
        groups.set(origId, {
          originalId: origId,
          reposters,
          originalEvent,
          status: "loaded",
        });
      } else if (!fetchedOriginalIdsRef.current.has(origId)) {
        // Need to fetch from relays
        groups.set(origId, {
          originalId: origId,
          reposters,
          originalEvent: null,
          status: "loading",
        });
        idsToFetch.push(origId);
      } else {
        // Already tried fetching, not found
        groups.set(origId, {
          originalId: origId,
          reposters,
          originalEvent: null,
          status: "not-found",
        });
      }
    }

    if (groups.size > 0) {
      setGroupedReposts(groups);
    }

    // Fetch missing originals from relays
    if (idsToFetch.length > 0) {
      for (const id of idsToFetch) {
        fetchedOriginalIdsRef.current.add(id);
      }
      invoke<NostrEvent[]>("fetch_events_by_ids", { ids: idsToFetch })
        .then((fetched) => {
          const fetchedMap = new Map(fetched.map((e) => [e.id, e]));
          if (fetched.length > 0) {
            const pks = fetched.map((e) => e.pubkey);
            ensureProfiles(pks);
          }
          setGroupedReposts((prev) => {
            const next = new Map(prev);
            for (const id of idsToFetch) {
              const group = next.get(id);
              if (!group) continue;
              const found = fetchedMap.get(id);
              next.set(id, {
                ...group,
                originalEvent: found ?? null,
                status: found ? "loaded" : "not-found",
              });
            }
            return next;
          });
        })
        .catch((err) => {
          console.warn("[feed] Failed to fetch repost originals:", err);
          setGroupedReposts((prev) => {
            const next = new Map(prev);
            for (const id of idsToFetch) {
              const group = next.get(id);
              if (!group) continue;
              next.set(id, { ...group, status: "not-found" });
            }
            return next;
          });
        });
    }
  }, [feedEvents, ensureProfiles]);

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
          filter: { kinds: [1, 6, 30023], limit: 50, wot_only: true, until },
        });
      }

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

  /** Append article results to state, returns count of new (non-dupe) events added. */
  const appendArticles = useCallback((rawEvents: NostrEvent[]): number => {
    const oldest = oldestArticleTimestamp.current;
    const oldestFetched = Math.min(...rawEvents.map((e) => e.created_at));
    if (oldest === null || oldestFetched < oldest) {
      oldestArticleTimestamp.current = oldestFetched;
    }

    const newEvents = rawEvents.filter((e) => !renderedEventIdsRef.current.has(e.id));
    if (newEvents.length === 0) return 0;

    const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
    ensureProfiles(pubkeys);

    for (const e of newEvents) {
      renderedEventIdsRef.current.add(e.id);
    }

    setFeedEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
      return deduplicateArticles([...prev, ...toAdd]);
    });

    return newEvents.length;
  }, [ensureProfiles]);

  const loadMoreArticles = useCallback(async () => {
    if (articleLoadingRef.current || isSearchMode || !hasMoreArticles) return;

    articleLoadingRef.current = true;
    setLoadingMoreArticles(true);

    try {
      const oldest = oldestArticleTimestamp.current;
      const until = oldest !== null ? oldest - 1 : undefined;

      // Stage 1: Try local DB first (for both WoT and global)
      if (articleStageRef.current === "local") {
        let rawEvents: NostrEvent[];

        if (feedMode === "global") {
          rawEvents = await invoke<NostrEvent[]>("fetch_global_feed", {
            limit: 20, kinds: [30023], ...(until !== undefined && { until }),
          });
        } else {
          rawEvents = await invoke<NostrEvent[]>("get_feed", {
            filter: { kinds: [30023], limit: 20, wot_only: true, ...(until !== undefined && { until }) },
          });
        }

        if (rawEvents.length > 0) {
          appendArticles(rawEvents);
          return;
        }

        // Local exhausted — move to relay fetching
        articleStageRef.current = "relay-follows";
      }

      // Stage 2: Fetch from follows' relays
      if (articleStageRef.current === "relay-follows") {
        const rawEvents = await invoke<NostrEvent[]>("fetch_wot_articles", {
          layer: "follows", limit: 20, ...(until !== undefined && { until }),
        });

        if (rawEvents.length > 0) {
          appendArticles(rawEvents);
          return;
        }

        // Follows exhausted — move to WoT
        articleStageRef.current = "relay-wot";
      }

      // Stage 3: Fetch from WoT (follows-of-follows) relays
      if (articleStageRef.current === "relay-wot") {
        const rawEvents = await invoke<NostrEvent[]>("fetch_wot_articles", {
          layer: "wot", limit: 20, ...(until !== undefined && { until }),
        });

        if (rawEvents.length > 0) {
          appendArticles(rawEvents);
          return;
        }

        // All stages exhausted
        articleStageRef.current = "done";
      }

      setHasMoreArticles(false);
    } catch (err) {
      console.warn("[feed] Failed to load more articles:", err);
    } finally {
      articleLoadingRef.current = false;
      setLoadingMoreArticles(false);
    }
  }, [isSearchMode, hasMoreArticles, feedMode, ensureProfiles, appendArticles]);

  const fetchFromRelays = useCallback(async () => {
    if (fetchingRelay) return;
    setFetchingRelay(true);
    try {
      const rawEvents = await invoke<NostrEvent[]>("fetch_global_feed", { limit: 50 });
      const newEvents = rawEvents.filter((e) => FEED_KINDS.includes(e.kind) && !renderedEventIdsRef.current.has(e.id));

      if (newEvents.length > 0) {
        const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
        ensureProfiles(pubkeys);

        for (const e of newEvents) {
          renderedEventIdsRef.current.add(e.id);
        }

        setFeedEvents((prev) => {
          const existingIds = new Set(prev.map((e) => e.id));
          const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
          return deduplicateArticles([...prev, ...toAdd]);
        });

        // Mark relay events for save buttons
        setSavedEventIds((prev) => new Set(prev));
      }
      setRelayFetched(true);
    } catch (err) {
      console.warn("[feed] Failed to fetch from relays:", err);
    } finally {
      setFetchingRelay(false);
    }
  }, [fetchingRelay, ensureProfiles]);

  // Reset feed when mode changes
  useEffect(() => {
    renderedEventIdsRef.current.clear();
    fetchedOriginalIdsRef.current.clear();
    setFeedEvents([]);
    setSavedEventIds(new Set());
    setGroupedReposts(new Map());
    setHasMore(true);
    setHasMoreArticles(true);
    articleStageRef.current = "local";
    oldestArticleTimestamp.current = null;
    setRelayFetched(false);
    setNewPostCount(0);
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

  // Track whether relay search is available/in-progress for the current query
  const [searchRelayAvailable, setSearchRelayAvailable] = useState(false);
  const [searchRelayLoading, setSearchRelayLoading] = useState(false);
  const activeSearchQueryRef = useRef<string>("");

  const searchRelaysForQuery = useCallback(async (query: string) => {
    setSearchRelayLoading(true);
    setSearchRelayAvailable(false);
    try {
      const globalResults = await invoke<NostrEvent[]>("search_global", { query, limit: 50 });
      const newResults = globalResults.filter((e) => {
        // Deduplicate against existing feed events
        return !renderedEventIdsRef.current.has(e.id);
      });

      if (newResults.length > 0) {
        const pubkeys = [...new Set(newResults.map((e) => e.pubkey))];
        ensureProfiles(pubkeys);
        for (const e of newResults) renderedEventIdsRef.current.add(e.id);
        setFeedEvents((prev) => {
          const existingIds = new Set(prev.map((e) => e.id));
          const toAdd = newResults.filter((e) => !existingIds.has(e.id));
          return [...prev, ...toAdd];
        });
      }

      setSearchStatus((prev) => {
        const localMatch = prev?.match(/^(\d+)/);
        const localCount = localMatch ? parseInt(localMatch[1], 10) : 0;
        const total = localCount + newResults.length;
        return `${total} result${total !== 1 ? "s" : ""} for "${activeSearchQueryRef.current}" (${localCount} local, ${newResults.length} relay)`;
      });
    } catch {
      setSearchStatus((prev) => (prev ? prev.replace(/ \u2014 searching relays\u2026$/, " (relay search failed)") : prev));
    } finally {
      setSearchRelayLoading(false);
    }
  }, [ensureProfiles]);

  const performSearch = useCallback(async (query: string) => {
    setSearchStatus("searching\u2026");
    setIsSearchMode(true);
    setSearchRelayAvailable(false);
    setSearchRelayLoading(false);

    let sq = query;

    if (isNip05(query)) {
      setSearchStatus(`resolving ${query}\u2026`);
      const resolved = await resolveNip05(query);
      if (resolved) {
        sq = resolved;
      } else {
        setSearchStatus(`could not resolve ${query}`);
        setFeedEvents([]);
        return;
      }
    }

    activeSearchQueryRef.current = sq;

    // Local search first
    try {
      const localResults = await invoke<NostrEvent[]>("search_events", { query: sq, limit: 50 });
      const localCount = localResults.length;

      if (localResults.length > 0) {
        const pubkeys = [...new Set(localResults.map((e) => e.pubkey))];
        ensureProfiles(pubkeys);
        for (const e of localResults) renderedEventIdsRef.current.add(e.id);
      }
      setFeedEvents([...localResults]);

      if (localCount === 0) {
        // Nothing found locally → auto-search relays immediately
        setSearchStatus(`no local results for "${query}" \u2014 searching relays\u2026`);
        searchRelaysForQuery(sq);
      } else {
        // Found locally → show results + offer relay search button
        setSearchStatus(`${localCount} local result${localCount !== 1 ? "s" : ""} for "${query}"`);
        setSearchRelayAvailable(true);
      }
    } catch {
      setSearchStatus("search failed");
      setFeedEvents([]);
    }
  }, [ensureProfiles, searchRelaysForQuery]);

  const handleSearchInput = useCallback(
    (val: string) => {
      setSearchQuery(val);

      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

      if (!val.trim()) {
        setIsSearchMode(false);
        setSearchStatus(null);
        setSearchRelayAvailable(false);
        setSearchRelayLoading(false);
        activeSearchQueryRef.current = "";
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
    setSearchRelayAvailable(false);
    setSearchRelayLoading(false);
    activeSearchQueryRef.current = "";
    renderedEventIdsRef.current.clear();
    setFeedEvents([]);
    setLoading(true);
    setHasMore(true);
    setHasMoreArticles(true);
  }, []);

  // Pick up ?q= search param (e.g. from hashtag clicks)
  useEffect(() => {
    const q = searchParams.get("q");
    if (q) {
      setSearchQuery(q);
      setSearchParams({}, { replace: true });
      performSearch(q);
    }
  }, [searchParams, setSearchParams, performSearch]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // Scroll handlers for infinite scroll
  const handleNotesScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop < 50) {
        setNewPostCount(0);
      }
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

  // Auto-fetch articles when the article column is visible but empty
  const articles = feedEvents.filter((e) => e.kind === 30023);
  useEffect(() => {
    if (
      (activeFilter === "all" || activeFilter === "long-form") &&
      articles.length === 0 &&
      !loading &&
      hasMoreArticles
    ) {
      loadMoreArticles();
    }
  }, [activeFilter, articles.length, loading, hasMoreArticles, loadMoreArticles]);

  // Article reader view
  if (view.kind === "article") {
    return (
      <ArticleReader
        event={view.event}
        onBack={() => setView({ kind: "feed" })}
      />
    );
  }

  // Notes for rendering (articles already computed above)
  const notes = feedEvents.filter((e) => e.kind !== 30023);

  // Collect IDs of reposts that are part of a group (to skip individually)
  const groupedRepostEventIds = new Set<string>();
  for (const group of groupedReposts.values()) {
    for (const r of group.reposters) {
      groupedRepostEventIds.add(r.id);
    }
  }

  // Apply filter visibility, excluding individually grouped reposts
  const filteredNotes = (activeFilter === "all"
    ? notes
    : notes.filter((e) => kindTag(e.kind) === activeFilter)
  ).filter((e) => !groupedRepostEventIds.has(e.id));

  // Layout: articles on right column, notes on left
  const showArticleColumn = activeFilter === "all" || activeFilter === "long-form";
  const showNotesColumn = activeFilter !== "long-form";

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "all" },
    { key: "note", label: "notes" },
    { key: "long-form", label: "long-form" },
    { key: "repost", label: "reposts" },
  ];

  return (
    <div className="feed-page">
      <div className="feed-header-row">
        <div className="feed-mode-toggle">
          <button
            className={`feed-mode-btn${feedMode === "wot" ? " active" : ""}`}
            onClick={() => setFeedMode("wot")}
          >
            wot
          </button>
          <button
            className={`feed-mode-btn${feedMode === "global" ? " active" : ""}`}
            onClick={() => setFeedMode("global")}
          >
            global
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
            placeholder="search notes, npub, name@domain\u2026"
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
        <div className="feed-search-status">
          {searchStatus}
          {searchRelayAvailable && !searchRelayLoading && (
            <button
              className="feed-search-relay-btn"
              onClick={() => searchRelaysForQuery(activeSearchQueryRef.current)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              search relays
            </button>
          )}
          {searchRelayLoading && (
            <span className="feed-search-relay-loading">searching relays\u2026</span>
          )}
        </div>
      )}

      <div className="feed-layout">
        {/* Notes column (left) with infinite scroll */}
        {showNotesColumn && (
          <div className="feed-notes-column" ref={feedColumnRef} onScroll={handleNotesScroll}>
            {newPostCount > 0 && (
              <button
                className="feed-new-posts-banner"
                onClick={() => {
                  feedColumnRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  setNewPostCount(0);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
                {newPostCount} new post{newPostCount > 1 ? "s" : ""}
              </button>
            )}

            {feedMode === "global" && !globalConsent && !isSearchMode && (
              <div className="global-consent">
                <div className="global-consent-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </div>
                <h3 className="global-consent-title">global feed</h3>
                <p className="global-consent-text">
                  this will fetch recent notes from public relays. these events are temporary and won't be saved to your local database unless you explicitly save them.
                </p>
                <button className="global-consent-btn" onClick={handleGlobalConsent}>
                  fetch global feed
                </button>
              </div>
            )}

            {loading && !isSearchMode && (feedMode === "wot" || globalConsent) && (
              <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
                loading events...
              </div>
            )}

            {!loading && feedEvents.length === 0 && !isSearchMode && (feedMode === "wot" || globalConsent) && (
              <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
                no events yet
              </div>
            )}

            {isSearchMode && feedEvents.length === 0 && searchStatus && !searchStatus.includes("searching") && !searchStatus.includes("resolving") && !searchRelayLoading && !searchStatus.includes("searching relays") && (
              <div className="event-card" style={{ justifyContent: "center", color: "var(--text-muted)", padding: 32 }}>
                no events found
              </div>
            )}

            {/* Render grouped reposts at the top when visible */}
            {(activeFilter === "all" || activeFilter === "repost") && Array.from(groupedReposts.values()).map((group) => (
              <GroupedRepostCard
                key={`group-${group.originalId}`}
                group={group}
                onSave={feedMode === "global" ? saveEvent : undefined}
                saved={group.originalEvent ? savedEventIds.has(group.originalEvent.id) : false}
                onClick={group.originalEvent ? () => navigate(`/note/${group.originalEvent!.id}`) : undefined}
              />
            ))}

            {filteredNotes.map((event) => (
              <NoteCard
                key={event.id}
                event={event}
                profile={getProfile(event.pubkey)}
                onSave={feedMode === "global" ? saveEvent : undefined}
                saved={savedEventIds.has(event.id)}
                onClick={() => navigate(`/note/${event.id}`)}
              />
            ))}

            {!loading && !isSearchMode && hasMore && filteredNotes.length > 0 && (feedMode === "wot" || globalConsent) && (
              <div className="feed-sentinel">
                {loadingMore && <span className="feed-sentinel-text">loading more...</span>}
              </div>
            )}

            {!isSearchMode && !hasMore && filteredNotes.length > 0 && feedMode === "wot" && !relayFetched && (
              <div className="feed-end feed-relay-prompt">
                <span>no more local events.</span>
                <button className="feed-relay-fetch-btn" onClick={fetchFromRelays} disabled={fetchingRelay}>
                  {fetchingRelay ? "fetching from relays..." : "fetch from relays?"}
                </button>
              </div>
            )}
            {!isSearchMode && !hasMore && filteredNotes.length > 0 && (feedMode !== "wot" || relayFetched) && (
              <div className="feed-end">no more events to load</div>
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
            {hasMoreArticles && (
              <div className="feed-sentinel">
                {loadingMoreArticles && (
                  <span className="feed-sentinel-text">
                    {articleStageRef.current === "relay-follows" ? "fetching from follows\u2026" :
                     articleStageRef.current === "relay-wot" ? "fetching from network\u2026" :
                     "loading more\u2026"}
                  </span>
                )}
              </div>
            )}
            {!hasMoreArticles && articles.length === 0 && (
              <div className="feed-end" style={{ color: "var(--text-muted)", padding: 32 }}>no articles found</div>
            )}
            {!hasMoreArticles && articles.length > 0 && (
              <div className="feed-end">no more articles</div>
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
            {hasMoreArticles && (
              <div className="feed-sentinel">
                {loadingMoreArticles && (
                  <span className="feed-sentinel-text">
                    {articleStageRef.current === "relay-follows" ? "fetching from follows\u2026" :
                     articleStageRef.current === "relay-wot" ? "fetching from network\u2026" :
                     "loading more\u2026"}
                  </span>
                )}
              </div>
            )}
            {!hasMoreArticles && articles.length === 0 && (
              <div className="feed-end" style={{ color: "var(--text-muted)", padding: 32 }}>no long-form events yet</div>
            )}
            {!hasMoreArticles && articles.length > 0 && (
              <div className="feed-end">no more articles</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
