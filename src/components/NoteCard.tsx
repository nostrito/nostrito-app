/** Shared note/repost card used in Feed and ProfileView */
import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconMessageCircle, IconRepeat, IconZap, IconHeart, IconHeartFilled } from "./Icon";
import { Avatar } from "./Avatar";
import { timeAgo } from "../utils/format";
import { kindLabel } from "../utils/ui";
import { renderMediaHtml, stripMediaUrls, type MediaContext } from "../utils/media";
import { profileDisplayName, type ProfileInfo } from "../utils/profiles";
import { extractMentionedPubkeys, replaceMentions, normalizeBareEntities, decodeEntity } from "../utils/mentions";
import { useProfileContext } from "../context/ProfileContext";
import { useSigningContext } from "../context/SigningContext";
import { useInteractionCounts } from "../hooks/useInteractionCounts";
import { useEnrichment } from "../hooks/useEnrichment";
import { useReactionStatus } from "../hooks/useReactionStatus";
import { useRepostStatus } from "../hooks/useRepostStatus";
// import { useBookmarkStatus, markBookmarked, markUnbookmarked } from "../hooks/useBookmarkStatus"; // TODO: NIP-51 bookmarks pending interop fixes
import type { NostrEvent } from "../types/nostr";

/** Hook to show a transient toast when user clicks a disabled action. */
function useActionToast() {
  const [message, setMessage] = useState<"signing" | "zap" | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((kind: "signing" | "zap") => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(kind);
    timerRef.current = setTimeout(() => setMessage(null), 4000);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { message, show };
}

const ActionToast: React.FC<{ message: "signing" | "zap" | null }> = ({ message }) => {
  if (!message) return null;
  return (
    <div className="signing-toast" onClick={(e) => e.stopPropagation()}>
      {message === "signing" ? (
        <>
          <strong>Signing not available</strong>
          <br />
          Add your nsec or connect a remote signer (bunker) in Settings.
          <br />
          <span style={{ color: "var(--text-muted)", fontSize: "0.74rem" }}>
            If you're using a remote signer, make sure it allows this type of event — some signing apps restrict which event kinds can be signed.
          </span>
        </>
      ) : (
        <>
          <strong>Wallet not configured</strong>
          <br />
          Zaps require a signing key and a connected wallet. Go to Settings to add your nsec and configure a wallet (NWC or LNbits).
          <br />
          <span style={{ color: "var(--text-muted)", fontSize: "0.74rem" }}>
            If you're using a remote signer, check that it allows kind 9734 (zap request) events.
          </span>
        </>
      )}
    </div>
  );
};

export function parseRepostContent(event: NostrEvent): { content: string; pubkey: string; id: string | null; created_at: number | null } | null {
  if (event.kind !== 6 || !event.content.trim()) return null;
  try {
    const original = JSON.parse(event.content);
    if (original && typeof original.content === "string" && original.content.trim()) {
      return {
        content: original.content,
        pubkey: original.pubkey || event.pubkey,
        id: typeof original.id === "string" ? original.id : null,
        created_at: typeof original.created_at === "number" ? original.created_at : null,
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/** Extract the original event ID from a kind:6 repost (from JSON content or "e" tag). */
export function getRepostOriginalId(event: NostrEvent): string | null {
  if (event.kind !== 6) return null;
  // Try JSON content first
  const parsed = parseRepostContent(event);
  if (parsed?.id) return parsed.id;
  // Fall back to "e" tag
  const eTag = event.tags.find((t) => t[0] === "e");
  return eTag?.[1] ?? null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Extract the parent event ID from a reply note's e-tags (NIP-10). */
function getReplyParentId(event: NostrEvent): string | null {
  if (event.kind !== 1) return null;
  const eTags = event.tags.filter((t) => t[0] === "e");
  if (eTags.length === 0) return null;
  const replyTag = eTags.find((t) => t[3] === "reply");
  if (replyTag) return replyTag[1];
  const rootTag = eTags.find((t) => t[3] === "root");
  if (rootTag && eTags.length === 1) return rootTag[1];
  return eTags[eTags.length - 1][1];
}

/** Extract the quoted event ID from a kind:1 note's q-tag (NIP-18 quote repost). */
function getQuotedEventId(event: NostrEvent): string | null {
  if (event.kind !== 1) return null;
  const qTag = event.tags.find((t) => t[0] === "q");
  if (qTag?.[1]) return qTag[1];
  // Fallback: if no q-tag, check for a lone nostr:note1/nevent1 that isn't a reply context
  // (some clients embed quotes without a q-tag)
  return null;
}

/** Strip the nostr: entity reference for the quoted note from displayed text. */
function stripQuotedEntity(content: string, quotedId: string): string {
  // Remove nostr:note1.../nostr:nevent1... that resolves to the quoted event ID
  return content.replace(
    /nostr:((note|nevent)1[a-z0-9]+)/g,
    (match, bech32str) => {
      const entity = decodeEntity(bech32str);
      if (entity?.eventId === quotedId) return "";
      return match;
    }
  ).trim();
}

/** Shows an embedded quoted note for quote reposts. */
const QuotedNote: React.FC<{ quotedId: string }> = ({ quotedId }) => {
  const [quoted, setQuoted] = useState<NostrEvent | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "not-found">("loading");
  const { getProfile, ensureProfiles } = useProfileContext();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ev = await invoke<NostrEvent | null>("get_event", { id: quotedId });
        if (cancelled) return;
        if (ev) {
          setQuoted(ev);
          setStatus("loaded");
          ensureProfiles([ev.pubkey]);
        } else {
          const fetched = await invoke<NostrEvent[]>("fetch_events_by_ids", { ids: [quotedId] });
          if (cancelled) return;
          if (fetched.length > 0) {
            setQuoted(fetched[0]);
            setStatus("loaded");
            ensureProfiles([fetched[0].pubkey]);
          } else {
            setStatus("not-found");
          }
        }
      } catch {
        if (!cancelled) setStatus("not-found");
      }
    })();
    return () => { cancelled = true; };
  }, [quotedId, ensureProfiles]);

  if (status === "loading") {
    return <div className="quoted-note quoted-note-loading">Loading quoted note...</div>;
  }
  if (status === "not-found" || !quoted) {
    return <div className="quoted-note quoted-note-missing">Quoted note not found</div>;
  }
  const profile = getProfile(quoted.pubkey);
  const name = profileDisplayName(profile, quoted.pubkey);
  const preview = quoted.content.slice(0, 200) + (quoted.content.length > 200 ? "\u2026" : "");
  return (
    <div className="quoted-note" data-note-id={quoted.id} style={{ cursor: "pointer" }}>
      <div className="quoted-note-header">
        <Avatar picture={profile?.picture} pictureLocal={profile?.picture_local} pubkey={quoted.pubkey} className="quoted-note-avatar" clickable />
        <span className="quoted-note-name" data-pubkey={quoted.pubkey} style={{ cursor: "pointer" }}>{name}</span>
        <span className="quoted-note-time">{timeAgo(quoted.created_at, false)}</span>
      </div>
      <div className="quoted-note-text">{preview}</div>
    </div>
  );
};

/** Shows parent note context for reply notes. */
const ReplyContext: React.FC<{ parentId: string }> = ({ parentId }) => {
  const [parent, setParent] = useState<NostrEvent | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "not-found">("loading");
  const { getProfile, ensureProfiles } = useProfileContext();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ev = await invoke<NostrEvent | null>("get_event", { id: parentId });
        if (cancelled) return;
        if (ev) {
          setParent(ev);
          setStatus("loaded");
          ensureProfiles([ev.pubkey]);
        } else {
          const fetched = await invoke<NostrEvent[]>("fetch_events_by_ids", { ids: [parentId] });
          if (cancelled) return;
          if (fetched.length > 0) {
            setParent(fetched[0]);
            setStatus("loaded");
            ensureProfiles([fetched[0].pubkey]);
          } else {
            setStatus("not-found");
          }
        }
      } catch {
        if (!cancelled) setStatus("not-found");
      }
    })();
    return () => { cancelled = true; };
  }, [parentId, ensureProfiles]);

  if (status === "loading") {
    return <div className="reply-context reply-context-loading">Loading parent note...</div>;
  }
  if (status === "not-found" || !parent) {
    return (
      <div className="reply-context reply-context-missing">
        <span className="reply-context-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
          Replying to a note (not found)
        </span>
      </div>
    );
  }
  const profile = getProfile(parent.pubkey);
  const name = profileDisplayName(profile, parent.pubkey);
  const preview = parent.content.slice(0, 120) + (parent.content.length > 120 ? "\u2026" : "");
  return (
    <div className="reply-context" data-note-id={parent.id} style={{ cursor: "pointer" }}>
      <span className="reply-context-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        Replying to <span data-pubkey={parent.pubkey} style={{ color: "var(--accent-light)", cursor: "pointer" }}>{name}</span>
      </span>
      <span className="reply-context-preview">{preview}</span>
    </div>
  );
};

