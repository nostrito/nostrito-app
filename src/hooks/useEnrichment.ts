/** On-demand enrichment hook.
 * Registers event IDs for background relay fetching of reactions/zaps.
 * Follows the same module-level batching pattern as useInteractionCounts.
 *
 * When a NoteCard renders, it calls useEnrichment(eventId). After a 500ms
 * debounce, all pending IDs are sent to the backend in one batch call.
 * The backend checks which IDs are stale (not fetched in 10 min), fetches
 * reactions/zaps from relays, stores them, and emits "enrichment-updated".
 * We then invalidate the interaction counts cache so the UI refreshes.
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invalidateInteractionCounts } from "./useInteractionCounts";

// Module-level state (survives component remounts)
const enrichedTimestamps = new Map<string, number>();
const pendingEnrichIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInProgress = false;

const STALENESS_SECS = 600; // 10 minutes
const FLUSH_DELAY_MS = 500; // debounce relay calls
const MAX_BATCH = 50;
const MAX_MAP_SIZE = 5000;
const EVICT_AGE_SECS = 1800; // 30 minutes

function evictOldEntries() {
  if (enrichedTimestamps.size <= MAX_MAP_SIZE) return;
  const cutoff = Date.now() / 1000 - EVICT_AGE_SECS;
  for (const [id, ts] of enrichedTimestamps) {
    if (ts < cutoff) enrichedTimestamps.delete(id);
  }
}

async function flush() {
  flushTimer = null;
  if (pendingEnrichIds.size === 0 || flushInProgress) return;

  const ids = Array.from(pendingEnrichIds).slice(0, MAX_BATCH);
  pendingEnrichIds.clear();
  flushInProgress = true;

  try {
    const stored = await invoke<number>("fetch_enrichment_from_relays", {
      eventIds: ids,
    });

    const now = Date.now() / 1000;
    for (const id of ids) {
      enrichedTimestamps.set(id, now);
    }

    // If relay fetch found new data, invalidate local counts cache
    if (stored > 0) {
      invalidateInteractionCounts(ids);
    }
  } catch (e) {
    // On failure, remove timestamps so they can be retried
    for (const id of ids) {
      enrichedTimestamps.delete(id);
    }
    console.warn("[useEnrichment] batch fetch failed:", e);
  } finally {
    flushInProgress = false;
    // If more IDs accumulated during the fetch, schedule another flush
    if (pendingEnrichIds.size > 0) {
      scheduleFlush();
    }
  }

  evictOldEntries();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

/** Register an event ID for background enrichment from relays.
 * No-op if the event was enriched within the last 10 minutes. */
export function useEnrichment(eventId: string): void {
  useEffect(() => {
    const now = Date.now() / 1000;
    const last = enrichedTimestamps.get(eventId);
    if (last && now - last < STALENESS_SECS) return;

    pendingEnrichIds.add(eventId);
    scheduleFlush();
  }, [eventId]);
}
