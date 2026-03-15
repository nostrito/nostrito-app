import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NoteCard } from "../components/NoteCard";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { useProfileContext } from "../context/ProfileContext";
import { renderMarkdown } from "../utils/markdown";
import { getArticleTitle, getArticleImage, getArticleTimestamp } from "../components/ArticleCard";
import { formatDate, timeAgo } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { invalidateInteractionCounts } from "../hooks/useInteractionCounts";
import type { NostrEvent } from "../types/nostr";

// ── Types ───────────────────────────────────────────────────────

interface ThreadData {
  root: NostrEvent | null;
  replies: NostrEvent[];
  reactions: NostrEvent[];
  zaps: NostrEvent[];
}

interface ThreadNode {
  event: NostrEvent;
  children: ThreadNode[];
  depth: number;
}

// ── Thread tree builder ─────────────────────────────────────────

/** Find root event ID referenced by an event's e-tags (NIP-10 conventions). */
function findRootTag(event: NostrEvent): string | null {
  const eTags = event.tags.filter((t) => t[0] === "e");
  // Prefer tagged with "root" marker
  const rootMarked = eTags.find((t) => t.length >= 4 && t[3] === "root");
  if (rootMarked) return rootMarked[1];
  // Fallback: first e-tag
  return eTags[0]?.[1] ?? null;
}

/** Find reply-parent event ID from e-tags (NIP-10). */
function findReplyParent(event: NostrEvent): string | null {
  const eTags = event.tags.filter((t) => t[0] === "e");
  // Prefer tagged with "reply" marker
  const replyMarked = eTags.find((t) => t.length >= 4 && t[3] === "reply");
  if (replyMarked) return replyMarked[1];
  // Fallback: last e-tag (if multiple)
  if (eTags.length > 1) return eTags[eTags.length - 1][1];
  // Single e-tag = both root and reply parent
  return eTags[0]?.[1] ?? null;
}

/** Build a tree of replies from a flat list. */
function buildThreadTree(rootId: string, replies: NostrEvent[]): ThreadNode[] {
  const byId = new Map<string, ThreadNode>();
  const orphans: ThreadNode[] = [];

  // Create nodes
  for (const reply of replies) {
    byId.set(reply.id, { event: reply, children: [], depth: 0 });
  }

  // Link children to parents
  for (const reply of replies) {
    const node = byId.get(reply.id)!;
    const parentId = findReplyParent(reply);

    if (parentId && parentId !== rootId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      // Direct reply to root or orphan
      orphans.push(node);
    }
  }

  // Set depths
  function setDepth(nodes: ThreadNode[], depth: number) {
    for (const n of nodes) {
      n.depth = depth;
      setDepth(n.children, depth + 1);
    }
  }
  setDepth(orphans, 0);

  // Sort each level by created_at ascending
  function sortNodes(nodes: ThreadNode[]) {
    nodes.sort((a, b) => a.event.created_at - b.event.created_at);
    for (const n of nodes) sortNodes(n.children);
  }
  sortNodes(orphans);

  return orphans;
}

// ── Zap parsing ─────────────────────────────────────────────────

function parseZapAmount(zap: NostrEvent): number {
  // Try "amount" tag first (millisats)
  const amountTag = zap.tags.find((t) => t[0] === "amount");
  if (amountTag?.[1]) {
    const msats = parseInt(amountTag[1], 10);
    if (!isNaN(msats)) return Math.floor(msats / 1000);
  }
  // Try bolt11 invoice
  const bolt11Tag = zap.tags.find((t) => t[0] === "bolt11");
  if (bolt11Tag?.[1]) {
    return decodeBolt11Amount(bolt11Tag[1]);
  }
  return 0;
}

/** Rough bolt11 amount decode (handles m/u/n/p multipliers). */
function decodeBolt11Amount(bolt11: string): number {
  const match = bolt11.match(/^lnbc(\d+)([munp]?)/i);
  if (!match) return 0;
  const num = parseInt(match[1], 10);
  const mul = match[2]?.toLowerCase();
  if (mul === "m") return num * 100000; // mBTC to sats
  if (mul === "u") return num * 100;    // uBTC to sats
  if (mul === "n") return Math.floor(num / 10); // nBTC to sats
  if (mul === "p") return Math.floor(num / 10000); // pBTC to sats
  return num * 100000000; // BTC to sats (no multiplier)
}

