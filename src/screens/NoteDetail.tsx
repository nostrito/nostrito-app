import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NoteCard } from "../components/NoteCard";
import { ZapModal } from "../components/ZapModal";
import { ComposeModal } from "../components/ComposeModal";
import { IconMessageCircle, IconRepeat, IconX } from "../components/Icon";
import { useCanWrite } from "../context/SigningContext";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { useProfileContext } from "../context/ProfileContext";
import { renderMarkdown } from "../utils/markdown";
import { getArticleTitle, getArticleImage, getArticleTimestamp } from "../components/ArticleCard";
import { formatDate, timeAgo } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { invalidateInteractionCounts } from "../hooks/useInteractionCounts";
import { markReacted } from "../hooks/useReactionStatus";
import { markReposted } from "../hooks/useRepostStatus";
import { useOnDemandFetch } from "../hooks/useOnDemandFetch";
import type { NostrEvent } from "../types/nostr";

// ── Thread fetch cache (module-level, survives re-renders) ──────
const threadFetchCache = new Map<string, number>(); // rootId → timestamp

function markThreadFetched(rootId: string): void {
  threadFetchCache.set(rootId, Date.now());
}

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
  const { fetchIfStale } = useOnDemandFetch();

  const [event, setEvent] = useState<NostrEvent | null>(null);
  const [threadData, setThreadData] = useState<ThreadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchingRelays, setFetchingRelays] = useState(false);
  const [relayFetchDone, setRelayFetchDone] = useState(false);
  const [wotDistances, setWotDistances] = useState<Record<string, number>>({});
  const [showNonWot, setShowNonWot] = useState(false);
  const [showNonWotReactions, setShowNonWotReactions] = useState(false);
  const [showNonWotZaps, setShowNonWotZaps] = useState(false);
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);
  const [showReplyModal, setShowReplyModal] = useState(false);
  const canWrite = useCanWrite();

  const handleLike = useCallback(async (event: NostrEvent) => {
    markReacted(event.id);
    try {
      await invoke("publish_reaction", { eventId: event.id, eventPubkey: event.pubkey });
      invalidateInteractionCounts([event.id]);
    } catch (err) {
      console.warn("[note-detail] Failed to publish reaction:", err);
    }
  }, []);

  const [repostConfirm, setRepostConfirm] = useState<NostrEvent | null>(null);
  const handleRepost = useCallback((event: NostrEvent) => {
    setRepostConfirm(event);
  }, []);
  const confirmRepost = useCallback(async () => {
    if (!repostConfirm) return;
    const ev = repostConfirm;
    setRepostConfirm(null);
    markReposted(ev.id);
    try {
      const eventJson = JSON.stringify({
        id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at,
        kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig,
      });
      await invoke("publish_repost", { eventId: ev.id, eventPubkey: ev.pubkey, eventJson });
      invalidateInteractionCounts([ev.id]);
    } catch (err) {
      console.warn("[note-detail] Failed to publish repost:", err);
    }
  }, [repostConfirm]);

  // Determine root ID for thread fetching
  const rootId = useMemo(() => {
    if (!event) return noteId ?? null;
    const root = findRootTag(event);
    return root ?? event.id;
  }, [event, noteId]);

  // Load the main event first, then thread data
  useEffect(() => {
    if (!noteId) return;
    console.log("[note-detail] loading noteId:", noteId);
    setLoading(true);
    setThreadData(null);
    setShowNonWot(false);
    setRelayFetchDone(false);

    const load = async () => {
      // Load the main event — show it immediately
      let mainEvent: NostrEvent | null = null;
      try {
        console.log("[note-detail] calling get_event...");
        mainEvent = await invoke<NostrEvent | null>("get_event", { id: noteId });
        console.log("[note-detail] get_event result:", mainEvent ? `kind=${mainEvent.kind}` : "null");
        setEvent(mainEvent);
        if (mainEvent) ensureProfiles([mainEvent.pubkey]);
      } catch (e) {
        console.error("[note-detail] Failed to load event:", e);
      }

      // If event not in local DB, fetch from relays
      if (!mainEvent) {
        console.log("[note-detail] event not found locally, fetching from relays...");
        try {
          await invoke("fetch_note_context_from_relays", { noteId });
          mainEvent = await invoke<NostrEvent | null>("get_event", { id: noteId });
          console.log("[note-detail] relay fetch result:", mainEvent ? `kind=${mainEvent.kind}` : "null");
          if (mainEvent) {
            setEvent(mainEvent);
            ensureProfiles([mainEvent.pubkey]);
          }
        } catch (e) {
          console.error("[note-detail] Relay fetch for missing event failed:", e);
        }
      }

      console.log("[note-detail] setLoading(false), displayEvent:", mainEvent ? "found" : "NOT FOUND");
      setLoading(false);

      // Determine root for thread fetch
      const effectiveRootId = mainEvent ? (findRootTag(mainEvent) ?? mainEvent.id) : noteId;

      // Load thread data + WoT distances in parallel (non-blocking)
      const threadPromise = invoke<ThreadData>("get_thread_events", { rootId: effectiveRootId })
        .then((data) => {
          setThreadData(data);
          const pubkeys = new Set<string>();
          if (data.root) pubkeys.add(data.root.pubkey);
          for (const r of data.replies) pubkeys.add(r.pubkey);
          for (const r of data.reactions) pubkeys.add(r.pubkey);
          for (const z of data.zaps) pubkeys.add(z.pubkey);
          if (pubkeys.size > 0) ensureProfiles(Array.from(pubkeys));
        })
        .catch((e) => console.error("[note-detail] Failed to load thread:", e));

      const wotPromise = invoke<Record<string, number>>("get_wot_hop_distances", { maxHops: 3 })
        .then((distances) => setWotDistances(distances))
        .catch((e) => console.error("[note-detail] Failed to load WoT distances:", e));

      await Promise.all([threadPromise, wotPromise]);

      // If not found locally, fetch from relays before showing "not found"
      if (!mainEvent) {
        setFetchingRelays(true);
        try {
          const count = await invoke<number>("fetch_thread_from_relays", { rootId: effectiveRootId, skipRoot: false });
          markThreadFetched(effectiveRootId);
          if (count > 0) {
            // Re-fetch the event and thread from local DB after relay fetch
            const fetched = await invoke<NostrEvent | null>("get_event", { id: noteId });
            setEvent(fetched);
            if (fetched) ensureProfiles([fetched.pubkey]);
            const freshRootId = fetched ? (findRootTag(fetched) ?? fetched.id) : effectiveRootId;
            const data = await invoke<ThreadData>("get_thread_events", { rootId: freshRootId });
            setThreadData(data);
            invalidateInteractionCounts();
          }
        } catch (e) {
          console.error("[note-detail] Relay fetch failed:", e);
        } finally {
          setFetchingRelays(false);
          setRelayFetchDone(true);
        }
      } else if (effectiveRootId) {
        // Already found locally — background relay fetch (rate-limited via fetchIfStale)
        let fetchFired = false;
        fetchIfStale(`thread:${effectiveRootId}`, () => {
          fetchFired = true;
          return invoke("fetch_thread_from_relays", {
            rootId: effectiveRootId,
            skipRoot: true,
          }).then(() => markThreadFetched(effectiveRootId)).finally(() => setRelayFetchDone(true));
        }, 30);
        if (!fetchFired) setRelayFetchDone(true);
      } else {
        setRelayFetchDone(true);
      }

      setLoading(false);
    };

    load();
  }, [noteId, ensureProfiles, fetchIfStale]);

  // Listen for thread-updated events from relay fetch
  useEffect(() => {
    if (!rootId) return;
    const unlisten = listen<string>("thread-updated", async (ev) => {
      if (ev.payload === rootId) {
        try {
          // Re-fetch the main event in case it was just fetched from relays
          if (!event && noteId) {
            const fetched = await invoke<NostrEvent | null>("get_event", { id: noteId });
            if (fetched) {
              setEvent(fetched);
              ensureProfiles([fetched.pubkey]);
            }
          }
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
  }, [rootId, noteId, event, ensureProfiles]);

  // Manual relay re-fetch
  const fetchFromRelays = useCallback(async () => {
    if (!rootId || fetchingRelays) return;
    setFetchingRelays(true);
    setRelayFetchDone(false);
    try {
      const count = await invoke<number>("fetch_thread_from_relays", {
        rootId,
        skipRoot: false,
      });
      if (count > 0) {
        const data = await invoke<ThreadData>("get_thread_events", { rootId });
        setThreadData(data);
        invalidateInteractionCounts();
      }
    } catch (e) {
      console.error("[note-detail] Relay fetch failed:", e);
    } finally {
      setFetchingRelays(false);
      setRelayFetchDone(true);
    }
  }, [rootId, fetchingRelays]);

  // Derived data
  const wotPubkeys = useMemo(() => new Set(Object.keys(wotDistances)), [wotDistances]);

  const threadTree = useMemo(() => {
    if (!threadData || !rootId) return [];
    return buildThreadTree(rootId, threadData.replies);
  }, [threadData, rootId]);

  const nonWotReplyCount = useMemo(() => {
    if (!threadData) return 0;
    return threadData.replies.filter((r) => !wotPubkeys.has(r.pubkey)).length;
  }, [threadData, wotPubkeys]);

  const { wotReactions, nonWotReactionCount } = useMemo(() => {
    if (!threadData) return { wotReactions: [], nonWotReactionCount: 0 };
    const wot = threadData.reactions.filter((r) => wotPubkeys.has(r.pubkey));
    return { wotReactions: wot, nonWotReactionCount: threadData.reactions.length - wot.length };
  }, [threadData, wotPubkeys]);

  const displayReactions = useMemo(() => {
    if (!threadData) return [];
    return showNonWotReactions ? threadData.reactions : wotReactions;
  }, [threadData, showNonWotReactions, wotReactions]);

  const displayReactionCounts = useMemo(() => {
    return displayReactions.reduce<Record<string, number>>((acc, r) => {
      const emoji = r.content || "+";
      acc[emoji] = (acc[emoji] || 0) + 1;
      return acc;
    }, {});
  }, [displayReactions]);

  const { wotZaps, nonWotZapCount } = useMemo(() => {
    if (!threadData) return { wotZaps: [], nonWotZapCount: 0 };
    const wot = threadData.zaps.filter((z) => wotPubkeys.has(z.pubkey));
    return { wotZaps: wot, nonWotZapCount: threadData.zaps.length - wot.length };
  }, [threadData, wotPubkeys]);

  const displayZaps = useMemo(() => {
    if (!threadData) return [];
    return showNonWotZaps ? threadData.zaps : wotZaps;
  }, [threadData, showNonWotZaps, wotZaps]);

  const displayZapTotal = useMemo(() => {
    return displayZaps.reduce((sum, z) => sum + parseZapAmount(z), 0);
  }, [displayZaps]);

  if (!noteId) {
    return (
      <div className="screen-page">
        <EmptyState message="no note ID specified." />
      </div>
    );
  }

  // Determine the display event (root event if available, otherwise the clicked event)
  const displayEvent = threadData?.root ?? event;
  console.log("[note-detail] render: noteId=", noteId?.slice(0, 12), "loading=", loading, "displayEvent=", displayEvent ? `kind=${displayEvent.kind}` : "null", "event=", event ? "yes" : "no", "threadData=", threadData ? "yes" : "no");

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

      {loading || fetchingRelays ? (
        <div style={{ color: "var(--text-muted)", padding: 24 }}>{fetchingRelays ? "fetching from relays..." : "loading note..."}</div>
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
                        pictureLocal={getProfile(displayEvent.pubkey)?.picture_local}
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
                onZap={setZapTarget}
                onLike={handleLike}
                onRepost={handleRepost}
              />
            )}
          </div>

          {canWrite && displayEvent && (
            <div className="note-detail-reply-row">
              <button className="note-detail-reply-btn" onClick={() => setShowReplyModal(true)}>
                <span className="icon"><IconMessageCircle /></span> reply to this note
              </button>
            </div>
          )}

          {/* Reactions */}
          {!threadData && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">reactions</div>
              <div style={{ color: "var(--text-muted)", padding: "8px 0 0", fontSize: "0.85rem" }}>loading...</div>
            </div>
          )}
          {threadData && threadData.reactions.length === 0 && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">reactions</div>
              <div style={{ color: "var(--text-muted)", padding: "8px 0 0", fontSize: "0.85rem" }}>no reactions found.</div>
            </div>
          )}
          {threadData && threadData.reactions.length > 0 && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">reactions ({displayReactions.length}{nonWotReactionCount > 0 && !showNonWotReactions ? ` of ${threadData.reactions.length}` : ""})</div>
              <div className="note-detail-reaction-list">
                {Object.entries(displayReactionCounts).map(([emoji, count]) => (
                  <span key={emoji} className="note-detail-reaction-chip">
                    {emoji === "+" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    ) : emoji} {count}
                  </span>
                ))}
              </div>
              <div className="note-detail-reactors">
                {displayReactions.slice(0, 20).map((r) => {
                  const rProfile = getProfile(r.pubkey);
                  return (
                    <Avatar
                      key={r.id}
                      picture={rProfile?.picture ?? null}
                      pictureLocal={rProfile?.picture_local ?? null}
                      pubkey={r.pubkey}
                      className="note-detail-reactor-avatar"
                      clickable
                    />
                  );
                })}
                {displayReactions.length > 20 && (
                  <span className="note-detail-more-reactors">+{displayReactions.length - 20}</span>
                )}
              </div>
              {nonWotReactionCount > 0 && !showNonWotReactions && (
                <button
                  className="thread-show-non-wot"
                  onClick={() => setShowNonWotReactions(true)}
                >
                  show {nonWotReactionCount} reaction{nonWotReactionCount === 1 ? "" : "s"} from outside your web of trust
                </button>
              )}
            </div>
          )}

          {/* Zaps */}
          {threadData && threadData.zaps.length > 0 && (
            <div className="note-detail-zaps">
              <div className="note-detail-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {" "}zaps ({displayZaps.length}{nonWotZapCount > 0 && !showNonWotZaps ? ` of ${threadData.zaps.length}` : ""}) · {formatSats(displayZapTotal)} sats
              </div>
              <div className="note-detail-zap-list">
                {displayZaps.slice(0, 20).map((zap) => {
                  const amount = parseZapAmount(zap);
                  const zapProfile = getProfile(zap.pubkey);
                  return (
                    <div key={zap.id} className="note-detail-zap-item">
                      <Avatar
                        picture={zapProfile?.picture ?? null}
                        pictureLocal={zapProfile?.picture_local ?? null}
                        pubkey={zap.pubkey}
                        className="note-detail-zap-avatar"
                        clickable
                      />
                      <span className="note-detail-zap-amount">{formatSats(amount)} sats</span>
                      <span className="note-detail-zap-time">{timeAgo(zap.created_at, false)}</span>
                    </div>
                  );
                })}
                {displayZaps.length > 20 && (
                  <span className="note-detail-more-reactors">+{displayZaps.length - 20} more</span>
                )}
              </div>
              {nonWotZapCount > 0 && !showNonWotZaps && (
                <button
                  className="thread-show-non-wot"
                  onClick={() => setShowNonWotZaps(true)}
                >
                  show {nonWotZapCount} zap{nonWotZapCount === 1 ? "" : "s"} from outside your web of trust
                </button>
              )}
            </div>
          )}

          {/* Threaded Replies */}
          <div className="note-detail-replies">
            <div className="note-detail-section-title">
              replies {threadData ? `(${threadData.replies.length})` : ""}
            </div>

            {!threadData && (
              <div style={{ color: "var(--text-muted)", padding: "8px 0", fontSize: "0.85rem" }}>
                loading...
              </div>
            )}
            {threadData && threadData.replies.length === 0 && !relayFetchDone && (
              <div style={{ color: "var(--text-muted)", padding: "8px 0", fontSize: "0.85rem" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" style={{ marginRight: 6, verticalAlign: "middle" }}><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                checking relays for replies...
              </div>
            )}
            {threadData && threadData.replies.length === 0 && relayFetchDone && (
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
      {zapTarget && (
        <ZapModal
          eventId={zapTarget.id}
          recipientPubkey={zapTarget.pubkey}
          recipientLud16={getProfile(zapTarget.pubkey)?.lud16 ?? null}
          onClose={() => setZapTarget(null)}
        />
      )}
      {showReplyModal && displayEvent && (
        <ComposeModal
          replyTo={displayEvent}
          replyToProfile={getProfile(displayEvent.pubkey)}
          onClose={() => {
            setShowReplyModal(false);
            if (rootId) {
              invoke<ThreadData>("get_thread_events", { rootId })
                .then((data) => {
                  setThreadData(data);
                  invalidateInteractionCounts();
                  const pubkeys = new Set<string>();
                  if (data.root) pubkeys.add(data.root.pubkey);
                  for (const r of data.replies) pubkeys.add(r.pubkey);
                  if (pubkeys.size > 0) ensureProfiles(Array.from(pubkeys));
                })
                .catch(() => {});
            }
          }}
        />
      )}
      {repostConfirm && (
        <div className="wallet-modal-overlay" onClick={() => setRepostConfirm(null)}>
          <div className="wallet-modal" onClick={(e) => e.stopPropagation()} style={{ width: 380 }}>
            <div className="wallet-modal-header">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="icon"><IconRepeat /></span>
                repost
              </span>
              <button className="wallet-modal-close" onClick={() => setRepostConfirm(null)}><IconX /></button>
            </div>
            <div className="wallet-modal-body">
              <p style={{ fontSize: "0.88rem", color: "var(--text-dim)", marginBottom: 12 }}>
                Repost this note by <strong style={{ color: "var(--text)" }}>{profileDisplayName(getProfile(repostConfirm.pubkey), repostConfirm.pubkey)}</strong>?
              </p>
              <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", borderLeft: "2px solid var(--border)", paddingLeft: 10, marginBottom: 16, maxHeight: 120, overflow: "hidden" }}>
                {repostConfirm.content.slice(0, 200)}{repostConfirm.content.length > 200 ? "\u2026" : ""}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="wallet-setup-connect-btn" style={{ background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)" }} onClick={() => setRepostConfirm(null)}>cancel</button>
                <button className="wallet-setup-connect-btn" onClick={confirmRepost}>repost</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
