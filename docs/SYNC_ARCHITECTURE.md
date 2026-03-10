# Sync Architecture — nostrito-app

> Last updated: 2026-03-09

nostrito uses a **tiered polite sync engine** that runs in a continuous loop, progressively building a local Nostr database while respecting relay rate limits and user storage preferences.

---

## Overview

The sync engine lives in `src-tauri/src/sync/engine.rs`. It runs as a background Tokio task from the moment the app starts. Each "cycle" runs all tiers sequentially, then waits a configurable interval before repeating.

```
Cycle N
  ├── Tier 1     → Own profile + contact list (every cycle)
  ├── Tier 1.5   → WoT metadata refresh (every 3 cycles)
  ├── Tier 2     → Follows' events — forward + historical (every cycle)
  ├── Tier 3     → WoT crawl: contact lists of follows (every 6 cycles)
  └── Tier 4     → Blossom media backup (every cycle)
  └── [wait cycle_interval_secs — default 5 min]
  Cycle N+1 ...
```

Cycle interval is configurable in **Settings → Sync → Sync cycle interval** (1–60 minutes).

---

## Tiers

### Tier 1 — Critical (every cycle)
Fetches the user's own **kind:0** (profile) and **kind:3** (contact list) from all configured relays.

- Tries each relay in order, stops after the first one that returns both events
- Extracts the follow list and stores it in the WoT graph (`nodes` + `edges` tables)
- Also fetches **all own events** (Tier 1b) — full history backup, no `since` limit

### Tier 1.5 — WoT Metadata Refresh (every 3 cycles, ~15 min)
Refreshes **kind:0** and **kind:3** for every known pubkey in the WoT graph.

- Runs `run_metadata_refresh()` between Tier 1 and Tier 2
- Fetches in batches of 50 pubkeys per request, with polite pauses between batches
- When a fresh kind:3 arrives, the WoT graph is updated with new follow relationships
- Ensures display names, avatars, and follow lists stay current

### Tier 2 — Important (every cycle)
Fetches recent and historical events from **direct follows**.

#### Forward sync (incremental)
Uses a **wall-clock sync cursor** stored in `app_config` (key: `tier2_since`):
- First run: fetches from `now - lookback_days` (default 7 days)
- Subsequent runs: fetches from `max(cursor - 60s, now - lookback_days)` — whichever reaches further back. This ensures newly added WoT peers also get their historical window fetched.
- After a successful batch with at least 1 new event, cursor is updated to `now - 60s`
- Cursor only advances when new events are actually stored — prevents silent data loss

Fetches kinds: `0, 1, 3, 4, 6, 7, 9735, 30023` in batches of 10 follows per request, 50 events per batch.

#### Historical backfill (backward cursor)
After the forward sync, one historical pass per cycle using a backward-walking cursor stored in `app_config` (key: `tier2_history_until`):
- Default start: `now - lookback_days` (begins at the edge of the forward window, goes older)
- Each cycle fetches up to 500 events with `until = history_until` (no `since`)
- Cursor moves back to `min(created_at) - 1` from results
- If no events returned, cursor stays in place for retry next cycle
- Progressively builds historical data: 7 days → 30 days → 6 months → full relay history

This means the event count **always grows** — forward sync catches new posts, historical sync builds the past.

#### Storage enforcement
At the start of Tier 2, if event count exceeds the limit derived from **Settings → Storage → Events** (GB limit ÷ ~500 bytes/event), the oldest non-own events are pruned via `delete_oldest_others_events()`. Own events are never deleted.

### Tier 3 — Background WoT Crawl (every 6 cycles, ~30 min)
Expands the Web of Trust graph by fetching **kind:3** (contact lists) for all discovered pubkeys.

- Fetches contact lists for follows-of-follows up to `wot_max_depth` hops
- Updates the graph with new nodes and edges
- Newly discovered pubkeys become eligible for Tier 2 historical backfill on next cycle

### Tier 4 — Blossom Media Backup (every cycle)
Downloads media files referenced in stored events to local storage.

