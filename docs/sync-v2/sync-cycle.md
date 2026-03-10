# Sync Cycle

> Part of [Sync Engine v2](./README.md)

The 5-phase sync loop. Each cycle runs these phases in order. Default cycle interval: 5 minutes (configurable 1-60 min).

```
Cycle N
  ├── Phase 1: Own Data
  ├── Phase 2: Discovery
  ├── Phase 3: Content Fetch (relay-centric)
  ├── Phase 4: Thread Context
  ├── Phase 5: Media Download
  └── [wait cycle_interval_secs]
```

---

## Phase 1 — Own Data

**Purpose:** Backup everything about ourselves. Highest priority.

### Step 1a: Own metadata

- Query configured relays for kinds [0, 3, 10000, 10002] authored by own pubkey.
- Limit 10, no `since` (always get latest replaceable events).
- Stop after first relay returns results.
- Process:
  - kind:0 → store profile metadata
  - kind:3 → update WoT graph (own follow list), extract relay hints into `user_relays`
  - kind:10000 → rebuild `muted_users`, `muted_events`, `muted_words`, `muted_hashtags`
  - kind:10002 → update own rows in `user_relays`

### Step 1b: Own event history

- Query configured relays for all own events: kinds [0, 1, 3, 4, 6, 7, 9735, 30023, 10000, 10002].
- Use own cursor from `user_cursors` (or no `since` on first run for full backup).
- Limit 1000.
- Stop after first relay returns events.

### Step 1c: Own media

- Queue all media from own events (no size limit, never evicted).

---

## Phase 2 — Discovery

**Purpose:** Build and refresh the relay routing table so Phase 3 knows where to look.

### Step 2a: Extract kind:3 relay hints (local, no network)

For follows with NO entries in `user_relays` at all, scan their stored kind:3 events for relay hints in `p` tag position 2.

- Pure local DB scan, no network call.
- Insert rows with `source = 'kind3_hint'`.

### Step 2b: Bootstrap from indexer relay (first-run only)

On first sync after app install (no `user_relays` rows exist for any follow):
- Connect to `wss://purplepag.es` on-demand.
- Query kind:10002 for all follows in batches of 100. Limit 200 per batch.
- Parse `r` tags and upsert `user_relays`.
- Disconnect when done.

This is the only time purplepag.es is queried during a sync cycle. After initial bootstrap, kind:10002 updates arrive passively via Phase 3 content fetching.

### Step 2c: Piggyback relay list refresh on content fetch

For follows whose `user_relays` entries have no `nip65` source at all (only kind3_hint or nothing):
- Add kind:10002 to the metadata filter in Phase 3 for these users.
- This avoids a separate network call — discovery piggybacks on content fetching.

### Step 2d: Tracked profiles relay discovery

For tracked profiles with no `user_relays` entries:
- Same as 2c — add kind:10002 to their Phase 3 metadata filter.
- If a tracked profile has no relay data AND no events at all, connect to purplepag.es on-demand for that specific pubkey.

---

## Phase 3 — Content Fetch (relay-centric batching)

**Purpose:** Fetch recent events from follows and tracked profiles, routed to the right relays.

This is the core innovation. Instead of "for each batch of follows -> ask all relays", we do "for each relay -> ask for all relevant follows at once."

### Step 3.0: Build the routing plan

```
Input:
  - follow_list: Vec<Pubkey>           (from WoT graph)
  - tracked_list: Vec<Pubkey>          (from tracked_profiles table)
  - user_relays: HashMap<Pubkey, Vec<(RelayUrl, Direction)>>
  - user_cursors: HashMap<Pubkey, Timestamp>
  - relay_stats: HashMap<RelayUrl, ReliabilityScore>

Output:
  - relay_plan: HashMap<RelayUrl, Vec<Pubkey>>
    Maps each relay to the list of pubkeys we should query there.
  - fallback_pubkeys: Vec<Pubkey>
    Pubkeys with no known write relays — query configured relays.
```

**Algorithm:**

1. Collect all pubkeys = `follow_list + tracked_list`, excluding `muted_users`.
2. For each pubkey, get their write relays (direction = `'write'` or `'both'`) from `user_relays`.
3. If a pubkey has 0 write relays → add to `fallback_pubkeys`.
4. If a pubkey has 1+ write relays → add to `relay_plan[relay_url]` for EACH of their write relays (we pick the best one later, but having multiple ensures fallback).
5. **Compute minimum cover set:** Score each relay as `pubkey_count * reliability_score`. Greedily pick the highest-scoring relay, mark its pubkeys as covered, recalculate scores, repeat until all pubkeys are covered. Remaining relay→pubkey mappings become "fallback routes."
6. Sort selected relays by reliability score (best first).

### Step 3.1: Group pubkeys by cursor similarity

