/** Batched "has user reacted" hook.
 * Same pattern as useInteractionCounts — collects event IDs from all
 * rendered NoteCards, debounces 100ms, then calls get_reacted_event_ids
 * in a single batch invoke.
 */
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// Module-level shared state for batching
const pendingIds = new Set<string>();
const cache = new Map<string, boolean>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notifyListeners() {
  for (const cb of listeners) cb();
}

async function flush() {
  flushTimer = null;
  if (pendingIds.size === 0) return;

  const ids = Array.from(pendingIds);
  pendingIds.clear();

  // Only request IDs not already cached
  const toFetch = ids.filter((id) => !cache.has(id));
  if (toFetch.length === 0) return;

  try {
    const reactedIds = await invoke<string[]>(
      "get_reacted_event_ids",
      { eventIds: toFetch },
    );

    const reactedSet = new Set(reactedIds);
    for (const id of toFetch) {
      cache.set(id, reactedSet.has(id));
    }

    notifyListeners();
  } catch (e) {
    console.warn("[useReactionStatus] batch fetch failed:", e);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 100);
}

/** Returns whether the current user has reacted to this event. */
export function useReactionStatus(eventId: string): boolean {
  const [, setTick] = useState(0);
  const idRef = useRef(eventId);
  idRef.current = eventId;

  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);

    if (!cache.has(eventId)) {
      pendingIds.add(eventId);
      scheduleFlush();
    }

    return () => {
      listeners.delete(cb);
    };
  }, [eventId]);

  return cache.get(eventId) ?? false;
}

/** Mark an event as reacted (optimistic update). */
export function markReacted(eventId: string) {
  cache.set(eventId, true);
  notifyListeners();
}

/** Invalidate cache for specific IDs (e.g. after refresh). */
export function invalidateReactionStatus(ids?: string[]) {
  if (ids) {
    for (const id of ids) cache.delete(id);
  } else {
    cache.clear();
  }
}