function formatSats(sats: number): string {
  if (sats >= 1000000) return `${(sats / 1000000).toFixed(1)}M`;
  if (sats >= 1000) return `${(sats / 1000).toFixed(sats >= 10000 ? 0 : 1)}k`;
  return `${sats}`;
}

// ── ThreadNodeCard component ────────────────────────────────────

const ThreadNodeCard: React.FC<{
  node: ThreadNode;
  wotPubkeys: Set<string>;
  navigate: (path: string) => void;
  getProfile: (pk: string) => any;
  showNonWot: boolean;
}> = ({ node, wotPubkeys, navigate, getProfile, showNonWot }) => {
  const isWot = wotPubkeys.has(node.event.pubkey);
  const maxVisualDepth = 4;
  const indent = Math.min(node.depth, maxVisualDepth);

  if (!isWot && !showNonWot) return null;

  return (
    <>
      <div
        className={`thread-reply${!isWot ? " thread-reply-non-wot" : ""}`}
        style={{ marginLeft: indent * 20 }}
      >
        {!isWot && <span className="thread-non-wot-label">outside wot</span>}
        <NoteCard
          event={node.event}
          profile={getProfile(node.event.pubkey)}
          compact
          onClick={() => navigate(`/note/${node.event.id}`)}
        />
      </div>
      {node.children.map((child) => (
        <ThreadNodeCard
          key={child.event.id}
          node={child}
          wotPubkeys={wotPubkeys}
          navigate={navigate}
          getProfile={getProfile}
          showNonWot={showNonWot}
        />
      ))}
    </>
  );
};

// ── Main NoteDetail component ───────────────────────────────────

