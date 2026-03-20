/** Rate-limited on-demand fetch hook.
 * Prevents flooding relays by tracking last-fetch timestamps per key.
 * Module-level Map survives component remounts (same pattern as useInteractionCounts).
 */
import { useCallback } from "react";

const fetchTimestamps = new Map<string, number>();

export function useOnDemandFetch() {
  const fetchIfStale = useCallback(
    (key: string, fetchFn: () => Promise<unknown>, staleSecs = 60) => {
      const now = Date.now() / 1000;
      const last = fetchTimestamps.get(key);
      if (last && now - last < staleSecs) return;
      fetchTimestamps.set(key, now);
      fetchFn().catch(() => fetchTimestamps.delete(key));
    },
    []
  );

  return { fetchIfStale };
}
