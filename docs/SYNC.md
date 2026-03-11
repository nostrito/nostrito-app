# Sync Engine — Relay-Aware Outbox Model

The sync engine uses a relay-centric outbox model that routes queries to the right relays for each user, batches intelligently, and respects Nostr protocol semantics for replaceable events, deletions, and mute lists.

## Documents

| Document | Contents |
|----------|----------|
| [Data Model](./data-model.md) | All SQLite tables, indexes, constraints, and rules |
| [Relay Pool](./relay-pool.md) | Connection pool, lifecycle, rate limiting |
| [Sync Cycle](./sync-cycle.md) | The 5-phase sync loop (own data, discovery, content, threads, media) |
| [Event Processing](./event-processing.md) | Replaceable events, deletions, mute lists |
| [WoT Graph](./wot.md) | In-memory graph structure, hop tiers, WoT crawl |
| [Discovery](./discovery.md) | NIP-65, NIP-05, NIP-42, NIP-11, purplepag.es, fallback chain |
| [Pruning](./pruning.md) | Tiered retention, pruning algorithm, storage settings UI |
| [Search](./search.md) | Hybrid search: local DB + NIP-50 global relays, WoT-aware ranking |
| [Config](./config.md) | User-configurable + hardcoded settings, event kind reference, decided questions |
| [Modules](./modules.md) | Implementation module map and file layout |

---

## Core Principles

1. **Ask the right relay for the right person.** Don't spray every query to every relay. Use NIP-65 relay lists to know where each person publishes.
2. **Ask each relay as few times as possible.** Group users by relay, merge filters, one subscription per relay per pass.
3. **Never re-fetch what we already have.** Per-user cursors track the newest event we have from each person. Only ask for newer.
4. **Metadata is forever.** Profile (kind:0), contacts (kind:3), relay list (kind:10002), and mute list (kind:10000) are replaceable events — always keep the latest version, never prune.
5. **Content has a tiered shelf life.** Retention depends on social distance: direct follows get more history than follows-of-follows, who get more than strangers. Retention is defined by two thresholds — a minimum event count AND a time window — whichever keeps more events wins.
6. **Respect deletions.** When we see a kind:5 (deletion) event, delete the referenced events.
7. **Own data is sacred.** Own events and own media are never pruned or evicted.
8. **Muted users are tagged, not invisible.** We store a mute flag so the UI can filter, but we still store their events (they might be part of a thread context).
9. **Thread context matters.** If someone in my WoT replies to someone outside my WoT, fetch the root post so the thread makes sense.
