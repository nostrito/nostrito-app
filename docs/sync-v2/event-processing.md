# Event Processing

> Part of [Sync Engine v2](./README.md)

How we handle replaceable events, deletions, and mute lists.

---

## Replaceable Event Handling

Kinds 0, 3, 10000, 10002 (and all 10000-19999 range, and 30000-39999 parameterized replaceable) follow special rules:

1. **Only one version per pubkey (per `d` tag for parameterized).** When a newer event arrives (`created_at` > stored `created_at`), replace the old one.
2. **Never prune.** These events are always kept regardless of tier retention settings.
3. **Processing on arrival:** Each kind triggers specific side effects (graph update, relay table update, mute table rebuild, etc.).

### Implementation

For replaceable events, the storage logic is:
```sql
-- For regular replaceable (10000-19999):
INSERT INTO events (...) VALUES (...)
  ON CONFLICT(id) DO NOTHING;

-- Then check if this replaces an older version:
DELETE FROM events
  WHERE pubkey = ?
    AND kind = ?
    AND id != ?
    AND created_at < ?;
```

For parameterized replaceable (30000-39999), include the `d` tag value in the uniqueness check:
```sql
DELETE FROM events
  WHERE pubkey = ?
    AND kind = ?
    AND id != ?
    AND created_at < ?
    AND json_extract(tags, ...) -- match d tag value
```

---

## Deletion Handling (kind:5)

When we receive a kind:5 event:

1. Parse `e` tags to get the list of event IDs to delete.
2. For each referenced event ID:
   - Look it up in `events`.
   - **Verify the deletion author matches the event author.** Only the original author can delete their own events.
   - If valid: DELETE the event from `events`.
3. Insert a row into `deletion_tombstones` for each deleted event ID (see [Data Model](./data-model.md)).
4. Store the kind:5 event itself in `events`.
5. If the deleted event had media queued, remove it from `media_queue`.

### Edge case: deletion before target event

We receive a kind:5 before we have the referenced event. The tombstone is still created. When the referenced event arrives later, the pre-store check catches it:

```sql
-- Before storing any incoming event:
SELECT 1 FROM deletion_tombstones
  WHERE event_id = :incoming_event_id
    AND deleted_by = :incoming_pubkey;
-- If found, skip storing the incoming event.
```

This is O(1) lookup vs the old fragile `LIKE` scan on kind:5 tags.

---

## Mute List Processing (kind:10000)

**Only process our own mute list.** Others' kind:10000 events are stored but not parsed.

When we receive our own kind:10000:

### 1. Parse public tags

- `["p", "<pubkey>"]` → muted user
- `["e", "<event_id>"]` → muted event
- `["t", "<hashtag>"]` → muted hashtag
- `["word", "<string>"]` → muted word

### 2. Rebuild mute tables

```sql
DELETE FROM muted_users;
DELETE FROM muted_events;
DELETE FROM muted_words;
DELETE FROM muted_hashtags;
-- INSERT all entries from the new kind:10000
```

### 3. Private mutes (encrypted content)

**Dependency: requires signing key support (not yet implemented).**

If the user's signing key is available (nsec or NIP-46 remote signer), decrypt the `.content` field using NIP-44 (self-encryption: author's own pubkey + privkey). Parse the decrypted JSON array and merge entries into the mute tables alongside public entries.

If no signing key is available, only public mutes are processed. This is the initial v2 behavior — private mute decryption will be enabled when signing key management is added.

nostr-sdk 0.35 includes NIP-44 via `nostr::nips::nip44::{encrypt, decrypt}` but the codebase currently has no key management beyond storing the npub.

### Mute application in the UI

Muting is a **display-layer concern**, not a storage concern:
- Events from muted users ARE stored (needed for thread context).
- Events from muted users are NOT actively fetched (excluded from Phase 3 follow list).
- The feed query joins against `muted_users` and returns a `is_muted` flag.
- The UI dims or hides muted content based on user preference.
