/** Bookmarks — shows all bookmarked notes (NIP-51 private bookmarks).
 *  On mount: publish local bookmarks to relays, then sync from relays — fully automatic. */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { NoteCard } from "../components/NoteCard";
import { ZapModal } from "../components/ZapModal";
import { ComposeModal } from "../components/ComposeModal";
import { useProfileContext } from "../context/ProfileContext";
import { useSigningContext } from "../context/SigningContext";
import { markReacted } from "../hooks/useReactionStatus";
import { markReposted } from "../hooks/useRepostStatus";
import { initMediaViewer } from "../utils/media";
import type { NostrEvent } from "../types/nostr";

export const Bookmarks: React.FC = () => {
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();
  const { canWrite } = useSigningContext();

  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    initMediaViewer();
  }, []);

  const loadBookmarks = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const result = await invoke<NostrEvent[]>("get_bookmarks_feed", { limit: 100 });
      setEvents(result);
      if (result.length > 0) {
        const pubkeys = [...new Set(result.map((e) => e.pubkey))];
        ensureProfiles(pubkeys);
      }
    } catch (err) {
      console.warn("[bookmarks] Failed to load:", err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [ensureProfiles]);

  // Auto publish + sync on mount (only with key)
  const didSyncRef = useRef(false);
  useEffect(() => {
    if (!canWrite) {
      setLoading(false);
      return;
    }
    loadBookmarks().then(async () => {
      if (didSyncRef.current) return;
      didSyncRef.current = true;
      // Publish local bookmarks to relays first, then sync back
      try {
        await invoke<string>("publish_bookmarks_to_relays");
      } catch (err) {
        console.warn("[bookmarks] Auto-publish failed:", err);
      }
      try {
        const count = await invoke<number>("sync_bookmarks_from_relays");
        if (count > 0) loadBookmarks();
      } catch (err) {
        console.warn("[bookmarks] Auto-sync failed:", err);
      }
    });
  }, [loadBookmarks, canWrite]);

  const handleLike = useCallback(async (event: NostrEvent) => {
    try {
      await invoke("publish_reaction", { eventId: event.id, eventPubkey: event.pubkey });
      markReacted(event.id);
    } catch (err) {
      console.warn("[bookmarks] Like failed:", err);
    }
  }, []);

  const handleRepost = useCallback(async (event: NostrEvent) => {
    try {
      await invoke("publish_repost", {
        eventId: event.id,
        eventPubkey: event.pubkey,
        eventJson: JSON.stringify(event),
      });
      markReposted(event.id);
    } catch (err) {
      console.warn("[bookmarks] Repost failed:", err);
    }
  }, []);

  return (
    <div className="bookmarks-screen">
      <div className="bookmarks-header">
        <h2 className="bookmarks-title">bookmarks</h2>
      </div>

      {!canWrite ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)" }}>
          <p>Private bookmarks are encrypted.</p>
          <p style={{ fontSize: "0.82rem", marginTop: 8 }}>
            Set up your signing key in settings to view and manage bookmarks.
          </p>
        </div>
      ) : loading ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)" }}>
          Loading bookmarks...
        </div>
      ) : events.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)" }}>
          <p>No bookmarks yet.</p>
          <p style={{ fontSize: "0.82rem", marginTop: 8 }}>
            Bookmark notes from any feed using the bookmark icon in the action bar.
          </p>
        </div>
      ) : (
        <div className="bookmarks-list">
          {events.map((event) => (
            <NoteCard
              key={event.id}
              event={event}
              profile={getProfile(event.pubkey)}
              onClick={() => navigate(`/note/${event.id}`)}
              onZap={setZapTarget}
              onLike={handleLike}
              onReply={setReplyTarget}
              onRepost={handleRepost}
            />
          ))}
        </div>
      )}

      {zapTarget && (
        <ZapModal
          eventId={zapTarget.id}
          recipientPubkey={zapTarget.pubkey}
          recipientLud16={getProfile(zapTarget.pubkey)?.lud16 ?? null}
          onClose={() => setZapTarget(null)}
        />
      )}
      {replyTarget && (
        <ComposeModal
          replyTo={replyTarget}
          onClose={() => setReplyTarget(null)}
          onPublished={() => setReplyTarget(null)}
        />
      )}
    </div>
  );
};
