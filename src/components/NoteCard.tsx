/** Shared note/repost card used in Feed and ProfileView */
import React, { useMemo } from "react";
import { IconMessageCircle, IconRepeat, IconZap, IconBookmark } from "./Icon";
import { Avatar } from "./Avatar";
import { timeAgo } from "../utils/format";
import { kindLabel } from "../utils/ui";
import { renderMediaHtml, stripMediaUrls } from "../utils/media";
import { profileDisplayName, type ProfileInfo } from "../utils/profiles";
import { extractMentionedPubkeys, replaceMentions, normalizeBareEntities } from "../utils/mentions";
import { useProfileContext } from "../context/ProfileContext";
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderEventContent(
  content: string,
  mentionProfiles?: Map<string, ProfileInfo | undefined>,
  full?: boolean,
): { cleanedHtml: string; mediaHtml: string } {
  const mediaHtml = renderMediaHtml(content);
  const stripped = stripMediaUrls(content);
  const normalized = normalizeBareEntities(stripped);
  const cleaned = full ? normalized : normalized.slice(0, 280);
  // Escape HTML first, then inject mention spans
  const escaped = escapeHtml(cleaned);
  let html = replaceMentions(escaped, mentionProfiles || new Map());

  // Auto-link bare URLs not already in href/src attributes
  html = html.replace(
    /(?<!href="|src=")(https?:\/\/[^\s<>"]+)/g,
    '<a class="md-link" href="$1" target="_blank" rel="noopener">$1</a>'
  );

  // Highlight hashtags (require letter after #, preceded by whitespace or tag-end)
  html = html.replace(
    /(^|[\s>])#([a-zA-Z]\w{0,49})\b/gm,
    '$1<span class="hashtag">#$2</span>'
  );

  // Convert newlines to <br>
  html = html.replace(/\n/g, '<br>');

  return { cleanedHtml: html, mediaHtml };
}

interface NoteCardProps {
  event: NostrEvent;
  profile?: ProfileInfo;
  compact?: boolean;
  full?: boolean;
  onSave?: (event: NostrEvent) => void;
  saved?: boolean;
  onClick?: () => void;
}

export const NoteCard: React.FC<NoteCardProps> = ({ event, profile, compact, full, onSave, saved, onClick }) => {
  const k = kindLabel(event.kind);
  const displayName = profileDisplayName(profile, event.pubkey);
  const { ensureProfiles, getProfile } = useProfileContext();

  // Extract and ensure profiles for mentioned pubkeys
  const mentionedPubkeys = useMemo(() => {
    const content = event.kind === 6 ? (parseRepostContent(event)?.content || "") : event.content;
    const pks = extractMentionedPubkeys(content);
    if (pks.length > 0) ensureProfiles(pks);
    return pks;
  }, [event.content, event.kind]);

  // Build profile map for mentions
  const mentionProfiles = useMemo(() => {
    const map = new Map<string, ProfileInfo | undefined>();
    for (const pk of mentionedPubkeys) {
      map.set(pk, getProfile(pk));
    }
    return map;
  }, [mentionedPubkeys, getProfile]);

  if (event.kind === 6) {
    const original = parseRepostContent(event);
    if (!original) return null;
    const repostContent = renderEventContent(original.content, mentionProfiles, full);

    const handleRepostClick = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-pubkey]")) return;
      if ((e.target as HTMLElement).closest("[data-note-id]")) return;
      if ((e.target as HTMLElement).closest("[data-naddr]")) return;
      if ((e.target as HTMLElement).closest("[data-media-url]")) return;
      if ((e.target as HTMLElement).closest("a")) return;
      onClick?.();
    };

    return (
      <div className="event-card" data-kind={k.tag} onClick={handleRepostClick} style={onClick ? { cursor: "pointer" } : undefined}>
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
          <div className="ev-text" dangerouslySetInnerHTML={{ __html: repostContent.cleanedHtml }} />
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

  const eventContent = renderEventContent(event.content, mentionProfiles, full);

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-pubkey]")) return;
    if ((e.target as HTMLElement).closest("[data-note-id]")) return;
    if ((e.target as HTMLElement).closest("[data-naddr]")) return;
    if ((e.target as HTMLElement).closest("[data-media-url]")) return;
    if ((e.target as HTMLElement).closest("a")) return;
    if ((e.target as HTMLElement).closest(".ev-actions")) return;
    onClick?.();
  };

  return (
    <div className="event-card" data-kind={k.tag} onClick={handleClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <Avatar picture={profile?.picture} pubkey={event.pubkey} className="ev-avatar" clickable />
      <div className="ev-content">
        <div className="ev-meta">
          <span className="ev-npub" data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>
            {displayName}
          </span>
          <span className={`ev-kind-tag ${k.cls}`}>{k.tag}</span>
          <span className="ev-time">{timeAgo(event.created_at, false)}</span>
        </div>
        <div className="ev-text" dangerouslySetInnerHTML={{ __html: eventContent.cleanedHtml }} />
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
