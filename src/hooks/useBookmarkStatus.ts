/** Batched "is bookmarked" hook.
 * Same pattern as useReactionStatus — collects event IDs from all
 * rendered NoteCards, debounces 100ms, then calls get_bookmarked_event_ids
 * in a single batch invoke.
 *
 * Bookmark status is private (NIP-51 encrypted) — never reveal it without a signing key.
 */
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSigningContext } from "../context/SigningContext";

// Module-level shared state for batching
const pendingIds = new Set<string>();
const cache = new Map<string, boolean>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let hasSigningKey = false;

function notifyListeners() {
  for (const cb of listeners) cb();
}

async function flush() {
  flushTimer = null;
  if (pendingIds.size === 0 || !hasSigningKey) return;

  const ids = Array.from(pendingIds);
  pendingIds.clear();

  // Only request IDs not already cached
  const toFetch = ids.filter((id) => !cache.has(id));
  if (toFetch.length === 0) return;

  try {
    const bookmarkedIds = await invoke<string[]>(
      "get_bookmarked_event_ids",
      { eventIds: toFetch },
    );

    const bookmarkedSet = new Set(bookmarkedIds);
    for (const id of toFetch) {
      cache.set(id, bookmarkedSet.has(id));
    }

    notifyListeners();
  } catch (e) {
    console.warn("[useBookmarkStatus] batch fetch failed:", e);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 100);
}

// Listen for bookmarks-synced event to invalidate cache
listen<number>("bookmarks-synced", () => {
  invalidateBookmarkStatus();
});

/** Returns whether the current user has bookmarked this event.
 *  Always returns false when no signing key is available — bookmark status is private. */
export function useBookmarkStatus(eventId: string): boolean {
  const { canWrite } = useSigningContext();
  const [, setTick] = useState(0);
  const idRef = useRef(eventId);
  idRef.current = eventId;

  // Sync module-level flag so flush() respects signing state
  hasSigningKey = canWrite;

  useEffect(() => {
    if (!canWrite) return;

    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);

    if (!cache.has(eventId)) {
      pendingIds.add(eventId);
      scheduleFlush();
    }

    return () => {
      listeners.delete(cb);
    };
  }, [eventId, canWrite]);

  if (!canWrite) return false;
  return cache.get(eventId) ?? false;
}

/** Mark an event as bookmarked (optimistic update). */
export function markBookmarked(eventId: string) {
  cache.set(eventId, true);
  notifyListeners();
}

/** Mark an event as not bookmarked (optimistic update). */
export function markUnbookmarked(eventId: string) {
  cache.set(eventId, false);
  notifyListeners();
}

/** Invalidate cache for specific IDs or all (e.g. after relay sync). */
export function invalidateBookmarkStatus(ids?: string[]) {
  if (ids) {
    for (const id of ids) cache.delete(id);
  } else {
    cache.clear();
  }
  // Re-fetch for any currently rendered components
  notifyListeners();
}
