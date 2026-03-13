import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { NoteCard } from "../components/NoteCard";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { useProfileContext } from "../context/ProfileContext";
import type { NostrEvent } from "../types/nostr";

export const NoteDetail: React.FC = () => {
  const { noteId } = useParams<{ noteId: string }>();
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();

  const [event, setEvent] = useState<NostrEvent | null>(null);
  const [replies, setReplies] = useState<NostrEvent[]>([]);
  const [reactions, setReactions] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [hasMoreReplies, setHasMoreReplies] = useState(true);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // Load the main event
  useEffect(() => {
    if (!noteId) return;
    setLoading(true);
    setReplies([]);
    setReactions([]);
    setHasMoreReplies(true);

    const load = async () => {
      try {
        const ev = await invoke<NostrEvent | null>("get_event", { id: noteId });
        setEvent(ev);
        if (ev) ensureProfiles([ev.pubkey]);
      } catch (e) {
        console.error("[note-detail] Failed to load event:", e);
      }

      // Load reactions
      try {
        const rxns = await invoke<NostrEvent[]>("get_note_reactions", { noteId });
        setReactions(rxns);
        if (rxns.length > 0) ensureProfiles(rxns.map((r) => r.pubkey));
      } catch (e) {
        console.error("[note-detail] Failed to load reactions:", e);
      }

      // Load initial replies
      try {
        const reps = await invoke<NostrEvent[]>("get_note_replies", { noteId, limit: 30 });
        setReplies(reps.sort((a, b) => b.created_at - a.created_at));
        if (reps.length > 0) ensureProfiles(reps.map((r) => r.pubkey));
        if (reps.length < 30) setHasMoreReplies(false);
      } catch (e) {
        console.error("[note-detail] Failed to load replies:", e);
      }

      setLoading(false);
    };

    load();
  }, [noteId, ensureProfiles]);

  // Load more replies
  const loadMoreReplies = useCallback(async () => {
    if (!noteId || repliesLoading || !hasMoreReplies || replies.length === 0) return;
    setRepliesLoading(true);
    try {
      const oldest = replies[replies.length - 1].created_at;
      const more = await invoke<NostrEvent[]>("get_note_replies", {
        noteId,
        until: oldest - 1,
        limit: 30,
      });
      if (more.length === 0) {
        setHasMoreReplies(false);
      } else {
        const sorted = more.sort((a, b) => b.created_at - a.created_at);
        setReplies((prev) => [...prev, ...sorted]);
        ensureProfiles(more.map((r) => r.pubkey));
        if (more.length < 30) setHasMoreReplies(false);
      }
    } catch (e) {
      console.error("[note-detail] Failed to load more replies:", e);
    } finally {
      setRepliesLoading(false);
    }
  }, [noteId, replies, repliesLoading, hasMoreReplies, ensureProfiles]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current || !hasMoreReplies) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreReplies();
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [loadMoreReplies, hasMoreReplies]);

  // Reaction summary
  const reactionCounts = reactions.reduce<Record<string, number>>((acc, r) => {
    const emoji = r.content || "+";
    acc[emoji] = (acc[emoji] || 0) + 1;
    return acc;
  }, {});

  if (!noteId) {
    return (
      <div className="screen-page">
        <EmptyState message="No note ID specified." />
      </div>
    );
  }

  return (
    <div className="screen-page note-detail-page">
      {/* Back button */}
      <div className="profile-back-row">
        <button className="btn btn-secondary profile-back-btn" onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          Back
        </button>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: 24 }}>Loading note...</div>
      ) : !event ? (
        <EmptyState message="Note not found." />
      ) : (
        <>
          {/* Original note - full content */}
          <div className="note-detail-original">
            <NoteCard
              event={event}
              profile={getProfile(event.pubkey)}
              full
            />
          </div>

          {/* Reactions */}
          {reactions.length === 0 && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">Reactions</div>
              <div style={{ color: "var(--text-muted)", padding: "8px 0 0", fontSize: "0.85rem" }}>No reactions found from your WoT.</div>
            </div>
          )}
          {reactions.length > 0 && (
            <div className="note-detail-reactions">
              <div className="note-detail-section-title">Reactions ({reactions.length})</div>
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
                {reactions.slice(0, 20).map((r) => {
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
                {reactions.length > 20 && (
                  <span className="note-detail-more-reactors">+{reactions.length - 20}</span>
                )}
              </div>
            </div>
          )}

          {/* Replies */}
          <div className="note-detail-replies">
            <div className="note-detail-section-title">Replies ({replies.length})</div>
            {replies.length === 0 && !repliesLoading && (
              <div style={{ color: "var(--text-muted)", padding: "8px 0", fontSize: "0.85rem" }}>No replies found from your WoT for this note.</div>
            )}
            {replies.map((reply) => (
              <NoteCard
                key={reply.id}
                event={reply}
                profile={getProfile(reply.pubkey)}
                onClick={() => navigate(`/note/${reply.id}`)}
              />
            ))}
            {hasMoreReplies && replies.length > 0 && (
              <div ref={sentinelRef} style={{ padding: 16, textAlign: "center" }}>
                {repliesLoading ? (
                  <span style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>Loading more replies...</span>
                ) : (
                  <button
                    className="btn btn-secondary"
                    onClick={loadMoreReplies}
                    style={{ fontSize: "0.82rem" }}
                  >
                    Load more replies
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