function renderEventContent(
  content: string,
  mentionProfiles?: Map<string, ProfileInfo | undefined>,
  full?: boolean,
  mediaCtx?: MediaContext,
): { cleanedHtml: string; mediaHtml: string } {
  const mediaHtml = renderMediaHtml(content, mediaCtx);
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
    '$1<span class="hashtag" data-hashtag="$2" style="cursor:pointer">#$2</span>'
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
  onClick?: () => void;
  onZap?: (event: NostrEvent) => void;
  onLike?: (event: NostrEvent) => void;
  onReply?: (event: NostrEvent) => void;
  onRepost?: (event: NostrEvent) => void;
}

/** Grouped repost: multiple people reposted the same original note */
export interface GroupedRepost {
  originalId: string;
  reposters: NostrEvent[]; // the kind:6 events
  originalEvent: NostrEvent | null; // the fetched original, or null if not found
  status: "loading" | "loaded" | "not-found";
}

/** Card for grouped reposts — shows "A, B, and N others reposted" + the original note */
export const GroupedRepostCard: React.FC<{
  group: GroupedRepost;
  onClick?: () => void;
}> = ({ group, onClick }) => {
  const { ensureProfiles, getProfile } = useProfileContext();

  // Ensure reposter profiles
  useMemo(() => {
    const pks = group.reposters.map((e) => e.pubkey);
    if (group.originalEvent) pks.push(group.originalEvent.pubkey);
    ensureProfiles(pks);
  }, [group.reposters, group.originalEvent]);

  // Build reposter names
  const reposterNames = group.reposters.slice(0, 3).map((e) => {
    const p = getProfile(e.pubkey);
    return { pubkey: e.pubkey, name: profileDisplayName(p, e.pubkey) };
  });
  const othersCount = group.reposters.length - reposterNames.length;

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-pubkey]")) return;
    if ((e.target as HTMLElement).closest("[data-note-id]")) return;
    if ((e.target as HTMLElement).closest("[data-naddr]")) return;
    if ((e.target as HTMLElement).closest("[data-media-url]")) return;
    if ((e.target as HTMLElement).closest("[data-hashtag]")) return;
    if ((e.target as HTMLElement).closest("a")) return;
    onClick?.();
  };

  if (group.status === "loading") {
    return (
      <div className="event-card event-card-repost" data-kind="repost">
        <div className="repost-indicator">
          <span className="icon repost-indicator-icon"><IconRepeat /></span>
          <span className="repost-indicator-text">
            {reposterNames.map((r, i) => (
              <React.Fragment key={r.pubkey}>
                {i > 0 && ", "}
                <span data-pubkey={r.pubkey} style={{ cursor: "pointer" }}>{r.name}</span>
              </React.Fragment>
            ))}
            {othersCount > 0 && `, and ${othersCount} other${othersCount > 1 ? "s" : ""}`}
            {" reposted"}
          </span>
        </div>
        <div className="repost-original" style={{ padding: "12px 0 4px 52px", color: "var(--text-muted)", fontSize: "0.82rem" }}>
          Loading original note...
        </div>
      </div>
    );
  }

  if (group.status === "not-found" || !group.originalEvent) {
    return (
      <div className="event-card event-card-repost" data-kind="repost">
        <div className="repost-indicator">
          <span className="icon repost-indicator-icon"><IconRepeat /></span>
          <span className="repost-indicator-text">
            {reposterNames.map((r, i) => (
              <React.Fragment key={r.pubkey}>
                {i > 0 && ", "}
                <span data-pubkey={r.pubkey} style={{ cursor: "pointer" }}>{r.name}</span>
              </React.Fragment>
            ))}
            {othersCount > 0 && `, and ${othersCount} other${othersCount > 1 ? "s" : ""}`}
            {" reposted"}
          </span>
        </div>
        <div className="repost-original" style={{ padding: "12px 0 4px 52px", color: "var(--text-muted)", fontSize: "0.82rem" }}>
          Original note not found
        </div>
      </div>
    );
  }

  // Render the original note using NoteCard
  return (
    <div className="event-card event-card-repost" data-kind="repost" onClick={handleClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div className="repost-indicator">
        <span className="icon repost-indicator-icon"><IconRepeat /></span>
        <span className="repost-indicator-text">
          {reposterNames.map((r, i) => (
            <React.Fragment key={r.pubkey}>
              {i > 0 && ", "}
              <span data-pubkey={r.pubkey} style={{ cursor: "pointer" }}>{r.name}</span>
            </React.Fragment>
          ))}
          {othersCount > 0 && `, and ${othersCount} other${othersCount > 1 ? "s" : ""}`}
          {" reposted"}
        </span>
      </div>
      <NoteCardInner
        event={group.originalEvent}
        profile={getProfile(group.originalEvent.pubkey)}
      />
    </div>
  );
};

