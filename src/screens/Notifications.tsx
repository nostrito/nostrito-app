import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconHeart, IconRepeat, IconZap, IconMessageCircle } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { timeAgo } from "../utils/format";
import { profileDisplayName } from "../utils/profiles";
import { useProfileContext } from "../context/ProfileContext";
import type { NostrEvent } from "../types/nostr";

const NOTIF_LIMIT = 50;

/** Extract the referenced event ID from an event's e-tags */
function getReferencedEventId(event: NostrEvent): string | null {
  const eTags = event.tags.filter((t: string[]) => t[0] === "e");
  if (eTags.length === 0) return null;
  // Prefer the tag with marker "reply" or last e-tag
  const replyTag = eTags.find((t: string[]) => t.length >= 4 && t[3] === "reply");
  return replyTag ? replyTag[1] : eTags[eTags.length - 1][1];
}

function kindIcon(kind: number) {
  switch (kind) {
    case 1: return <IconMessageCircle />;
    case 7: return <IconHeart />;
    case 6: return <IconRepeat />;
    case 9735: return <IconZap />;
    default: return <IconMessageCircle />;
  }
}

function kindLabel(kind: number) {
  switch (kind) {
    case 1: return "replied to your note";
    case 7: return "liked your note";
    case 6: return "reposted your note";
    case 9735: return "zapped your note";
    default: return "mentioned you";
  }
}

function kindClass(kind: number) {
  switch (kind) {
    case 1: return "notif-reply";
    case 7: return "notif-like";
    case 6: return "notif-repost";
    case 9735: return "notif-zap";
    default: return "";
  }
}

export const Notifications: React.FC = () => {
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();

  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Mark last seen on mount
  useEffect(() => {
    localStorage.setItem("nostrito:notif-last-seen", String(Math.floor(Date.now() / 1000)));
  }, []);

  const loadNotifications = useCallback(async (until?: number) => {
    try {
      const result = await invoke<NostrEvent[]>("get_notifications", {
        until: until ?? null,
        limit: NOTIF_LIMIT,
      });

      // Ensure profiles for all authors
      const pubkeys = [...new Set(result.map((e) => e.pubkey))];
      if (pubkeys.length > 0) ensureProfiles(pubkeys);

      if (until) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const fresh = result.filter((e) => !seen.has(e.id));
          return [...prev, ...fresh];
        });
      } else {
        setEvents(result);
      }
      setHasMore(result.length >= NOTIF_LIMIT);
    } catch (err) {
      console.warn("[notifications] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [ensureProfiles]);

  // Initial load: show local data immediately, then fetch from relays
  useEffect(() => {
    loadNotifications();

    // Fetch fresh notifications from relays in the background
    setFetching(true);
    invoke("fetch_notifications_from_relays")
      .then((stored) => {
        if (typeof stored === "number" && stored > 0) {
          // Reload from DB with the new events
          loadNotifications();
        }
      })
      .catch((err) => console.warn("[notifications] relay fetch failed:", err))
      .finally(() => setFetching(false));
  }, [loadNotifications]);

  // Listen for notifications-updated event (from the fetch command)
  useEffect(() => {
    const unlisten = listen<number>("notifications-updated", (event) => {
      if (event.payload > 0) {
        loadNotifications();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [loadNotifications]);

  // Also refresh when sync completes a cycle
  useEffect(() => {
    const unlisten = listen("sync:tier_complete", (event: any) => {
      if (event.payload?.tier === 0) {
        // tier 0 = idle = full cycle done
        loadNotifications();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [loadNotifications]);

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && events.length > 0) {
          const oldest = Math.min(...events.map((e) => Number(e.created_at)));
          loadNotifications(oldest - 1);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [events, hasMore, loadNotifications]);

  if (loading && events.length === 0) {
    return (
      <div className="notifications-page">
        <div style={{ padding: 40, color: "var(--text-muted)", textAlign: "center" }}>loading notifications...</div>
      </div>
    );
  }

  if (!loading && events.length === 0) {
    return (
      <div className="notifications-page">
        <div style={{ padding: 40, color: "var(--text-muted)", textAlign: "center" }}>
          {fetching ? "fetching notifications from relays..." : "no notifications yet"}
        </div>
      </div>
    );
  }

  return (
    <div className="notifications-page">
      {fetching && (
        <div style={{ padding: "8px 16px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
          fetching from relays...
        </div>
      )}
      {events.map((event) => {
        const profile = getProfile(event.pubkey);
        const displayName = profileDisplayName(profile, event.pubkey);
        const refEventId = getReferencedEventId(event);

        return (
          <div
            key={event.id}
            className={`notification-item ${kindClass(event.kind)}`}
            onClick={() => {
              if (refEventId) navigate(`/note/${refEventId}`);
            }}
            style={{ cursor: refEventId ? "pointer" : undefined }}
          >
            <span className={`notif-icon ${kindClass(event.kind)}`}>
              {kindIcon(event.kind)}
            </span>
            <Avatar picture={profile?.picture} pictureLocal={profile?.picture_local} pubkey={event.pubkey} className="notif-avatar" clickable />
            <div className="notif-body">
              <span className="notif-author" data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>
                {displayName}
              </span>{" "}
              <span className="notif-action">{kindLabel(event.kind)}</span>
              {event.kind === 1 && event.content && (
                <div className="notif-preview">
                  {event.content.slice(0, 100)}{event.content.length > 100 ? "\u2026" : ""}
                </div>
              )}
              {event.kind === 7 && event.content && event.content !== "+" && (
                <span className="notif-reaction-emoji">{event.content}</span>
              )}
            </div>
            <span className="notif-time">{timeAgo(event.created_at, false)}</span>
          </div>
        );
      })}
      <div ref={sentinelRef} style={{ height: 1 }} />
    </div>
  );
};
