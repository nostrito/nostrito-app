# Migration from v1

> Part of [Sync Engine v2](./README.md)

**Clean break.** On first run of v2:

1. **Rename** `nostr_events` table to `events`. Add `source TEXT NOT NULL DEFAULT 'sync'` column.
2. Keep `media_cache` and `media_queue`.
3. Keep `tracked_profiles`.
4. Keep `nodes` and `edges` (WoT graph).
5. **Drop** all `app_config` sync cursor keys (`tier2_since`, `tier2_history_until`, `tier2_history_until_articles`, `sync_tier3_checkpoint`, `tracked_since`).
6. **Create** new tables: `user_relays`, `user_cursors`, `relay_stats`, `relay_info`, `deletion_tombstones`, `retention_config`, `muted_users`, `muted_events`, `muted_words`, `muted_hashtags`.
7. **Populate `user_cursors`** from existing events: for each pubkey in events table, set `last_event_ts = MAX(created_at)`.
8. **Bootstrap `user_relays`** from existing kind:3 events (extract relay hints from `p` tag position 2).
9. **Populate `deletion_tombstones`** from existing kind:5 events (parse `e` tags, verify author matches).
10. **Drop** `sync_state` table (was unused anyway).
11. **Add missing indexes**: `idx_events_pubkey_created` ON (pubkey, created_at DESC), `idx_events_source` ON (source).

This preserves all stored data while giving the new engine a clean state to work from.
