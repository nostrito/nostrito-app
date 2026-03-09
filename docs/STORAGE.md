# Storage Architecture — nostrito-app

> Last updated: 2026-03-09

---

## What Gets Stored

nostrito stores everything locally on the user's device. No cloud, no server. The database is a single SQLite file.

### Database location
```
~/.nostrito/nostrito.db
```

### Media files location
```
~/.nostrito/media/<hash[0..2]>/<hash>
```
Files are content-addressed by sha256. The first 2 hex chars are used as a subdirectory to avoid filesystem limits on large collections.

---

## Database Tables

### `nostr_events`
The core table. Every Nostr event that nostrito has seen and chosen to store.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | 64-char hex event id (sha256 of the serialized event) |
| `pubkey` | TEXT | Author's public key (hex) |
| `created_at` | INTEGER | Event creation timestamp (Unix, set by the poster) |
| `kind` | INTEGER | Nostr event kind (0=profile, 1=note, 3=contacts, etc.) |
| `tags` | TEXT | JSON array of tag arrays |
| `content` | TEXT | Event content |
| `sig` | TEXT | Schnorr signature |
| `stored_at` | INTEGER | When nostrito stored this event (wall-clock, our timestamp) |

**Storage priority:**
1. **Own events** — always kept, never pruned
2. **Tracked profiles** — always kept, no age limit
3. **Others' events** — pruned after `max_event_age_days` days (default 30)

### `nodes`
WoT graph: one row per known pubkey.

| Column | Type | Description |
|---|---|---|
| `pubkey` | TEXT PK | Hex pubkey |
| `display_name` | TEXT | From kind:0 metadata |
| `picture` | TEXT | Avatar URL |
| `about` | TEXT | Bio |
| `nip05` | TEXT | NIP-05 identifier |
| `updated_at` | INTEGER | Last metadata refresh |

### `edges`
WoT graph: follow relationships.

| Column | Type | Description |
|---|---|---|
| `follower` | TEXT | Follower pubkey |
| `followed` | TEXT | Followed pubkey |
| `PRIMARY KEY` | (follower, followed) | Composite |

Trust is computed at query time from graph distance (BFS from own pubkey).

### `media_cache`
Records of downloaded media files.

| Column | Type | Description |
|---|---|---|
| `hash` | TEXT PK | sha256 of the file content |
| `url` | TEXT | Original URL |
| `pubkey` | TEXT | Author of the event containing this URL |
| `size_bytes` | INTEGER | File size |
| `mime_type` | TEXT | MIME type |
| `downloaded_at` | INTEGER | When it was downloaded |
| `last_accessed` | INTEGER | For LRU eviction of others' media |

**Media storage priority:**
- **Own media** — never evicted, no size limit
- **Others' media** — evicted LRU when storage exceeds configured media GB limit

### `media_queue`
URLs pending download. Populated at event store time, drained by Tier 4.

| Column | Type | Description |
|---|---|---|
| `url` | TEXT PK | URL to download (deduped) |
| `pubkey` | TEXT | Author pubkey |
| `queued_at` | INTEGER | When queued |

### `tracked_profiles`
Profiles the user has explicitly marked for unlimited retention. Foundation for the Gozzip protocol.

| Column | Type | Description |
|---|---|---|
| `pubkey` | TEXT PK | Hex pubkey of the tracked profile |
| `tracked_at` | INTEGER | When tracking started |
| `note` | TEXT | Optional user note |

Tracked profiles are **excluded from all pruning operations** — their events are kept regardless of age or storage limits.

### `app_config`
Key-value store for persistent configuration and sync cursors.

| Key | Value | Description |
|---|---|---|
| `outbound_relays` | CSV of wss:// URLs | Active relay list |
| `tier2_since` | Unix timestamp | Forward sync cursor (wall-clock) |
| `tier2_history_until` | Unix timestamp | Historical backfill cursor (backward) |
| `wot_max_depth` | integer | WoT expansion depth |
| `max_event_age_days` | integer | Event retention period |
| + other settings | | |