/** Inner note content (avatar + content) without the outer event-card wrapper, for embedding. */
const NoteCardInner: React.FC<{
  event: NostrEvent;
  profile?: ProfileInfo;
  compact?: boolean;
  full?: boolean;
  onLike?: (event: NostrEvent) => void;
  onZap?: (event: NostrEvent) => void;
  onReply?: (event: NostrEvent) => void;
  onRepost?: (event: NostrEvent) => void;
}> = ({ event, profile, compact, full, onLike, onZap, onReply, onRepost }) => {
  const { ensureProfiles, getProfile } = useProfileContext();
  const counts = useInteractionCounts(event.id);
  useEnrichment(event.id);
  const liked = useReactionStatus(event.id);
  const reposted = useRepostStatus(event.id);
  // const bookmarked = useBookmarkStatus(event.id); // TODO: NIP-51 bookmarks pending interop fixes
  const { canWrite } = useSigningContext();
  const toast = useActionToast();
  const displayName = profileDisplayName(profile, event.pubkey);

  const handleSigningClick = (e: React.MouseEvent) => { e.stopPropagation(); toast.show("signing"); };
  const handleZapClick = (e: React.MouseEvent) => { e.stopPropagation(); toast.show("zap"); };

  const mentionedPubkeys = useMemo(() => {
    const pks = extractMentionedPubkeys(event.content);
    if (pks.length > 0) ensureProfiles(pks);
    return pks;
  }, [event.content]);

  const mentionProfiles = useMemo(() => {
    const map = new Map<string, ProfileInfo | undefined>();
    for (const pk of mentionedPubkeys) {
      map.set(pk, getProfile(pk));
    }
    return map;
  }, [mentionedPubkeys, getProfile]);

  const eventContent = renderEventContent(event.content, mentionProfiles, full, { eventId: event.id, pubkey: event.pubkey });

  return (
    <div className="repost-original">
      <Avatar picture={profile?.picture} pictureLocal={profile?.picture_local} pubkey={event.pubkey} className="ev-avatar" clickable />
      <div className="ev-content">
        <div className="ev-meta">
          <span className="ev-npub" data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>
            {displayName}
          </span>
          <span className="ev-time">{timeAgo(event.created_at, false)}</span>
        </div>
        <div className="ev-text" dangerouslySetInnerHTML={{ __html: eventContent.cleanedHtml }} />
        {eventContent.mediaHtml && (
          <div dangerouslySetInnerHTML={{ __html: eventContent.mediaHtml }} />
        )}
        {!compact && (
          <div className="ev-actions" style={{ position: "relative" }}>
            <ActionToast message={toast.message} />
            <button className={`ev-action${!canWrite || !onReply ? " ev-action-disabled" : ""}`} onClick={canWrite && onReply ? (e) => { e.stopPropagation(); onReply(event); } : !canWrite ? handleSigningClick : undefined}><span className="icon"><IconMessageCircle /></span>{counts?.replies ? ` ${counts.replies}` : ""}</button>
            <button className={`ev-action${reposted ? " ev-action-reposted" : ""}${!canWrite || reposted || !onRepost ? " ev-action-disabled" : ""}`} onClick={canWrite && !reposted && onRepost ? (e) => { e.stopPropagation(); onRepost(event); } : !canWrite ? handleSigningClick : undefined}><span className="icon"><IconRepeat /></span>{counts?.reposts ? ` ${counts.reposts}` : ""}</button>
            <button className={`ev-action${liked ? " ev-action-liked" : ""}${!canWrite || liked ? " ev-action-disabled" : ""}`} onClick={canWrite && !liked ? (e) => { e.stopPropagation(); onLike?.(event); } : !canWrite && !liked ? handleSigningClick : undefined}><span className="icon">{liked ? <IconHeartFilled /> : <IconHeart />}</span>{counts?.reactions ? ` ${counts.reactions}` : ""}</button>
            <button className={`ev-action${!canWrite ? " ev-action-disabled" : ""}`} onClick={canWrite ? (e) => { e.stopPropagation(); onZap?.(event); } : handleZapClick}><span className="icon"><IconZap /></span>{counts?.zaps ? ` ${counts.zaps}` : ""}</button>
            {/* bookmark button disabled — TODO: NIP-51 bookmarks pending interop fixes */}
          </div>
        )}
      </div>
    </div>
  );
};

