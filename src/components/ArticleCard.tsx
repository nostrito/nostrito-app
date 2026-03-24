/** Shared article card for NIP-23 long-form content */
import React from "react";
import { Avatar } from "./Avatar";
import { IconMessageCircle, IconRepeat, IconHeart, IconZap } from "./Icon";
import { formatDate } from "../utils/format";
import { profileDisplayName, type ProfileInfo } from "../utils/profiles";
import { useInteractionCounts } from "../hooks/useInteractionCounts";
import type { NostrEvent } from "../types/nostr";

export function getTagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag && tag.length > 1 ? tag[1] : null;
}

export function getArticleTitle(event: NostrEvent): string {
  return getTagValue(event.tags, "title") || "Untitled";
}

export function getArticleSummary(event: NostrEvent): string {
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

export function getArticleImage(event: NostrEvent): string | null {
  return getTagValue(event.tags, "image");
}

export function getArticleTimestamp(event: NostrEvent): number {
  const published = getTagValue(event.tags, "published_at");
  if (published) {
    const ts = parseInt(published, 10);
    if (!isNaN(ts)) return ts;
  }
  return event.created_at;
}

interface ArticleCardProps {
  event: NostrEvent;
  profile?: ProfileInfo;
  onClick?: () => void;
}

export const ArticleCard: React.FC<ArticleCardProps> = ({ event, profile, onClick }) => {
  const title = getArticleTitle(event);
  const summary = getArticleSummary(event);
  const image = getArticleImage(event);
  const ts = getArticleTimestamp(event);
  const displayName = profileDisplayName(profile, event.pubkey);
  const counts = useInteractionCounts(event.id);

  return (
    <div
      className="article-card"
      data-kind="long-form"
      data-event-id={event.id}
      data-note-id={event.id}
      onClick={(e) => {
        // Don't open reader when clicking author (let profile navigation handle it)
        if ((e.target as HTMLElement).closest("[data-pubkey]")) return;
        onClick?.();
      }}
    >
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
              pictureLocal={profile?.picture_local}
              pubkey={event.pubkey}
              className="article-card-avatar"
              fallbackClassName="article-card-avatar article-card-avatar-fallback"
              clickable
            />
            <span
              className="article-card-author-name"
              data-pubkey={event.pubkey}
              style={{ cursor: "pointer" }}
            >
              {displayName}
            </span>
          </div>
          <span className="article-card-date">{formatDate(ts)}</span>
        </div>
        <div className="article-card-counts">
          <span className="article-count"><span className="icon"><IconMessageCircle /></span> {counts?.replies || 0}</span>
          <span className="article-count"><span className="icon"><IconRepeat /></span> {counts?.reposts || 0}</span>
          <span className="article-count"><span className="icon"><IconHeart /></span> {counts?.reactions || 0}</span>
          <span className="article-count"><span className="icon"><IconZap /></span> {counts?.zaps || 0}</span>
        </div>
      </div>
    </div>
  );
};