---

## Storage Limits & Pruning

### Events (others)
Configured via **Settings → Storage → Event retention** slider.

| Option | Retention |
|---|---|
| 7 days | Aggressive — keeps last week only |
| 14 days | Standard |
| **30 days** | **Default** — good balance |
| 90 days | Extended history |
| 1 year | Long-term archive |

**Never pruned:**
- Own events (own pubkey)
- Events from tracked profiles

Pruning runs at the start of each sync cycle. The SQL:
```sql
DELETE FROM nostr_events
WHERE created_at < (now - max_age_secs)
  AND pubkey != own_pubkey
  AND pubkey NOT IN (SELECT pubkey FROM tracked_profiles)
```

### Media (others)
Configured via **Settings → Storage → Media storage** (GB slider).

- Others' media is evicted LRU (least recently accessed first) when total others' media exceeds the limit
- Own media is never evicted regardless of size

---

## Tracked Profiles — Gozzip Foundation

Tracked profiles are the first building block of the **Gozzip protocol** — a decentralized gossip and data preservation layer for Nostr.

### What tracking means
When you track a profile:
- All their events are **kept indefinitely** — no age limit
- Their events are **excluded from all pruning**, even when storage is tight
- Their metadata (kind:0 profile, kind:3 contacts) is **always refreshed** in Tier 1.5
- Their media is treated with higher priority in Tier 4

### Use cases
- Important contacts you want full history for
- Historical figures in the Nostr ecosystem
- Accounts you're archiving for research
- Preparatory step for future Gozzip relay operations

### Managing tracked profiles
**Settings → Storage → Tracked Profiles:**
- Add by npub or hex pubkey
- Optional note to remember why you're tracking them
- Untrack at any time (does not delete their events — just removes the protection)

### Gozzip protocol context
Gozzip (gossip + zip) envisions nostrito nodes acting as voluntary data custodians for specific profiles. By tracking a profile, your nostrito instance:
1. Becomes a full archive of that profile's history
2. Can serve that profile's events to other relays
3. Participates in a distributed preservation network

The `tracked_profiles` table is the registry for this custodianship. Future versions will add Gozzip relay federation, data serving capabilities, and custodian discovery.

---

## Storage Priority Hierarchy

```
Priority 1 (highest): Own events + own media
  → Always stored, never pruned, never evicted

Priority 2: Tracked profiles
  → Always stored, never pruned
  → Media treated with elevated priority

Priority 3: WoT follows (direct)
  → Stored within retention window
  → Media downloaded up to media GB limit

Priority 4: WoT peers (2nd+ hop)
  → Stored within retention window
  → Media downloaded if space available

Priority 5 (lowest): Unknown pubkeys
  → May appear in relayed events but not actively fetched
```

---

## Kinds Stored

| Kind | Name | Priority |
|---|---|---|
| 0 | Profile metadata | Always (all WoT) |
| 1 | Text note | Within retention |
| 3 | Contact list | Always (WoT graph) |
| 4 | Encrypted DM | Within retention |
| 6 | Repost | Within retention |
| 7 | Reaction | Within retention |
| 9735 | Zap receipt | Within retention |
| 30023 | Long-form article | Within retention |

---

## Disk Usage Estimates

| Scenario | Events | Avg size | DB size |
|---|---|---|---|
| 100 follows, 7 days | ~5,000 | 500 bytes | ~2.5 MB |
| 100 follows, 30 days | ~20,000 | 500 bytes | ~10 MB |
| 500 follows, 30 days | ~100,000 | 500 bytes | ~50 MB |
| WoT crawl (10K peers) | ~500,000 | 500 bytes | ~250 MB |

Media is separate and depends entirely on how media-heavy your follows are.
Blossom servers typically serve images at 100KB–2MB each.

---

## See Also
- `docs/SYNC_ARCHITECTURE.md` — how events are fetched and stored
- `src-tauri/src/storage/db.rs` — database implementation
- `src-tauri/src/sync/engine.rs` — sync engine with pruning logic
