# Storage Architecture — nostrito-app

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
| `source` | TEXT | How the event arrived: `sync`, `thread_context`, or `search` |

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

### `user_relays`
NIP-65 relay lists discovered for each user.

### `user_cursors`
Per-user sync cursors tracking the newest event fetched.

### `relay_stats`
Per-relay success/failure rates and latency.

### `thread_refs`
Tracks e-tag references between events to protect thread roots from pruning.

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

### `media_queue`
URLs pending download. Populated at event store time, drained by the media download phase.

### `tracked_profiles`
Profiles the user has explicitly marked for unlimited retention.

| Column | Type | Description |
|---|---|---|
| `pubkey` | TEXT PK | Hex pubkey of the tracked profile |
| `tracked_at` | INTEGER | When tracking started |
| `note` | TEXT | Optional user note |

Tracked profiles are **excluded from all pruning operations**.

### `app_config`
Key-value store for persistent configuration.

---

## Storage Priority Hierarchy

```
Priority 1 (highest): Own events + own media
  -> Always stored, never pruned, never evicted

Priority 2: Tracked profiles
  -> Always stored, never pruned

Priority 3: Direct follows (hop 1)
  -> Stored within retention window (default 30 days, min 50 events)

Priority 4: Follows-of-follows (hop 2)
  -> Stored within retention window (default 7 days, min 10 events)

Priority 5 (lowest): Others (hop 3+)
  -> Stored within retention window (default 3 days, min 5 events)
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

## See Also
- `docs/SYNC.md` — sync engine overview
- `docs/data-model.md` — full v2 table schemas
- `src-tauri/src/storage/db.rs` — database implementation
- `src-tauri/src/sync/engine.rs` — sync engine
