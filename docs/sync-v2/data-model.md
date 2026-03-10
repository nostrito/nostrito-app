# Data Model

> Part of [Sync Engine v2](./README.md)

All SQLite tables, indexes, constraints, and rules for the v2 sync engine.

---

## `events`

All stored Nostr events. Renamed from `nostr_events` in v1 (see [Migration](./migration.md)).

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | 64-char hex event id |
| `pubkey` | TEXT NOT NULL | Author hex pubkey |
| `created_at` | INTEGER NOT NULL | Event creation timestamp (Unix) |
| `kind` | INTEGER NOT NULL | Nostr event kind |
| `tags` | TEXT NOT NULL | JSON array of tag arrays |
| `content` | TEXT NOT NULL | Event content (may be encrypted) |
| `sig` | TEXT NOT NULL | Schnorr signature |
| `stored_at` | INTEGER NOT NULL | When we stored this (wall-clock) |
| `source` | TEXT NOT NULL DEFAULT 'sync' | How we got this event: `'sync'`, `'thread_context'`, or `'search'` |

Indexes:
- `idx_events_pubkey_created` ON (pubkey, created_at DESC)
- `idx_events_kind` ON (kind)
- `idx_events_created` ON (created_at DESC)
- `idx_events_stored` ON (stored_at DESC)
- `idx_events_source` ON (source) — for filtering thread context and search results

---

## `user_relays`

Per-user relay routing table. Populated from NIP-65 (kind:10002), NIP-05, and kind:3 relay hints.

| Column | Type | Notes |
|--------|------|-------|
| `pubkey` | TEXT NOT NULL | User hex pubkey |
| `relay_url` | TEXT NOT NULL | Normalized wss:// URL |
| `direction` | TEXT NOT NULL | `'read'`, `'write'`, or `'both'` |
| `source` | TEXT NOT NULL | `'nip65'`, `'nip05'`, or `'kind3_hint'` |
| `source_ts` | INTEGER NOT NULL | `created_at` of the source event |
| PRIMARY KEY | (pubkey, relay_url) | |

Indexes:
- `idx_user_relays_relay` ON (relay_url) — for grouping users by relay

**Rules:**
- Source priority: `nip65` > `nip05` > `kind3_hint`. Higher-priority sources always win for the same (pubkey, relay_url) pair.
- When a newer kind:10002 arrives, DELETE all rows for that pubkey where `source = 'nip65'` and INSERT the new ones. This handles relay removal.
- `nip05` hints are only inserted if no `nip65` rows exist for that pubkey.
- `kind3_hint` entries are only inserted if neither `nip65` nor `nip05` rows exist for that pubkey.

---

## `user_cursors`

Per-user "last event seen" timestamps.

| Column | Type | Notes |
|--------|------|-------|
| `pubkey` | TEXT PK | User hex pubkey |
| `last_event_ts` | INTEGER NOT NULL | `created_at` of the newest event we have from this user |
| `last_fetched_at` | INTEGER NOT NULL | Wall-clock time we last queried for this user |

**Rules:**
- Updated after every successful fetch that includes this user.
- `last_event_ts` only advances (never goes backward).
- When building filters: `since = last_event_ts - 60` (60-second overlap for safety).
- Users with no cursor entry get `since = now - lookback_days` on first fetch.

---

## `relay_stats`

Relay reliability tracking. Updated after every relay interaction.

| Column | Type | Notes |
|--------|------|-------|
| `relay_url` | TEXT PK | Normalized wss:// URL |
| `success_count` | INTEGER DEFAULT 0 | Successful subscriptions |
| `failure_count` | INTEGER DEFAULT 0 | Failed subscriptions / timeouts |
| `total_events` | INTEGER DEFAULT 0 | Total events received from this relay |
| `avg_latency_ms` | INTEGER DEFAULT 0 | Rolling average time-to-first-event |
| `last_success` | INTEGER | Last successful interaction timestamp |
| `last_failure` | INTEGER | Last failure timestamp |
| `last_rate_limited` | INTEGER | Last rate-limit NOTICE timestamp |

**Reliability score** (computed in-memory, not stored):
```
score = (success_count / (success_count + failure_count + 1))
      * (1.0 - max(0.0, 1.0 - hours_since_last_rate_limit / 24.0) * 0.3)
      * (1.0 / (1.0 + avg_latency_ms / 1000.0))
```