export const NoteDetail: React.FC = () => {
  const { noteId } = useParams<{ noteId: string }>();
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();

  const [event, setEvent] = useState<NostrEvent | null>(null);
  const [threadData, setThreadData] = useState<ThreadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchingRelays, setFetchingRelays] = useState(false);
  const [wotDistances, setWotDistances] = useState<Record<string, number>>({});
  const [showNonWot, setShowNonWot] = useState(false);

  // Determine root ID for thread fetching
  const rootId = useMemo(() => {
    if (!event) return noteId ?? null;
    const root = findRootTag(event);
    return root ?? event.id;
  }, [event, noteId]);

  // Load the main event first, then thread data
  useEffect(() => {
    if (!noteId) return;
    setLoading(true);
    setThreadData(null);
    setShowNonWot(false);

    const load = async () => {
      // Load the main event
      let mainEvent: NostrEvent | null = null;
      try {
        mainEvent = await invoke<NostrEvent | null>("get_event", { id: noteId });
        setEvent(mainEvent);
        if (mainEvent) ensureProfiles([mainEvent.pubkey]);
      } catch (e) {
        console.error("[note-detail] Failed to load event:", e);
      }

      // Determine root for thread fetch
      const effectiveRootId = mainEvent ? (findRootTag(mainEvent) ?? mainEvent.id) : noteId;

      // Load thread data
      try {
        const data = await invoke<ThreadData>("get_thread_events", { rootId: effectiveRootId });
        setThreadData(data);

        // Ensure profiles for all participants
        const pubkeys = new Set<string>();
        if (data.root) pubkeys.add(data.root.pubkey);
        for (const r of data.replies) pubkeys.add(r.pubkey);
        for (const r of data.reactions) pubkeys.add(r.pubkey);
        for (const z of data.zaps) pubkeys.add(z.pubkey);
        if (pubkeys.size > 0) ensureProfiles(Array.from(pubkeys));
      } catch (e) {
        console.error("[note-detail] Failed to load thread:", e);
      }

      // Load WoT distances for thread participants
      try {
        const distances = await invoke<Record<string, number>>("get_wot_hop_distances", { maxHops: 3 });
        setWotDistances(distances);
      } catch (e) {
        console.error("[note-detail] Failed to load WoT distances:", e);
      }

      setLoading(false);

      // Trigger background relay fetch for completeness
      if (effectiveRootId) {
        invoke("fetch_thread_from_relays", { rootId: effectiveRootId }).catch(() => {});
      }
    };

    load();
  }, [noteId, ensureProfiles]);

  // Listen for thread-updated events from relay fetch
  useEffect(() => {
    if (!rootId) return;
    const unlisten = listen<string>("thread-updated", async (ev) => {
      if (ev.payload === rootId) {
        try {
          const data = await invoke<ThreadData>("get_thread_events", { rootId });
          setThreadData(data);
          invalidateInteractionCounts();
          const pubkeys = new Set<string>();
          if (data.root) pubkeys.add(data.root.pubkey);
          for (const r of data.replies) pubkeys.add(r.pubkey);
          if (pubkeys.size > 0) ensureProfiles(Array.from(pubkeys));
        } catch (e) {
          console.error("[note-detail] Failed to refresh thread:", e);
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [rootId, ensureProfiles]);

  // Manual relay re-fetch
  const fetchFromRelays = useCallback(async () => {
    if (!rootId || fetchingRelays) return;
    setFetchingRelays(true);
    try {
      const count = await invoke<number>("fetch_thread_from_relays", { rootId });
      if (count > 0) {
        const data = await invoke<ThreadData>("get_thread_events", { rootId });
        setThreadData(data);
        invalidateInteractionCounts();
      }
    } catch (e) {
      console.error("[note-detail] Relay fetch failed:", e);
    } finally {
      setFetchingRelays(false);
    }
  }, [rootId, fetchingRelays]);

  // Derived data
  const wotPubkeys = useMemo(() => new Set(Object.keys(wotDistances)), [wotDistances]);

  const reactionCounts = useMemo(() => {
    if (!threadData) return {};
    return threadData.reactions.reduce<Record<string, number>>((acc, r) => {
      const emoji = r.content || "+";
      acc[emoji] = (acc[emoji] || 0) + 1;
      return acc;
    }, {});
  }, [threadData]);

  const zapTotal = useMemo(() => {
    if (!threadData) return 0;
    return threadData.zaps.reduce((sum, z) => sum + parseZapAmount(z), 0);
  }, [threadData]);

  const threadTree = useMemo(() => {
    if (!threadData || !rootId) return [];
    return buildThreadTree(rootId, threadData.replies);
  }, [threadData, rootId]);

  const nonWotReplyCount = useMemo(() => {
    if (!threadData) return 0;
    return threadData.replies.filter((r) => !wotPubkeys.has(r.pubkey)).length;
  }, [threadData, wotPubkeys]);

  if (!noteId) {
    return (
      <div className="screen-page">
        <EmptyState message="no note ID specified." />
      </div>
    );
  }

  // Determine the display event (root event if available, otherwise the clicked event)
  const displayEvent = threadData?.root ?? event;

  return (
    <div className="screen-page note-detail-page">
      {/* Back button */}
      <div className="profile-back-row">
        <button className="btn btn-secondary profile-back-btn" onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          back
        </button>
        <button
          className="btn btn-secondary"
          onClick={fetchFromRelays}
          disabled={fetchingRelays}
          style={{ marginLeft: "auto", fontSize: "0.82rem" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {fetchingRelays ? " fetching..." : " refresh from relays"}
        </button>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: 24 }}>loading note...</div>
      ) : !displayEvent ? (
        <EmptyState message="note not found." />
      ) : (
        <>
          {/* Original note - full content */}
          <div className="note-detail-original">
            {displayEvent.kind === 30023 ? (
              <div className="article-reader">
                <article className="reader-article">
                  {getArticleImage(displayEvent) && (
                    <div className="reader-cover">
                      <img src={getArticleImage(displayEvent)!} alt="" loading="lazy" />
                    </div>
                  )}
                  <h1 className="reader-title">{getArticleTitle(displayEvent)}</h1>
                  <div className="reader-meta">
                    <div className="reader-author">
                      <Avatar
                        picture={getProfile(displayEvent.pubkey)?.picture}
                        pubkey={displayEvent.pubkey}
                        className="reader-author-avatar"
                        fallbackClassName="reader-author-avatar reader-author-avatar-fallback"
                        clickable
                      />
                      <span className="reader-author-name">
                        {profileDisplayName(getProfile(displayEvent.pubkey), displayEvent.pubkey)}
                      </span>
                    </div>
                    <span className="reader-date">{formatDate(getArticleTimestamp(displayEvent))}</span>
                  </div>
                  <div className="reader-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayEvent.content) }} />
                </article>
              </div>
            ) : (
              <NoteCard
                event={displayEvent}
                profile={getProfile(displayEvent.pubkey)}
                full
              />
            )}
          </div>

          {/* Reactions */}
          {threadData && threadData.reactions.length === 0 && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">reactions</div>
              <div style={{ color: "var(--text-muted)", padding: "8px 0 0", fontSize: "0.85rem" }}>no reactions found.</div>
            </div>
          )}
          {threadData && threadData.reactions.length > 0 && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">reactions ({threadData.reactions.length})</div>
              <div className="note-detail-reaction-list">
                {Object.entries(reactionCounts).map(([emoji, count]) => (
                  <span key={emoji} className="note-detail-reaction-chip">
                    {emoji === "+" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    ) : emoji} {count}
                  </span>
                ))}
              </div>
              <div className="note-detail-reactors">
                {threadData.reactions.slice(0, 20).map((r) => {
                  const rProfile = getProfile(r.pubkey);
                  return (
                    <Avatar
                      key={r.id}
                      picture={rProfile?.picture ?? null}
                      pubkey={r.pubkey}
                      className="note-detail-reactor-avatar"
                      clickable
                    />
                  );
                })}
                {threadData.reactions.length > 20 && (
                  <span className="note-detail-more-reactors">+{threadData.reactions.length - 20}</span>
                )}
              </div>
            </div>
          )}

          {/* Zaps */}
          {threadData && threadData.zaps.length > 0 && (
            <div className="note-detail-zaps">
              <div className="note-detail-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {" "}zaps ({threadData.zaps.length}) · {formatSats(zapTotal)} sats
              </div>
              <div className="note-detail-zap-list">
                {threadData.zaps.slice(0, 20).map((zap) => {
                  const amount = parseZapAmount(zap);
                  const zapProfile = getProfile(zap.pubkey);
                  return (
                    <div key={zap.id} className="note-detail-zap-item">
                      <Avatar
                        picture={zapProfile?.picture ?? null}
                        pubkey={zap.pubkey}
                        className="note-detail-zap-avatar"
                        clickable
                      />
                      <span className="note-detail-zap-amount">{formatSats(amount)} sats</span>
                      <span className="note-detail-zap-time">{timeAgo(zap.created_at, false)}</span>
                    </div>
                  );
                })}
                {threadData.zaps.length > 20 && (
                  <span className="note-detail-more-reactors">+{threadData.zaps.length - 20} more</span>
                )}
              </div>
            </div>
          )}

          {/* Threaded Replies */}
          <div className="note-detail-replies">
            <div className="note-detail-section-title">
              replies ({threadData?.replies.length ?? 0})
            </div>

            {threadData && threadData.replies.length === 0 && (
              <div style={{ color: "var(--text-muted)", padding: "8px 0", fontSize: "0.85rem" }}>
                no replies found for this note.
              </div>
            )}

            {threadTree.map((node) => (
              <ThreadNodeCard
                key={node.event.id}
                node={node}
                wotPubkeys={wotPubkeys}
                navigate={navigate}
                getProfile={getProfile}
                showNonWot={showNonWot}
              />
            ))}

            {nonWotReplyCount > 0 && !showNonWot && (
              <button
                className="thread-show-non-wot"
                onClick={() => setShowNonWot(true)}
              >
                show {nonWotReplyCount} repl{nonWotReplyCount === 1 ? "y" : "ies"} from outside your web of trust
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
