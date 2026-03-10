# Implementation Modules

> Part of [Sync Engine v2](./README.md)

File layout and module responsibilities.

---

## Sync engine

```
src-tauri/src/sync/
  |-- mod.rs              -- public API, SyncEngine struct, start/stop
  |-- engine.rs           -- main cycle loop, phase orchestration
  |-- pool.rs             -- RelayPool: connection management, subscribe_and_collect
  |-- scheduler.rs        -- routing plan computation, cover set algorithm, band grouping
  |-- discovery.rs        -- Phase 2: NIP-65 fetching, kind:3 hint extraction, NIP-11 info
  |-- content.rs          -- Phase 3: relay-centric content fetching
  |-- threads.rs          -- Phase 4: thread context resolution
  |-- media.rs            -- Phase 5: media download queue
  |-- processing.rs       -- event processing: replaceable handling, deletion, mute list
  |-- pruning.rs          -- tiered retention: per-tier pruning with min-events + time-window
  +-- policy.rs           -- RelayPolicy: rate limiting, backoff
```

## Search (separate from sync)

```
src-tauri/src/search/
  |-- mod.rs              -- public API: search(query) -> SearchResults
  +-- search.rs           -- hybrid search: local DB + NIP-50 global relays, WoT-aware ranking
```

Search is user-initiated (triggered by UI), not a background sync operation. It manages its own relay connections (relay.nostr.band, relay.primal.net) separate from the sync pool.

## Storage

```
src-tauri/src/storage/
  |-- db.rs               -- SQLite schema, queries, migrations
  +-- migrations.rs       -- v1 -> v2 migration logic
```

## WoT

```
src-tauri/src/wot/
  |-- store.rs            -- in-memory graph (unchanged)
  |-- bfs.rs              -- distance computation (add get_all_hop_distances)
  +-- interner.rs         -- string interning (unchanged)
```
