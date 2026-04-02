/** Hook for managing bookmark lists (custom named collections).
 *  Provides CRUD operations and list data. */
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface BookmarkList {
  id: string;
  name: string;
  created_at: number;
  count: number;
}

// Module-level cache so all components share data
let listsCache: BookmarkList[] | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const cb of listeners) cb();
}

async function refreshLists() {
  try {
    listsCache = await invoke<BookmarkList[]>("get_bookmark_lists");
    notifyListeners();
  } catch (err) {
    console.warn("[bookmark-lists] fetch failed:", err);
  }
}

export function useBookmarkLists() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);
    if (listsCache === null) refreshLists();
    return () => { listeners.delete(cb); };
  }, []);

  const createList = useCallback(async (name: string): Promise<BookmarkList | null> => {
    try {
      const list = await invoke<BookmarkList>("create_bookmark_list", { name });
      await refreshLists();
      return list;
    } catch (err) {
      console.warn("[bookmark-lists] create failed:", err);
      return null;
    }
  }, []);

  const deleteList = useCallback(async (listId: string) => {
    try {
      await invoke<boolean>("delete_bookmark_list", { listId });
      await refreshLists();
    } catch (err) {
      console.warn("[bookmark-lists] delete failed:", err);
    }
  }, []);

  const renameList = useCallback(async (listId: string, name: string) => {
    try {
      await invoke<boolean>("rename_bookmark_list", { listId, name });
      await refreshLists();
    } catch (err) {
      console.warn("[bookmark-lists] rename failed:", err);
    }
  }, []);

  const toggleItem = useCallback(async (listId: string, eventId: string): Promise<boolean> => {
    try {
      const added = await invoke<boolean>("toggle_bookmark_list_item", { listId, eventId });
      await refreshLists();
      return added;
    } catch (err) {
      console.warn("[bookmark-lists] toggle failed:", err);
      return false;
    }
  }, []);

  return {
    lists: listsCache ?? [],
    createList,
    deleteList,
    renameList,
    toggleItem,
    refresh: refreshLists,
  };
}

/** Hook to check which bookmark lists contain a given event. */
export function useEventBookmarkLists(eventId: string) {
  const [listIds, setListIds] = useState<string[]>([]);

  useEffect(() => {
    invoke<string[]>("get_event_bookmark_lists", { eventId })
      .then(setListIds)
      .catch(() => setListIds([]));
  }, [eventId]);

  return listIds;
}
