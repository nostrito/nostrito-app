import React from "react";
import { NoteCard } from "./NoteCard";
import { Avatar } from "./Avatar";
import { timeAgo } from "../utils/format";
import { useProfileContext } from "../context/ProfileContext";
import { profileDisplayName } from "../utils/profiles";
import type { NostrEvent } from "../types/nostr";

export interface ThreadSummary {
  root_event: NostrEvent;
  wot_reply_count: number;
  total_reply_count: number;
  wot_replier_pubkeys: string[];
  latest_wot_reply: NostrEvent | null;
  latest_activity: number;
}

interface ThreadPreviewCardProps {
  summary: ThreadSummary;
  onClick: () => void;
}

export const ThreadPreviewCard: React.FC<ThreadPreviewCardProps> = ({ summary, onClick }) => {
  const { getProfile } = useProfileContext();
  const { root_event, wot_reply_count, total_reply_count, wot_replier_pubkeys, latest_wot_reply } = summary;

  return (
    <div className="thread-preview-card" onClick={onClick}>
      <div className="thread-preview-banner">
        <span className="thread-preview-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <span className="thread-preview-count">
          {wot_reply_count} wot repl{wot_reply_count === 1 ? "y" : "ies"}
          {total_reply_count > wot_reply_count && (
            <span className="thread-preview-total"> ({total_reply_count} total)</span>
          )}
        </span>
        <div className="thread-preview-avatars">
          {wot_replier_pubkeys.slice(0, 5).map((pk) => {
            const p = getProfile(pk);
            return (
              <Avatar
                key={pk}
                picture={p?.picture ?? null}
                pubkey={pk}
                className="thread-preview-avatar"
              />
            );
          })}
          {wot_replier_pubkeys.length > 5 && (
            <span className="thread-preview-more">+{wot_replier_pubkeys.length - 5}</span>
          )}
        </div>
      </div>

      <NoteCard
        event={root_event}
        profile={getProfile(root_event.pubkey)}
        compact
      />

      {latest_wot_reply && (
        <div className="thread-preview-reply">
          <div className="thread-preview-reply-meta">
            <Avatar
              picture={getProfile(latest_wot_reply.pubkey)?.picture ?? null}
              pubkey={latest_wot_reply.pubkey}
              className="thread-preview-reply-avatar"
            />
            <span className="thread-preview-reply-name">
              {profileDisplayName(getProfile(latest_wot_reply.pubkey), latest_wot_reply.pubkey)}
            </span>
            <span className="thread-preview-reply-time">{timeAgo(latest_wot_reply.created_at, false)}</span>
          </div>
          <div className="thread-preview-reply-content">
            {latest_wot_reply.content.length > 200
              ? latest_wot_reply.content.slice(0, 200) + "\u2026"
              : latest_wot_reply.content}
          </div>
        </div>
      )}
    </div>
  );
};
