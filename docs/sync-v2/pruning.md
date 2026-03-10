# Pruning — Tiered Retention

> Part of [Sync Engine v2](./README.md)

Runs at the start of each sync cycle.

---

## Retention model

Event retention is configured **per social distance tier**, with two thresholds per tier:
- **Min events:** Keep at least this many events per user, regardless of age.
- **Time window:** Keep all events within this time window, regardless of count.

**Whichever threshold keeps more events wins.** Example: if a direct follow has 20 events in the last week but their min-events is 50, keep all 50 (reaching further back in time). If another follow has 3 events in the last week but 80 events in the last month, and time window is 1 month, keep all 80.

---

## Tiers

| Tier | Who | Default min events | Default time window |
|------|-----|-------------------|-------------------|
| **Own** | Own pubkey | Unlimited | Forever |
| **Tracked** | Tracked profiles | Unlimited | Forever |
| **Direct follows** (hop 1) | People I follow | 50 events | 30 days |
| **Follows of follows** (hop 2) | People my follows follow | 10 events | 7 days |
| **Others** | Thread context, strangers | 5 events | 3 days |

Each tier's thresholds are user-configurable in **Settings > Storage** (see Storage Settings UI below).

---

## Pruning algorithm

**Pre-step: Compute hop distances.**

Before pruning, run `get_all_hop_distances(graph, own_pubkey, max_hops=2)` (see [WoT Graph](./wot.md)) to get a `HashMap<pubkey, hop>` for all reachable pubkeys. Pubkeys not in the map are classified as "others."

**For each pubkey in the events table** (excluding own and tracked):

1. Determine the pubkey's tier from the hop-distance map:
   - hop 1 → "follows"
   - hop 2 → "fof"
   - not found → "others"
2. Look up that tier's (min_events, time_window) from `retention_config`.
3. Compute the cutoff:
   ```
   time_cutoff = now - time_window

   -- Find the created_at of the Nth oldest event (where N = min_events)
   SELECT created_at FROM events
     WHERE pubkey = :pk AND kind NOT IN (0, 3, 10000, 10002, 5)
     ORDER BY created_at DESC
     LIMIT 1 OFFSET :min_events - 1

   -- The effective cutoff is whichever is OLDER (keeps more events)
   effective_cutoff = MIN(time_cutoff, nth_event_ts)
   ```
4. Delete events older than `effective_cutoff` for this pubkey (excluding replaceable metadata and deletions).

**Implementation approach:** The pruning runs in Rust, not pure SQL. The hop-distance map is computed in-memory, then for each tier we batch the pubkeys and run one DELETE per tier:

```rust
// Pseudocode
let hop_map = get_all_hop_distances(&graph, &own_pubkey, 2);
let retention = db.get_retention_config()?;

for tier in ["follows", "fof", "others"] {
    let pubkeys: Vec<&str> = match tier {
        "follows" => hop_map.iter().filter(|(_, &h)| h == 1).map(|(pk, _)| pk.as_ref()).collect(),
        "fof"     => hop_map.iter().filter(|(_, &h)| h == 2).map(|(pk, _)| pk.as_ref()).collect(),
        "others"  => /* all pubkeys in events NOT in hop_map, NOT own, NOT tracked */,
    };
    let config = retention.get(tier);
    db.prune_tier(&pubkeys, config.min_events, config.time_window_secs)?;
}
```

The `db.prune_tier()` function handles the per-pubkey cutoff calculation and batch deletion in SQL.

---

## Never pruned

Regardless of tier or settings, these are NEVER deleted:
- Own events (pubkey = own)
- Tracked profiles' events
- Replaceable metadata: kinds 0, 3, 10000, 10002
- Deletion events: kind 5
- Deletion tombstones (in `deletion_tombstones` table)
- The latest version of any parameterized replaceable event (kinds 30000-39999)

---

## Media pruning

- Own media: never evicted.
- Tracked profiles' media: never evicted.
- Others' media: evicted LRU when total exceeds configured media GB limit.
- When a content event is pruned, its associated media files are eligible for eviction (but not immediately deleted — they go through LRU).

---

## Storage Settings UI

The Storage screen gets a sidebar panel for configuring retention per tier:

```
+-----------------------------------+
|  Event Retention                  |
|                                   |
|  Direct Follows                   |
|  +-------------+ +---------------+|
|  | 50 events   | | 30 days       ||
|  +-------------+ +---------------+|
|  Keep at least 50 events per      |
|  user, or all events from the     |
|  last 30 days -- whichever is     |
|  more.                            |
|                                   |
|  Follows of Follows               |
|  +-------------+ +---------------+|
|  | 10 events   | | 7 days        ||
|  +-------------+ +---------------+|
|                                   |
|  Others                           |
|  +-------------+ +---------------+|
|  | 5 events    | | 3 days        ||
|  +-------------+ +---------------+|
|  Thread context and strangers.    |
|                                   |
|  Media Storage                    |
|  +-------------------------+      |
|  | oooooooo.. 2 GB         |      |
|  +-------------------------+      |
|  Others' media. Own media is      |
|  always kept.                     |
+-----------------------------------+
```

Each tier shows two inputs: an event count input and a time window dropdown. A small explanation line below each tier clarifies the "whichever keeps more" logic.
