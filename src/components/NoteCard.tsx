/** Shared note/repost card used in Feed and ProfileView */
import React from "react";
import { IconMessageCircle, IconRepeat, IconZap, IconBookmark } from "./Icon";
import { Avatar } from "./Avatar";
import { timeAgo } from "../utils/format";
import { kindLabel } from "../utils/ui";
import { renderMediaHtml, stripMediaUrls } from "../utils/media";
import { profileDisplayName, type ProfileInfo } from "../utils/profiles";
import type { NostrEvent } from "../types/nostr";

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

interface NoteCardProps {
  event: NostrEvent;
  profile?: ProfileInfo;
  compact?: boolean;
  onSave?: (event: NostrEvent) => void;
  saved?: boolean;
}

export const NoteCard: React.FC<NoteCardProps> = ({ event, profile, compact, onSave, saved }) => {
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
          {!compact && (
            <div className="ev-actions">
              <button className="ev-action"><span className="icon"><IconMessageCircle /></span> 0</button>
              <button className="ev-action"><span className="icon"><IconRepeat /></span> 0</button>
              <button className="ev-action"><span className="icon"><IconZap /></span> 0</button>
              {onSave && (
                <button
                  className={`ev-action${saved ? " ev-action-saved" : ""}`}
                  onClick={() => !saved && onSave(event)}
                  title={saved ? "Saved" : "Save to local DB"}
                >
                  <span className="icon"><IconBookmark /></span>{saved ? " Saved" : " Save"}
                </button>
              )}
            </div>
          )}
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
        {!compact && (
          <div className="ev-actions">
            <button className="ev-action"><span className="icon"><IconMessageCircle /></span> 0</button>
            <button className="ev-action"><span className="icon"><IconRepeat /></span> 0</button>
            <button className="ev-action"><span className="icon"><IconZap /></span> 0</button>
            {onSave && (
              <button
                className={`ev-action${saved ? " ev-action-saved" : ""}`}
                onClick={() => !saved && onSave(event)}
                title={saved ? "Saved" : "Save to local DB"}
              >
                <span className="icon"><IconBookmark /></span>{saved ? " Saved" : " Save"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