Behavior:
- Just rate-limited (0h ago): `1.0 - 1.0 * 0.3 = 0.7` (30% penalty)
- 12h after rate-limit: `1.0 - 0.5 * 0.3 = 0.85` (15% penalty)
- 24h+ after rate-limit: `1.0 - 0.0 * 0.3 = 1.0` (no penalty)

Higher is better. Used to sort relays when choosing which to connect to first.

---

## `relay_info`

NIP-11 relay information documents. Fetched on first encounter and refreshed every 24h.

| Column | Type | Notes |
|--------|------|-------|
| `relay_url` | TEXT PK | Normalized wss:// URL |
| `name` | TEXT | Relay name |
| `description` | TEXT | Relay description |
| `supported_nips` | TEXT | JSON array of supported NIP numbers |
| `software` | TEXT | Relay software identifier |
| `version` | TEXT | Software version |
| `limitation_payment_required` | INTEGER | 1 if payment required |
| `limitation_auth_required` | INTEGER | 1 if NIP-42 auth required |
| `fetched_at` | INTEGER | When we last fetched this info |

Used to:
- Sort relays in the cover set algorithm (prefer relays supporting NIP-65, NIP-45).
- Show relay info cards in Settings > Relays.
- Warn before adding a relay that requires payment or auth.

---

## `deletion_tombstones`

Tracks which events have been deleted via kind:5. Used for O(1) lookup when checking if an incoming event has already been deleted.

| Column | Type | Notes |
|--------|------|-------|
| `event_id` | TEXT PK | The deleted event's id |
| `deleted_by` | TEXT NOT NULL | Pubkey of the author who deleted it |
| `deletion_event_id` | TEXT NOT NULL | The kind:5 event's id |
| `deleted_at` | INTEGER NOT NULL | `created_at` of the kind:5 event |

**Rules:**
- When a kind:5 event arrives, insert one row per `e` tag (after verifying author match).
- Before storing ANY incoming event, check: `SELECT 1 FROM deletion_tombstones WHERE event_id = :id AND deleted_by = :pubkey`. If found, skip storing.
- Tombstones are never pruned (they prevent re-fetching deleted events).

---

## `retention_config`

Per-tier retention settings. Populated from Settings UI.

| Column | Type | Notes |
|--------|------|-------|
| `tier` | TEXT PK | `'follows'`, `'fof'`, or `'others'` |
| `min_events` | INTEGER NOT NULL | Minimum events to keep per user |
| `time_window_secs` | INTEGER NOT NULL | Time window in seconds |

Default values inserted on first run:
- `follows`: 50 events, 30 days (2592000s)
- `fof`: 10 events, 7 days (604800s)
- `others`: 5 events, 3 days (259200s)

---

## Mute Tables

All derived from the user's own kind:10000 event. Rebuilt entirely each time we process a newer kind:10000.

### `muted_users`

| Column | Type | Notes |
|--------|------|-------|
| `pubkey` | TEXT PK | Muted user's hex pubkey |
| `muted_at` | INTEGER NOT NULL | When the mute was recorded |

### `muted_events`

| Column | Type | Notes |
|--------|------|-------|
| `event_id` | TEXT PK | Muted event id |
| `muted_at` | INTEGER NOT NULL | When the mute was recorded |

### `muted_words`

| Column | Type | Notes |
|--------|------|-------|
| `word` | TEXT PK | Lowercase muted word/phrase |
| `muted_at` | INTEGER NOT NULL | When the mute was recorded |

### `muted_hashtags`

| Column | Type | Notes |
|--------|------|-------|
| `hashtag` | TEXT PK | Muted hashtag (without #) |
| `muted_at` | INTEGER NOT NULL | When the mute was recorded |

---

## `wot_graph` (in-memory only)

The follow graph lives in memory as sorted adjacency lists (same as today). Persisted to `nodes` + `edges` tables. Loaded on startup.

**New requirement:** A batch function `get_all_hop_distances(root: &str, max_hops: u8) -> HashMap<String, u8>` is needed. This runs a BFS from the root pubkey and returns hop distances for all reachable pubkeys. Used by the pruning algorithm to classify pubkeys into tiers. The current pairwise BFS (`compute_distance`) is too slow to run per-pubkey during pruning.

---

## Other tables (unchanged from v1)

- `media_cache` — downloaded media records
- `media_queue` — pending media download URLs
- `tracked_profiles` — user-pinned profiles for indefinite retention
- `app_config` — key-value config store (simplified — sync cursors move to `user_cursors`)
