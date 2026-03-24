/** Batched interaction counts hook.
 * Collects event IDs from all rendered NoteCards, debounces 100ms,
 * then calls get_interaction_counts in a single batch invoke.
 */
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface InteractionCounts {
  replies: number;
  reposts: number;
  reactions: number;
  zaps: number;
}

// Module-level shared state for batching
const pendingIds = new Set<string>();
const cache = new Map<string, InteractionCounts>();
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
    const result = await invoke<Record<string, InteractionCounts>>(
      "get_interaction_counts",
      { eventIds: toFetch },
    );

    for (const id of toFetch) {
      cache.set(id, result[id] ?? { replies: 0, reposts: 0, reactions: 0, zaps: 0 });
    }

    notifyListeners();
  } catch (e) {
    console.warn("[useInteractionCounts] batch fetch failed:", e);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 100);
}

export function useInteractionCounts(eventId: string): InteractionCounts | null {
  const [, setTick] = useState(0);
  const idRef = useRef(eventId);
  idRef.current = eventId;

  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);

    // Request this event ID
    if (!cache.has(eventId)) {
      pendingIds.add(eventId);
      scheduleFlush();
    }

    return () => {
      listeners.delete(cb);
    };
  }, [eventId]);

  return cache.get(eventId) ?? null;
}

/** Invalidate cache for specific IDs and trigger a re-fetch. */
export function invalidateInteractionCounts(ids?: string[]) {
  if (ids) {
    for (const id of ids) {
      cache.delete(id);
      pendingIds.add(id);
    }
  } else {
    for (const id of cache.keys()) pendingIds.add(id);
    cache.clear();
  }
  scheduleFlush();
}
