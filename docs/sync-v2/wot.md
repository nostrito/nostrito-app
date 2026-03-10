# WoT Graph

> Part of [Sync Engine v2](./README.md)

In-memory graph structure, hop tiers, and WoT crawl.

---

## Structure (same as today)

In-memory directed graph with integer IDs:
- Sorted adjacency lists for O(log n) edge lookup.
- String interning via `Arc<str>` for memory efficiency.
- `parking_lot::RwLock` for concurrent access.

---

## Who is in the WoT

| Hop | Description | Events fetched | Metadata kept |
|-----|-------------|----------------|---------------|
| 0 | Own pubkey | Everything, always | Always |
| 1 | Direct follows | Content + metadata | Always |
| 2 | Follows of follows | Metadata only (kind:0, 3, 10002) | Always |
| 3+ | Deeper graph | Nothing (graph edges only from kind:3) | Only if encountered |

---

## WoT crawl

Replaces the old Tier 3. Runs every 6 cycles (~30 min):

1. For each hop-1 follow, ensure we have their kind:3 (contact list).
2. Process kind:3 events to build hop-2 edges.
3. For each hop-1 follow's contact list, ensure we have kind:0 + kind:10002 for hop-2 pubkeys (query configured relays, NOT purplepag.es).
4. Checkpoint every 50 pubkeys processed (resume on restart).

**Depth is always 2 for content fetching, but the graph can extend further for distance calculations.** The `wot_max_depth` setting controls how deep the graph crawl goes for edge discovery, not for content fetching.

---

## New: Batch hop-distance function

The current WoT module only has pairwise BFS (`compute_distance(from, to)`). The [Pruning](./pruning.md) algorithm needs to classify ALL pubkeys by tier, which requires knowing their hop distance from the root pubkey.

**Required new function:**

```rust
/// BFS from root, returns hop distance for all reachable pubkeys up to max_hops.
/// Used by pruning to classify pubkeys into tiers.
pub fn get_all_hop_distances(
    graph: &WotGraph,
    root: &str,
    max_hops: u8,
) -> HashMap<Arc<str>, u8>
```

This is a single BFS traversal (O(V+E)) that returns a map of pubkey → hop distance. Run once before each pruning pass. The result can also be used by search ranking and feed display.
