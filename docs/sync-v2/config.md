# Configuration & Reference

> Part of [Sync Engine v2](./README.md)

User-configurable settings, hardcoded constants, event kind reference, and decided design questions.

---

## User-configurable (Settings UI)

### General

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Outbound relays | damus, primal, nos.lol | 1-20 | User's preferred relays |
| Sync cycle interval | 5 min | 1-60 min | Time between full cycles |
| Lookback days | 30 | 1-365 | How far back on first sync |
| Max relay connections | 25 | 5-30 | Simultaneous WebSocket connections |

### Storage — Tiered Retention (Settings > Storage sidebar)

| Tier | Min Events Default | Min Events Range | Time Window Default | Time Window Options |
|------|-------------------|-----------------|--------------------|--------------------|
| Direct follows | 50 | 10-500 | 30 days | 3d, 7d, 14d, 30d, 90d, 1y |
| Follows of follows | 10 | 5-100 | 7 days | 1d, 3d, 7d, 14d, 30d, 90d |
| Others | 5 | 1-50 | 3 days | 1d, 3d, 7d, 14d, 30d |

### Storage — Media

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Media storage GB | 2 | 0.5-50 | Max disk for others' media |

---

## Hardcoded (not user-configurable)

| Setting | Value | Rationale |
|---------|-------|-----------|
| Discovery relay | purplepag.es | Standard NIP-65 indexer (on-demand only) |
| Relay min interval | 3s | Polite default |
| Batch pause | 2s | Between relay subscriptions |
| Idle relay disconnect | 5 min | Free up connection slots |
| Connection backoff | 10/30/60/120/300s | Exponential on failure |
| Rate-limit pause | 90s | On relay NOTICE |
| Cursor overlap | 60s | Safety margin for per-user since |
| WoT crawl frequency | Every 6 cycles | ~30 min at default interval |
| History exhaustion | 3 empty cycles | Stop backfill for a relay after 3 empty responses |
| Thread context limit | 100 events/cycle | Cap on missing root fetches |

---

## Event Kind Reference

### Always stored, never pruned (replaceable metadata)

| Kind | Name | Side effects on arrival |
|------|------|------------------------|
| 0 | Profile metadata | Update profile cache |
| 3 | Contact list | Update WoT graph, extract relay hints |
| 10000 | Mute list | Rebuild mute tables (own only) |
| 10002 | Relay list (NIP-65) | Update user_relays routing table |

### Stored within tiered retention window (content)

Retention depends on author's WoT tier. See [Pruning](./pruning.md).

| Kind | Name | Side effects on arrival |
|------|------|------------------------|
| 1 | Text note | Queue media, check thread parents |
| 4 | Encrypted DM | Own only |
| 5 | Deletion | Delete referenced events, create tombstones (kept forever) |
| 6 | Repost | Queue media |
| 7 | Reaction | Own only |
| 9735 | Zap receipt | Own only |
| 30023 | Long-form article | Queue media (parameterized replaceable: latest per d-tag kept) |

### Fetch scope by hop distance

| Kind | Hop 0 (own) | Hop 1 (follows) | Hop 2 (FoF) | Thread context |
|------|-------------|-----------------|--------------|----------------|
| 0 | Yes | Yes | Yes (via crawl) | No |
| 1 | Yes | Yes | No | Yes (root only) |
| 3 | Yes | Yes | Yes (via crawl) | No |
| 4 | Yes | No | No | No |
| 5 | Yes | Yes | No | No |
| 6 | Yes | Yes | No | No |
| 7 | Yes | No | No | No |
| 9735 | Yes | No | No | No |
| 10000 | Yes | No | No | No |
| 10002 | Yes | Yes | Yes (via crawl) | No |
| 30023 | Yes | Yes | No | Yes (root only) |

---

## Decided Design Questions

1. **Private mutes (NIP-44):** Decrypt if signing key is available. Public mutes always processed. Signing key support is a prerequisite not yet implemented — see [Event Processing](./event-processing.md).

2. **Publishing own kind:10002:** Not auto-published. Add a "Publish Relay List" button in Settings (future feature, post-v2 launch).

3. **purplepag.es usage:** On-demand only — connect when viewing a profile or sending a zap for someone with no relay data. Not a persistent background connection. It stores much more than just kind:0/10002 — also kind:3, mute lists, and other NIP-51 lists. Supports NIP-45 COUNT for follower counts. See [Discovery](./discovery.md).

4. **Relay NIP-11 compliance checking:** Yes — query relay info documents to understand supported NIPs, payment requirements, and content policies. See [Discovery](./discovery.md).

5. **Parameterized replaceable events (30000-39999):** The `d` tag deduplication logic is generic for all parameterized replaceable kinds, not just kind:30023 articles. The uniqueness key is `(pubkey, kind, d_tag_value)`.

6. **NIP-05 relay discovery:** Integrated as part of the relay discovery fallback chain. Resolved on user-initiated actions (profile view, new follow), never eagerly in background. Privacy-conscious: exposes IP to domain operator. See [Discovery](./discovery.md).

7. **NIP-42 relay authentication:** Handled automatically by nostr-sdk 0.35 — zero extra code. Works transparently with local keys and NIP-46 remote signers. Relays that respond with `restricted:` (authenticated but not authorized) are deprioritized. See [Discovery](./discovery.md).

---

## Future Considerations

1. **Publishing own kind:10002:** Add a "Publish Relay List" button in Settings that broadcasts the user's configured outbound relays as a kind:10002 event to those same relays + purplepag.es. Post-v2 launch feature.

2. **Gozzip relay federation:** Tracked profiles lay the groundwork for nostrito nodes acting as voluntary data custodians. Future versions could serve tracked profile events to other relays.