#### Queue-based architecture
Media URLs are **detected at event store time**, not in a batch scan:
- When any event is stored for the first time (`INSERT OR IGNORE` returns 1 row), `queue_media_for_event()` is called immediately
- Extracts URLs from both `content` text and `tags` JSON (imeta, url, r, image, thumb, media tags)
- URLs matching known media patterns are added to the `media_queue` table

#### Backfill for existing events
If the queue is empty on a Tier 4 run, a one-time scan of up to 5000 stored events populates the queue. This handles events stored before the queue was introduced.

#### Download
- Dequeues up to 500 URLs per cycle from `media_queue` (FIFO)
- HEAD request first to check size/MIME type
- Own media: always downloaded, no storage limit enforced
- Others' media: skipped if `media_others_bytes` exceeds configured media GB limit
- Files stored at `~/.nostrito/media/<hash[0..2]>/<hash>` (content-addressed by sha256)
- Records written to `media_cache` table with hash, url, pubkey, size, MIME type
- 500ms polite pause between downloads

#### Media detection
A URL is considered media if any of these are true:
1. Path contains a 64-char hex sha256 (Blossom format)
2. File extension matches: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.mp4`, `.webm`, `.mov`, `.mp3`, `.ogg`, `.wav`
3. Hostname matches a known Nostr CDN (void.cat, nostr.build, image.nostr.build, nostrimg.com, nostpic.com, blossom.band, blossom.primal.net, primal.b-cdn.net, m.primal.net, i.nostr.build, files.v0l.io, nostr.mtrr.me, cdn.satellite.earth, i.imgur.com, pbs.twimg.com, video.twimg.com, media.tenor.com)

---

## Relay Policy

Each relay has a `RelayPolicy` that enforces polite behavior:
- Minimum interval between requests (default 3s, configurable)
- On NOTICE from relay: temporary interval increase
- On connection failure: escalating backoff

Policies are **reset fresh each cycle** to prevent accumulated backoff state from permanently blocking relays.

---

## Storage Model

| Table | Purpose |
|---|---|
| `nostr_events` | All stored Nostr events (id, pubkey, kind, content, tags, sig, stored_at) |
| `nodes` | WoT graph nodes (pubkeys + metadata) |
| `edges` | WoT graph follow relationships |
| `media_cache` | Downloaded media records (hash, url, path, size, mime) |
| `media_queue` | Pending media URLs to download |
| `app_config` | Key-value store for persistent config + sync cursors |
| `sync_state` | Sync cursor: `tier2_since` (forward), `tier2_history_until` (backward) |

SQLite file: `~/.nostrito/nostrito.db`
Media files: `~/.nostrito/media/<hash[0..2]>/<hash>`

---

## Sync Cursors

| Key | Table | Direction | Purpose |
|---|---|---|---|
| `tier2_since` | `app_config` | Forward ↑ | Wall-clock time of last successful Tier 2 forward sync |
| `tier2_history_until` | `app_config` | Backward ↓ | Oldest `created_at` fetched in historical backfill |

---

## Configuration (Settings → Sync)

| Setting | Default | Effect |
|---|---|---|
| Lookback days | 7 | How far back the initial sync goes |
| Authors per batch | 10 | Follows per relay subscription |
| Events per batch | 50 | Max events per subscription request |
| Pause between batches | 7s | Polite delay between subscription batches |
| Min relay interval | 3s | Min time between requests to same relay |
| WoT authors per batch | 5 | Follows-of-follows per Tier 3 request |
| WoT events per batch | 15 | Events per Tier 3 request |
| Sync cycle interval | 5 min | Time between full sync cycles |

Changes take effect immediately after **Save & Restart Sync**.

---

## Key Design Principles

1. **Polite** — never hammer relays. Batches are small, pauses are enforced, policies back off on errors.
2. **Local-first** — all data in SQLite on device. No cloud dependency.
3. **Always growing** — forward sync catches new posts, backward sync builds history indefinitely.
4. **Own data first** — own events always preserved (never pruned), own media always downloaded.
5. **Queue at write time** — media URLs queued the moment events are stored, not in expensive batch scans.
6. **Crash-safe cursors** — cursors only advance after successful operations. If a cycle fails, the next cycle retries the same window.
