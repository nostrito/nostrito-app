# Search Architecture

> Part of [Sync Engine v2](./README.md)

Hybrid search combining local database results with global relay queries (NIP-50), organized by social proximity.

---

## Search sources

| Source | Protocol | What it finds | Latency |
|--------|----------|--------------|---------|
| **Local DB** | SQLite FTS or LIKE | Events we already have stored | <10ms |
| **relay.nostr.band** | NIP-50 (`search` filter extension) | Full network index, notes + profiles | 200-500ms |
| **relay.primal.net** | NIP-50 | Primal's curated index, trending-weighted | 200-500ms |

relay.damus.io is NOT included for text search since it doesn't support NIP-50. It is used only for direct lookups (npub/note bech32 resolution).

---

## Search flow

When the user types a query:

```
1. LOCAL SEARCH (immediate, no network)
   |-- Query local events table: content LIKE '%query%'
   |-- Query local profiles: name/display_name/nip05 LIKE '%query%'
   +-- Return results instantly while remote searches run

2. GLOBAL SEARCH (parallel, async)
   |-- relay.nostr.band:  Filter { search: "query", kinds: [0,1,30023], limit: 50 }
   +-- relay.primal.net:  Filter { search: "query", kinds: [0,1,30023], limit: 50 }

3. MERGE + DEDUPLICATE
   +-- Combine all results, deduplicate by event ID
```

---

## Result grouping and ranking

Results are displayed in two sections:

```
+--------------------------------------------+
|  [search] "bitcoin lightning"              |
|                                            |
|  -- From your network ------------------- |
|                                            |
|  [hop 1] @alice -- "Bitcoin Lightning..."  |
|  [hop 1] @bob -- "Lightning network..."   |
|  [hop 2] @carol -- "BTC lightning..."     |
|                                            |
|  -- Global results ---------------------- |
|                                            |
|  @dave -- "Bitcoin Lightning adoption..."  |
|  @eve -- "Lightning wallets review..."    |
|  @frank -- "Building on Lightning..."     |
|                                            |
+--------------------------------------------+
```

**"From your network" section:**
- All results where the author is in our WoT (any hop distance).
- Sorted by: hop distance ASC (closer = higher), then relevance score, then recency.
- Hop distance shown as a subtle badge.
- Includes results from BOTH local DB and global relays (if relay.nostr.band returns an event by someone in our WoT, it goes here).

**"Global results" section:**
- All results where the author is NOT in our WoT.
- Deduped against the network section — if an event already appeared above, skip it.
- Sorted by: relevance score from the relay (relay.nostr.band returns events in relevance order), then recency.
- No hop badge (these are strangers).

---

## Ranking score

For local results and WoT-member results from global relays:

```
score = relevance_weight * text_match_quality
      + recency_weight * (1.0 / (1.0 + hours_since_post / 24.0))
      + proximity_weight * (1.0 / (1.0 + hop_distance))

Where:
  relevance_weight = 0.4
  recency_weight   = 0.3
  proximity_weight = 0.3
```

For global (non-WoT) results, preserve the relay's native ordering (relay.nostr.band already ranks by relevance). Interleave results from multiple relays by deduplicating — first occurrence wins.

---

## NIP-50 search filter

NIP-50 extends the standard Nostr filter with a `search` field:

```json
["REQ", "search-sub", {
  "search": "bitcoin lightning",
  "kinds": [0, 1, 30023],
  "limit": 50
}]
```

Supported by relay.nostr.band and relay.primal.net. NOT supported by most other relays (check NIP-11 `supported_nips` for `50`).

---

## Profile search vs. content search

The search input handles both:

| Query pattern | Behavior |
|---------------|----------|
| Plain text (`bitcoin`) | Search note content + article content + profile names |
| `@username` | Profile search only (kind:0, match on name/display_name/nip05) |
| `npub1...` | Direct pubkey lookup (decode bech32, fetch profile) |
| `note1...` | Direct event lookup (decode bech32, fetch event) |
| `user@domain.com` | NIP-05 resolution (verify + fetch profile + relay hints) |

For `npub1...` and `note1...` lookups, relay.damus.io CAN be queried (standard filter by id/author, no NIP-50 needed).

---

## Connection management for search relays

Search relays (relay.nostr.band, relay.primal.net) are **not** part of the sync relay pool. They are connected on-demand when the user initiates a search, and disconnected after results arrive or after 30 seconds idle.

They do NOT count against the MAX_CONNECTIONS pool limit — search is a separate, user-initiated action that should never be blocked by sync.

---

## Storing global search results

Events fetched from global search are stored in the local `events` table with `source = 'search'`. This means:
- Searching for "bitcoin" and clicking a result caches that event locally.
- The next time the user searches the same term, that event appears in local results.
- These events are pruned under the "Others" tier retention (default: 5 events, 3 days) unless the author turns out to be in the WoT.
- Profiles (kind:0) from search results are cached but not added to the WoT graph unless the user follows them.
