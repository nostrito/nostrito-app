/** Feed -- event feed view. All data from get_feed backend command. */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconMessageCircle, IconRepeat, IconZap, IconX } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { timeAgo, formatDate } from "../utils/format";
import { kindLabel } from "../utils/ui";
import { renderMediaHtml, stripMediaUrls, initMediaViewer } from "../utils/media";
import { renderMarkdown } from "../utils/markdown";
import { getProfiles, profileDisplayName, type ProfileInfo } from "../utils/profiles";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useInterval } from "../hooks/useInterval";
import type { NostrEvent } from "../types/nostr";

/** Kinds that belong in the feed */
const FEED_KINDS = [1, 6, 30023];

// -- NIP-23 tag helpers --

function getTagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag && tag.length > 1 ? tag[1] : null;
}

function getArticleTitle(event: NostrEvent): string {
  return getTagValue(event.tags, "title") || "Untitled";
}

function getArticleSummary(event: NostrEvent): string {
  const summary = getTagValue(event.tags, "summary");
  if (summary) return summary.length > 200 ? summary.slice(0, 200) + "\u2026" : summary;
  const plain = event.content
    .replace(/^#+\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[.*?\]\(.*?\)/g, "")
    .trim();
  return plain.length > 150 ? plain.slice(0, 150) + "\u2026" : plain;
}

function getArticleImage(event: NostrEvent): string | null {
  return getTagValue(event.tags, "image");
}

function getArticleTimestamp(event: NostrEvent): number {
  const published = getTagValue(event.tags, "published_at");
  if (published) {
    const ts = parseInt(published, 10);
    if (!isNaN(ts)) return ts;
  }
  return event.created_at;
}

// -- Repost helpers --

function parseRepostContent(event: NostrEvent): { content: string; pubkey: string } | null {
  if (event.kind !== 6 || !event.content.trim()) return null;
  try {
    const original = JSON.parse(event.content);
    if (original && typeof original.content === "string" && original.content.trim()) {
      return { content: original.content, pubkey: original.pubkey || event.pubkey };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

function renderEventContent(content: string): { cleaned: string; mediaHtml: string } {
  const mediaHtml = renderMediaHtml(content);
  const cleaned = stripMediaUrls(content).slice(0, 280);
  return { cleaned, mediaHtml };
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

// -- Sub-components --

interface FeedCardProps {
  event: NostrEvent;
  profile?: ProfileInfo;
}

const FeedCard: React.FC<FeedCardProps> = ({ event, profile }) => {
  const k = kindLabel(event.kind);
  const displayName = profileDisplayName(profile, event.pubkey);

  if (event.kind === 6) {
    const original = parseRepostContent(event);
    if (!original) return null;

    const repostContent = renderEventContent(original.content);

    return (
      <div className="event-card" data-kind={k.tag}>
        <Avatar picture={profile?.picture} pubkey={event.pubkey} className="ev-avatar" clickable />
        <div className="ev-content">
          <div className="ev-meta">
            <span className="ev-npub" data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>
              {displayName}
            </span>
            <span className={`ev-kind-tag ${k.cls}`}>
              <span className="icon"><IconRepeat /></span> repost
            </span>
            <span className="ev-time">{timeAgo(event.created_at, false)}</span>
          </div>
          <div className="ev-text">{repostContent.cleaned}</div>
          {repostContent.mediaHtml && (
            <div dangerouslySetInnerHTML={{ __html: repostContent.mediaHtml }} />
          )}
          <div className="ev-actions">
            <button className="ev-action"><span className="icon"><IconMessageCircle /></span> 0</button>
            <button className="ev-action"><span className="icon"><IconRepeat /></span> 0</button>
            <button className="ev-action"><span className="icon"><IconZap /></span> 0</button>
          </div>
        </div>
      </div>
    );
  }

  const eventContent = renderEventContent(event.content);

  return (
    <div className="event-card" data-kind={k.tag}>
      <Avatar picture={profile?.picture} pubkey={event.pubkey} className="ev-avatar" clickable />
      <div className="ev-content">
        <div className="ev-meta">
          <span className="ev-npub" data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>
            {displayName}
          </span>
          <span className={`ev-kind-tag ${k.cls}`}>{k.tag}</span>
          <span className="ev-time">{timeAgo(event.created_at, false)}</span>
        </div>
        <div className="ev-text">{eventContent.cleaned}</div>
        {eventContent.mediaHtml && (
          <div dangerouslySetInnerHTML={{ __html: eventContent.mediaHtml }} />
        )}
        <div className="ev-actions">
          <button className="ev-action"><span className="icon"><IconMessageCircle /></span> 0</button>
          <button className="ev-action"><span className="icon"><IconRepeat /></span> 0</button>
          <button className="ev-action"><span className="icon"><IconZap /></span> 0</button>
        </div>
      </div>
    </div>
  );
};

interface ArticleCardProps {
  event: NostrEvent;
  profile?: ProfileInfo;
  onClick: () => void;
}

const ArticleCard: React.FC<ArticleCardProps> = ({ event, profile, onClick }) => {
  const title = getArticleTitle(event);
  const summary = getArticleSummary(event);
  const image = getArticleImage(event);
  const ts = getArticleTimestamp(event);
  const displayName = profileDisplayName(profile, event.pubkey);

  return (
    <div className="article-card" data-kind="long-form" data-event-id={event.id} onClick={onClick}>
      {image && (
        <div className="article-card-cover">
          <img
            src={image}
            alt=""
            loading="lazy"
            onError={(e) => {
              const parent = (e.target as HTMLImageElement).parentElement;
              if (parent) parent.style.display = "none";
            }}
          />
        </div>
      )}
      <div className="article-card-body">
        <div className="article-card-title">{title}</div>
        <div className="article-card-summary">{summary}</div>
        <div className="article-card-footer">
          <div className="article-card-author">
            <Avatar
              picture={profile?.picture}
              pubkey={event.pubkey}
              className="article-card-avatar"
              fallbackClassName="article-card-avatar article-card-avatar-fallback"
            />
            <span className="article-card-author-name">{displayName}</span>
          </div>
          <span className="article-card-date">{formatDate(ts)}</span>
        </div>
      </div>
    </div>
  );
};

interface ArticleReaderProps {
  event: NostrEvent;
  profile?: ProfileInfo;
  onBack: () => void;
}

const ArticleReader: React.FC<ArticleReaderProps> = ({ event, profile, onBack }) => {
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

export const Feed: React.FC = () => {
  const [view, setView] = useState<FeedView>({ kind: "feed" });
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [feedEvents, setFeedEvents] = useState<NostrEvent[]>([]);
  const [profileMap, setProfileMap] = useState<Map<string, ProfileInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [isSearchMode, setIsSearchMode] = useState(false);

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
      const [rawNotes, rawArticles] = await Promise.all([
        invoke<NostrEvent[]>("get_feed", { filter: { kinds: [1, 6], limit: 50 } }),
        invoke<NostrEvent[]>("get_feed", { filter: { kinds: [30023], limit: 20 } }),
      ]);
      const rawEvents = [...rawArticles, ...rawNotes];
      const kindFiltered = rawEvents.filter((e) => FEED_KINDS.includes(e.kind));
      const newEvents = kindFiltered.filter((e) => !renderedEventIdsRef.current.has(e.id));
      if (newEvents.length === 0) {
        setLoading(false);
        return;
      }

      const pubkeys = [...new Set(newEvents.map((e) => e.pubkey))];
      const profiles = await getProfiles(pubkeys);

      // Mark as rendered
      for (const e of newEvents) {
        renderedEventIdsRef.current.add(e.id);
      }

      setProfileMap((prev) => {
        const merged = new Map(prev);
        profiles.forEach((v, k) => merged.set(k, v));
        return merged;
      });

      setFeedEvents((prev) => {
        // Merge new events, avoiding duplicates
        const existingIds = new Set(prev.map((e) => e.id));
        const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
        const merged = [...toAdd, ...prev];
        // Cap at 100 note/repost items + unlimited articles
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
  }, []);

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

    let searchQuery = query;

    if (isNip05(query)) {
      setSearchStatus(`Resolving ${query}\u2026`);
      const resolved = await resolveNip05(query);
      if (resolved) {
        searchQuery = resolved;
      } else {
        setSearchStatus(`Could not resolve ${query}`);
        setFeedEvents([]);
        return;
      }
    }

    try {
      const results = await invoke<NostrEvent[]>("search_events", { query: searchQuery, limit: 50 });

      setSearchStatus(`${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"`);

      if (results.length === 0) {
        setFeedEvents([]);
        return;
      }

      const pubkeys = [...new Set(results.map((e) => e.pubkey))];
      const profiles = await getProfiles(pubkeys);

      setProfileMap((prev) => {
        const merged = new Map(prev);
        profiles.forEach((v, k) => merged.set(k, v));
        return merged;
      });

      setFeedEvents([...results]);
    } catch {
      setSearchStatus("Search failed");
      setFeedEvents([]);
    }
  }, []);

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
        // loadEvents will fire via the useEffect watching isSearchMode
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
        profile={profileMap.get(view.event.pubkey)}
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
    : notes.filter((e) => {
        const k = kindLabel(e.kind);
        return k.tag === activeFilter;
      });

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "note", label: "Notes" },
    { key: "long-form", label: "Long-form" },
    { key: "repost", label: "Reposts" },
  ];

  return (
    <>
      <div className="feed-header-row">
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
                profile={profileMap.get(event.pubkey)}
                onClick={() => setView({ kind: "article", event })}
              />
            ))}
          </div>
        )}

        {filteredNotes.map((event) => (
          <FeedCard
            key={event.id}
            event={event}
            profile={profileMap.get(event.pubkey)}
          />
        ))}
      </div>
    </>
  );
};
