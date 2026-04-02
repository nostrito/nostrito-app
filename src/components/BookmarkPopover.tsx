/** Bookmark popover — shown on bookmark button click.
 *  Primary bookmark toggle + custom bookmark lists + create new list. */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconBookmark, IconBookmarkFilled, IconX } from "./Icon";
import { useBookmarkStatus, markBookmarked, markUnbookmarked } from "../hooks/useBookmarkStatus";
import { useBookmarkLists, useEventBookmarkLists } from "../hooks/useBookmarkLists";
import { useSigningContext } from "../context/SigningContext";
import type { NostrEvent } from "../types/nostr";

interface BookmarkPopoverProps {
  event: NostrEvent;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

export const BookmarkPopover: React.FC<BookmarkPopoverProps> = ({ event, onClose, anchorRect }) => {
  const bookmarked = useBookmarkStatus(event.id);
  const { canWrite } = useSigningContext();
  const { lists, createList, toggleItem } = useBookmarkLists();
  const eventListIds = useEventBookmarkLists(event.id);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [toggling, setToggling] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Focus input when creating
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const handlePrimaryToggle = useCallback(async () => {
    if (toggling || !canWrite) return;
    setToggling(true);
    try {
      const nowBookmarked = await invoke<boolean>("toggle_bookmark", { eventId: event.id });
      if (nowBookmarked) markBookmarked(event.id);
      else markUnbookmarked(event.id);
    } catch (err) {
      console.warn("[bookmark] toggle failed:", err);
    }
    setToggling(false);
  }, [event.id, canWrite, toggling]);

  const handleListToggle = useCallback(async (listId: string) => {
    await toggleItem(listId, event.id);
  }, [event.id, toggleItem]);

  const handleCreateList = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const list = await createList(name);
    if (list) {
      await toggleItem(list.id, event.id);
    }
    setNewName("");
    setCreating(false);
  }, [newName, createList, toggleItem, event.id]);

  // Position the popover
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = "fixed";
    style.left = anchorRect.left;
    style.top = anchorRect.bottom + 6;
    // Prevent going off-screen right
    if (anchorRect.left + 240 > window.innerWidth) {
      style.left = window.innerWidth - 248;
    }
    // Prevent going off-screen bottom
    if (anchorRect.bottom + 300 > window.innerHeight) {
      style.top = anchorRect.top - 6;
      style.transform = "translateY(-100%)";
    }
  }

  return (
    <div className="bk-popover" ref={popoverRef} style={style} onClick={(e) => e.stopPropagation()}>
      <div className="bk-popover-header">
        <span>bookmark</span>
        <button className="bk-popover-close" onClick={onClose}>
          <span className="icon"><IconX /></span>
        </button>
      </div>

      {/* Primary bookmark toggle */}
      <button
        className={`bk-popover-primary${bookmarked ? " active" : ""}`}
        onClick={handlePrimaryToggle}
        disabled={toggling}
      >
        <span className="icon">
          {bookmarked ? <IconBookmarkFilled /> : <IconBookmark />}
        </span>
        <span>{bookmarked ? "remove bookmark" : "add bookmark"}</span>
      </button>

      {/* Bookmark lists */}
      {lists.length > 0 && (
        <div className="bk-popover-lists">
          <div className="bk-popover-section-title">lists</div>
          {lists.map((list) => {
            const inList = eventListIds.includes(list.id);
            return (
              <button
                key={list.id}
                className={`bk-popover-list-item${inList ? " active" : ""}`}
                onClick={() => handleListToggle(list.id)}
              >
                <span className="bk-list-check">{inList ? "\u2713" : ""}</span>
                <span className="bk-list-name">{list.name}</span>
                <span className="bk-list-count">{list.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Create new list */}
      {creating ? (
        <div className="bk-popover-create">
          <input
            ref={inputRef}
            className="bk-popover-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateList(); if (e.key === "Escape") setCreating(false); }}
            placeholder="list name..."
            maxLength={64}
          />
          <button className="bk-popover-create-btn" onClick={handleCreateList} disabled={!newName.trim()}>
            create
          </button>
        </div>
      ) : (
        <button className="bk-popover-new-list" onClick={() => setCreating(true)}>
          + new list
        </button>
      )}
    </div>
  );
};
