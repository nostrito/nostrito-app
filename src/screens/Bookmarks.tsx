/** Bookmarks — shows all bookmarked notes with list tabs.
 *  Inspired by noStrudel's bookmark views with per-item remove and named lists. */

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
import { markUnbookmarked } from "../hooks/useBookmarkStatus";
import { useBookmarkLists } from "../hooks/useBookmarkLists";
import { initMediaViewer } from "../utils/media";
import { IconTrash, IconX } from "../components/Icon";
import type { NostrEvent } from "../types/nostr";

type ActiveTab = "all" | string; // "all" = primary bookmarks, string = list id

export const Bookmarks: React.FC = () => {
  const navigate = useNavigate();
  const { ensureProfiles, getProfile } = useProfileContext();
  const { canWrite } = useSigningContext();
  const { lists, createList, deleteList, renameList } = useBookmarkLists();

  const [activeTab, setActiveTab] = useState<ActiveTab>("all");
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [zapTarget, setZapTarget] = useState<NostrEvent | null>(null);
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const loadingRef = useRef(false);
  const newListInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { initMediaViewer(); }, []);

  // Focus inputs
  useEffect(() => { if (creatingList) newListInputRef.current?.focus(); }, [creatingList]);
  useEffect(() => { if (editingListId) editInputRef.current?.focus(); }, [editingListId]);

  const loadEvents = useCallback(async (tab: ActiveTab) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      let result: NostrEvent[];
      if (tab === "all") {
        result = await invoke<NostrEvent[]>("get_bookmarks_feed", { limit: 100 });
      } else {
        result = await invoke<NostrEvent[]>("get_bookmark_list_feed", { listId: tab, limit: 100 });
      }
      setEvents(result);
      if (result.length > 0) {
        ensureProfiles([...new Set(result.map((e) => e.pubkey))]);
      }
    } catch (err) {
      console.warn("[bookmarks] load failed:", err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [ensureProfiles]);

  // Sync + load on mount / tab change
  const didSyncRef = useRef(false);
  useEffect(() => {
    if (!canWrite) { setLoading(false); return; }
    if (!didSyncRef.current && activeTab === "all") {
      didSyncRef.current = true;
      (async () => {
        try { await invoke<number>("sync_bookmarks_from_relays"); } catch {}
        try {
          const missing = await invoke<string[]>("get_missing_bookmarked_event_ids");
          if (missing.length > 0) await invoke("fetch_events_by_ids", { ids: missing });
        } catch {}
        loadEvents(activeTab);
      })();
    } else {
      loadEvents(activeTab);
    }
  }, [activeTab, loadEvents, canWrite]);

  const handleRemoveBookmark = useCallback(async (event: NostrEvent) => {
    if (activeTab === "all") {
      try {
        await invoke<boolean>("toggle_bookmark", { eventId: event.id });
        markUnbookmarked(event.id);
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
      } catch (err) { console.warn("[bookmarks] remove failed:", err); }
    } else {
      try {
        await invoke<boolean>("toggle_bookmark_list_item", { listId: activeTab, eventId: event.id });
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
      } catch (err) { console.warn("[bookmarks] remove from list failed:", err); }
    }
  }, [activeTab]);

  const handleLike = useCallback(async (event: NostrEvent) => {
    try {
      await invoke("publish_reaction", { eventId: event.id, eventPubkey: event.pubkey });
      markReacted(event.id);
    } catch {}
  }, []);

  const handleRepost = useCallback(async (event: NostrEvent) => {
    try {
      await invoke("publish_repost", {
        eventId: event.id, eventPubkey: event.pubkey,
        eventJson: JSON.stringify(event),
      });
      markReposted(event.id);
    } catch {}
  }, []);

  const handleCreateList = useCallback(async () => {
    const name = newListName.trim();
    if (!name) return;
    const list = await createList(name);
    if (list) setActiveTab(list.id);
    setNewListName("");
    setCreatingList(false);
  }, [newListName, createList]);

  const handleRenameList = useCallback(async () => {
    if (!editingListId || !editName.trim()) return;
    await renameList(editingListId, editName.trim());
    setEditingListId(null);
    setEditName("");
  }, [editingListId, editName, renameList]);

  const handleDeleteList = useCallback(async (listId: string) => {
    if (!confirm("Delete this bookmark list?")) return;
    await deleteList(listId);
    if (activeTab === listId) setActiveTab("all");
  }, [activeTab, deleteList]);

  const activeListName = activeTab === "all"
    ? "all bookmarks"
    : lists.find((l) => l.id === activeTab)?.name ?? "list";

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
      ) : (
        <>
          {/* Tab bar */}
          <div className="bk-tabs">
            <button
              className={`bk-tab${activeTab === "all" ? " active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              all
            </button>
            {lists.map((list) => (
              <button
                key={list.id}
                className={`bk-tab${activeTab === list.id ? " active" : ""}`}
                onClick={() => setActiveTab(list.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setEditingListId(list.id);
                  setEditName(list.name);
                }}
              >
                {list.name}
                {list.count > 0 && <span className="bk-tab-count">{list.count}</span>}
              </button>
            ))}
            {creatingList ? (
              <div className="bk-tab-create">
                <input
                  ref={newListInputRef}
                  className="bk-tab-input"
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateList(); if (e.key === "Escape") setCreatingList(false); }}
                  placeholder="list name..."
                  maxLength={64}
                />
              </div>
            ) : (
              <button className="bk-tab bk-tab-add" onClick={() => setCreatingList(true)}>+</button>
            )}
          </div>

          {/* List management bar (when viewing a custom list) */}
          {activeTab !== "all" && (
            <div className="bk-list-bar">
              {editingListId === activeTab ? (
                <div className="bk-list-edit">
                  <input
                    ref={editInputRef}
                    className="bk-tab-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRenameList(); if (e.key === "Escape") setEditingListId(null); }}
                    maxLength={64}
                  />
                  <button className="bk-list-edit-save" onClick={handleRenameList}>save</button>
                </div>
              ) : (
                <div className="bk-list-actions">
                  <button className="bk-list-action" onClick={() => { setEditingListId(activeTab); setEditName(activeListName); }}>
                    rename
                  </button>
                  <button className="bk-list-action bk-list-action-danger" onClick={() => handleDeleteList(activeTab)}>
                    <span className="icon"><IconTrash /></span> delete list
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Notes list */}
          {loading ? (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)" }}>
              loading bookmarks...
            </div>
          ) : events.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)" }}>
              <p>No bookmarks{activeTab !== "all" ? ` in "${activeListName}"` : ""} yet.</p>
              <p style={{ fontSize: "0.82rem", marginTop: 8 }}>
                {activeTab === "all"
                  ? "Bookmark notes from any feed using the bookmark icon in the action bar."
                  : "Add notes to this list from the bookmark popover on any note."}
              </p>
            </div>
          ) : (
            <div className="bookmarks-list">
              {events.map((event) => (
                <div key={event.id} className="bk-note-row">
                  <NoteCard
                    event={event}
                    profile={getProfile(event.pubkey)}
                    onClick={() => navigate(`/note/${event.id}`)}
                    onZap={setZapTarget}
                    onLike={handleLike}
                    onReply={setReplyTarget}
                    onRepost={handleRepost}
                  />
                  <button
                    className="bk-remove-btn"
                    onClick={() => handleRemoveBookmark(event)}
                    title="remove from this list"
                  >
                    <span className="icon"><IconX /></span>
                  </button>
                </div>
              ))}
            </div>
          )}
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