export const NoteCard: React.FC<NoteCardProps> = ({ event, profile, compact, full, onClick, onZap, onLike, onReply, onRepost }) => {
  const k = kindLabel(event.kind);
  const displayName = profileDisplayName(profile, event.pubkey);
  const { ensureProfiles, getProfile } = useProfileContext();
  const counts = useInteractionCounts(event.id);
  useEnrichment(event.id);
  const liked = useReactionStatus(event.id);
  const reposted = useRepostStatus(event.id);
  // const bookmarked = useBookmarkStatus(event.id); // TODO: NIP-51 bookmarks pending interop fixes
  const { canWrite } = useSigningContext();
  const toast = useActionToast();

  const handleSigningClick = (e: React.MouseEvent) => { e.stopPropagation(); toast.show("signing"); };
  const handleZapClick = (e: React.MouseEvent) => { e.stopPropagation(); toast.show("zap"); };

  // Extract and ensure profiles for mentioned pubkeys (+ original author for reposts)
  const mentionedPubkeys = useMemo(() => {
    const repost = event.kind === 6 ? parseRepostContent(event) : null;
    const content = repost ? repost.content : event.content;
    const pks = extractMentionedPubkeys(content);
    if (repost && repost.pubkey !== event.pubkey) pks.push(repost.pubkey);
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
    const originalProfile = getProfile(original.pubkey);
    const originalDisplayName = profileDisplayName(originalProfile, original.pubkey);
    const reposterDisplayName = displayName;
    const repostContent = renderEventContent(original.content, mentionProfiles, full, { eventId: original.id || event.id, pubkey: original.pubkey });

    const handleRepostClick = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-pubkey]")) return;
      if ((e.target as HTMLElement).closest("[data-note-id]")) return;
      if ((e.target as HTMLElement).closest("[data-naddr]")) return;
      if ((e.target as HTMLElement).closest("[data-media-url]")) return;
      if ((e.target as HTMLElement).closest("[data-hashtag]")) return;
      if ((e.target as HTMLElement).closest("a")) return;
      onClick?.();
    };

    return (
      <div className="event-card event-card-repost" data-kind={k.tag} onClick={handleRepostClick} style={onClick ? { cursor: "pointer" } : undefined}>
        <div className="repost-indicator">
          <span className="icon repost-indicator-icon"><IconRepeat /></span>
          <span className="repost-indicator-text">
            <span data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>{reposterDisplayName}</span>
            {" reposted"}
          </span>
        </div>
        <div className="repost-original">
          <Avatar picture={originalProfile?.picture} pictureLocal={originalProfile?.picture_local} pubkey={original.pubkey} className="ev-avatar" clickable />
          <div className="ev-content">
            <div className="ev-meta">
              <span className="ev-npub" data-pubkey={original.pubkey} style={{ cursor: "pointer" }}>
                {originalDisplayName}
              </span>
              <span className="ev-time">{timeAgo(original.created_at ?? event.created_at, false)}</span>
            </div>
            <div className="ev-text" dangerouslySetInnerHTML={{ __html: repostContent.cleanedHtml }} />
            {repostContent.mediaHtml && (
              <div dangerouslySetInnerHTML={{ __html: repostContent.mediaHtml }} />
            )}
            {!compact && (
              <div className="ev-actions" style={{ position: "relative" }}>
                <ActionToast message={toast.message} />
                <button className={`ev-action${!canWrite || !onReply ? " ev-action-disabled" : ""}`} onClick={canWrite && onReply ? (e) => { e.stopPropagation(); onReply(event); } : !canWrite ? handleSigningClick : undefined}><span className="icon"><IconMessageCircle /></span>{counts?.replies ? ` ${counts.replies}` : ""}</button>
                <button className={`ev-action${reposted ? " ev-action-reposted" : ""}${!canWrite || reposted || !onRepost ? " ev-action-disabled" : ""}`} onClick={canWrite && !reposted && onRepost ? (e) => { e.stopPropagation(); onRepost(event); } : !canWrite ? handleSigningClick : undefined}><span className="icon"><IconRepeat /></span>{counts?.reposts ? ` ${counts.reposts}` : ""}</button>
                <button className={`ev-action${liked ? " ev-action-liked" : ""}${!canWrite || liked ? " ev-action-disabled" : ""}`} onClick={canWrite && !liked ? (e) => { e.stopPropagation(); onLike?.(event); } : !canWrite && !liked ? handleSigningClick : undefined}><span className="icon">{liked ? <IconHeartFilled /> : <IconHeart />}</span>{counts?.reactions ? ` ${counts.reactions}` : ""}</button>
                <button className={`ev-action${!canWrite ? " ev-action-disabled" : ""}`} onClick={canWrite ? (e) => { e.stopPropagation(); onZap?.(event); } : handleZapClick}><span className="icon"><IconZap /></span>{counts?.zaps ? ` ${counts.zaps}` : ""}</button>
                {/* bookmark button disabled — TODO: NIP-51 bookmarks pending interop fixes */}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const replyParentId = useMemo(() => getReplyParentId(event), [event.id, event.tags]);
  const quotedEventId = useMemo(() => getQuotedEventId(event), [event.id, event.tags]);

  // For quote reposts, strip the embedded nostr: entity from displayed text
  const displayContent = useMemo(() => {
    if (quotedEventId) return stripQuotedEntity(event.content, quotedEventId);
    return event.content;
  }, [event.content, quotedEventId]);

  const eventContent = renderEventContent(displayContent, mentionProfiles, full, { eventId: event.id, pubkey: event.pubkey });

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-pubkey]")) { console.log("[notecard] click blocked: data-pubkey"); return; }
    if (target.closest("[data-note-id]")) { console.log("[notecard] click blocked: data-note-id"); return; }
    if (target.closest("[data-naddr]")) { console.log("[notecard] click blocked: data-naddr"); return; }
    if (target.closest("[data-media-url]")) { console.log("[notecard] click blocked: data-media-url"); return; }
    if (target.closest("a")) { console.log("[notecard] click blocked: anchor"); return; }
    if (target.closest(".ev-actions")) { console.log("[notecard] click blocked: ev-actions"); return; }
    console.log("[notecard] click → onClick(), event.id:", event.id.slice(0, 12), "target:", target.tagName, target.className);
    onClick?.();
  };

  const kindTag = quotedEventId ? "quote" : replyParentId ? "reply" : k.tag;
  const kindCls = quotedEventId ? "ev-kind-quote" : replyParentId ? "ev-kind-reply" : k.cls;

  return (
    <div className="event-card" data-kind={kindTag} onClick={handleClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <Avatar picture={profile?.picture} pictureLocal={profile?.picture_local} pubkey={event.pubkey} className="ev-avatar" clickable />
      <div className="ev-content">
        <div className="ev-meta">
          <span className="ev-npub" data-pubkey={event.pubkey} style={{ cursor: "pointer" }}>
            {displayName}
          </span>
          <span className={`ev-kind-tag ${kindCls}`}>{kindTag}</span>
          <span className="ev-time">{timeAgo(event.created_at, false)}</span>
        </div>
        {replyParentId && !quotedEventId && <ReplyContext parentId={replyParentId} />}
        <div className="ev-text" dangerouslySetInnerHTML={{ __html: eventContent.cleanedHtml }} />
        {eventContent.mediaHtml && (
          <div dangerouslySetInnerHTML={{ __html: eventContent.mediaHtml }} />
        )}
        {quotedEventId && <QuotedNote quotedId={quotedEventId} />}
        {!compact && (
          <div className="ev-actions" style={{ position: "relative" }}>
            <ActionToast message={toast.message} />
            <button className={`ev-action${!canWrite || !onReply ? " ev-action-disabled" : ""}`} onClick={canWrite && onReply ? (e) => { e.stopPropagation(); onReply(event); } : !canWrite ? handleSigningClick : undefined}><span className="icon"><IconMessageCircle /></span>{counts?.replies ? ` ${counts.replies}` : ""}</button>
            <button className={`ev-action${reposted ? " ev-action-reposted" : ""}${!canWrite || reposted || !onRepost ? " ev-action-disabled" : ""}`} onClick={canWrite && !reposted && onRepost ? (e) => { e.stopPropagation(); onRepost(event); } : !canWrite ? handleSigningClick : undefined}><span className="icon"><IconRepeat /></span>{counts?.reposts ? ` ${counts.reposts}` : ""}</button>
            <button className={`ev-action${liked ? " ev-action-liked" : ""}${!canWrite || liked ? " ev-action-disabled" : ""}`} onClick={canWrite && !liked ? (e) => { e.stopPropagation(); onLike?.(event); } : !canWrite && !liked ? handleSigningClick : undefined}><span className="icon">{liked ? <IconHeartFilled /> : <IconHeart />}</span>{counts?.reactions ? ` ${counts.reactions}` : ""}</button>
            <button className={`ev-action${!canWrite ? " ev-action-disabled" : ""}`} onClick={canWrite ? (e) => { e.stopPropagation(); onZap?.(event); } : handleZapClick}><span className="icon"><IconZap /></span>{counts?.zaps ? ` ${counts.zaps}` : ""}</button>
            {/* bookmark button disabled — TODO: NIP-51 bookmarks pending interop fixes */}
          </div>
        )}
      </div>
    </div>
  );
};