Within each relay's pubkey list, group by `last_event_ts` into bands:
- **Hot** (last event < 1 hour ago): `since = last_event_ts - 60`
- **Warm** (last event 1h-24h ago): `since = last_event_ts - 60`
- **Cold** (last event > 24h ago OR no cursor): `since = now - lookback_days`

Each band becomes a separate filter within the same subscription. This avoids over-fetching for active users while still catching up on dormant ones.

Why bands and not one `since` per user: Nostr filters don't support per-author `since`. A filter `{authors: [A, B], since: X}` applies X to both. By grouping authors with similar timestamps, we minimize wasted data.

### Step 3.2: Execute relay-by-relay

For each relay in the plan (sorted by reliability):

1. Ensure relay is connected (connect on-demand if needed, respecting pool limits).
2. Build filters:
   - **Content filter:** `authors = [pubkeys for this relay]`, kinds = [1, 6, 30023], `since` per band.
   - **Metadata filter:** `authors = [pubkeys needing refresh]`, kinds = [0, 3, 10002], no `since` (always get latest replaceable). kind:10000 is NOT included here — own mute list is fetched only in Phase 1.
   - If any pubkeys in this relay batch need relay list refresh (from Step 2c), kind:10002 is already included here.
3. Call `subscribe_and_collect(relay, filters, timeout=30s)`.
4. Process returned events (see [Event Processing](./event-processing.md)):
   - **kind:0** → store, update profile cache.
   - **kind:1, kind:6** → store (source='sync'), queue media.
   - **kind:3** → store, update WoT graph edges, extract relay hints into `user_relays`.
   - **kind:10002** → parse `r` tags, upsert `user_relays` for that pubkey.
   - **kind:30023** → store, queue media.
   - **kind:5 (deletion)** → process immediately (see [Event Processing](./event-processing.md)).
   - **All replaceable events (kinds 0, 3, 10002):** Only store if `created_at` is newer than what we have. Replace the old one.
5. Update `user_cursors` for each pubkey that had events returned.
6. Update `relay_stats` with success/failure/latency.
7. Polite pause between relays (configurable, default 2s).

### Step 3.3: Fallback fetch

For `fallback_pubkeys` (no known write relays):
- Query all user-configured relays with these pubkeys, same filter structure.
- This is the old "spray" behavior, but only for users without NIP-65 data.

### Step 3.4: Tracked profiles priority pass

If any tracked profiles were NOT covered in the relay plan (disconnected relays, pool full, etc.):
- Queue them for the next cycle with elevated priority.
- Tracked profiles should always be attempted every cycle.

### Step 3.5: Historical backfill

After forward sync, one backward pass per cycle:

- **Notes/reposts:** Filter all follows, kinds [1, 6], `until = history_cursor`, limit 500. Route to cover-set relays.
- **Articles:** Filter all follows, kinds [30023], `until = articles_history_cursor`, limit 200. Route to cover-set relays.
- Cursors walk backward. Stop when a relay returns 0 events for 3 consecutive cycles (that relay's history is exhausted).

---

## Phase 4 — Thread Context

**Purpose:** When someone in my WoT replies to a post by someone outside my WoT, fetch the root post so the thread makes sense.

### Step 4.1: Identify missing thread roots

Scan events stored in this cycle (or all events with missing parents):
- For each kind:1 event, check `e` tags with `"root"` or `"reply"` markers.
- If the referenced event ID is not in our `events` table → it's a missing thread root.
- Collect all missing event IDs.

### Step 4.2: Fetch missing events

- Query configured relays (+ any relay hints from `e` tag position 2) with filter: `ids = [missing_event_ids]`, limit 100.
- Store the fetched events with `source = 'thread_context'`.

### Step 4.3: Thread display rules

When displaying a thread in the UI:
- **Always show:** The root post (even if author is outside WoT).
- **Always show:** Replies from people in my WoT.
- **Always show:** Replies from the original post's author (they're replying in their own thread).
- **Hide:** Replies from people outside my WoT who are not the root author.
- **Dim/tag:** Replies from muted users (still show but with visual mute indicator).

---

## Phase 5 — Media Download

Unchanged from v1. Three sub-phases:

1. **Own media:** Scan all own events, queue media, no size limit, never evicted.
2. **Tracked media:** Same rules as own media.
3. **Others' media:** Dequeue from `media_queue`, subject to `storage_media_gb` limit, LRU eviction when >95% full (target 80%).

---

## Self-Healing

On each engine startup:

1. **Missing relay data:** If >50% of follows have no `user_relays` entries, trigger a full Phase 2 discovery immediately.
2. **Stale cursors:** If a user's `last_fetched_at` is >48h old but they're in the follow list, reset their cursor to `now - lookback_days`.
3. **Empty database:** If total events <50 and follows >5, reset all cursors for fresh start.
4. **Orphaned relay connections:** Disconnect any relays not in the routing plan or configured list.
