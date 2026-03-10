# Discovery

> Part of [Sync Engine v2](./README.md)

NIP-65 relay lists, NIP-05 identity resolution, NIP-42 relay authentication, NIP-11 relay info, purplepag.es indexer, and the relay fallback chain.

---

## Relay Fallback Chain

When we need to find a user's relay preferences, try sources in this order:

```
1. kind:10002 write relays (from user_relays where source='nip65')
     ↓ not found
2. NIP-05 relay hints (from user_relays where source='nip05')
     ↓ not found
3. kind:3 relay hints (from user_relays where source='kind3_hint')
     ↓ not found
4. User-configured relays (outbound_relays from app_config)
     ↓ all fail
5. Hardcoded defaults: damus, primal, nos.lol
```

Each level is tried in reliability-score order (best relay first).

When we need to discover a user's kind:10002 for the first time:

```
1. NIP-05 resolution (if user has nip05 field) — may return relay hints directly
     ↓ no relay hints or no nip05
2. purplepag.es on-demand query (first-run bootstrap or profile view)
     ↓ not found
3. user.kindpag.es fallback
     ↓ not found
4. Query configured relays for kind:10002
```

---

## Discovery Relay (purplepag.es)

`wss://purplepag.es` is a specialized indexer relay built for profile and social graph discovery.

### What it stores

purplepag.es is NOT just kind:0 + kind:10002. It accepts and indexes:
- **kind:0** — profile metadata
- **kind:3** — contact lists (follow lists)
- **NIP-51 list kinds:** kind:10000-10102 (mute lists, pin lists, bookmark lists, relay lists, follow sets, etc.), kind:30000-30030, and a handful of other list kinds

It also supports:
- **NIP-45 COUNT** — we can query follower/following counts without downloading full contact lists
- **NIP-42 AUTH** — optional, not required
- **NIP-9 deletion** — respects kind:5
- **Max 50 concurrent subscriptions**, max 500 events per filter result

It does NOT store content events (kind:1, 6, 30023, etc.).

### What it does NOT have

- No NIP-50 full-text search (use `wss://relay.nostr.band` for that)
- No content events — only metadata and lists

### Connection policy: on-demand, not persistent

purplepag.es is NOT always connected. It is connected and queried only when:
1. **User opens a profile view** for someone whose relay list we don't have.
2. **User initiates a zap** to someone whose relay list we don't have (need read relays to deliver the zap receipt).
3. **First sync after app install** — one-time batch bootstrap of kind:0, kind:3, kind:10002 for all follows.
4. **A new follow is added** — fetch their kind:10002 + kind:0 on demand.
5. **NIP-05 resolution falls back** — when NIP-05 doesn't provide relay hints.

After the query completes, the connection is released (subject to normal idle timeout).

**NOT used for:**
- Periodic background sync (we get kind:10002 updates passively via Phase 3 content fetching).
- Content fetching.
- The user's outbound relay configuration.

If purplepag.es is down, fall back to `wss://user.kindpag.es` (sibling relay, stores kind:0/3/10002), then to configured relays.

### Other indexer relays (for reference)

| Relay | Focus | Useful for |
|-------|-------|-----------|
| `wss://purplepag.es` | Profiles + social graph + lists | Bootstrap relay discovery, follower counts |
| `wss://user.kindpag.es` | kind:0, 3, 10002 only | Fallback for purplepag.es |
| `wss://relay.nostr.band` | Full index + NIP-50 search | Profile/note search, event counting |
| `wss://indexer.coracle.social` | kind:10002 only | Ultra-focused NIP-65 bootstrap |

---

## NIP-05 Relay Discovery

When a user has a NIP-05 identifier in their kind:0 profile (e.g., `alice@example.com`), we can resolve it to get both identity verification and relay hints.

### Flow

```
GET https://example.com/.well-known/nostr.json?name=alice

Response:
{
  "names": { "alice": "<hex-pubkey>" },
  "relays": { "<hex-pubkey>": ["wss://relay1.example.com", "wss://relay2.example.com"] }
}
```

The `relays` field is optional — many providers omit it. When present, it gives us relay hints without needing to query an indexer.

### When we resolve NIP-05

- **On profile view:** When user navigates to a profile that has a `nip05` field in their kind:0. Verify the identifier and cache relay hints.
- **On new follow:** If the followed user has a NIP-05, resolve it to seed their relay routing.
- **NOT eagerly for all follows.** NIP-05 lookups are HTTP requests that expose our IP to the domain operator. Only resolve on user-initiated actions.

### Integration with relay discovery

NIP-05 relay hints are stored in `user_relays` with `source = 'nip05'`. They sit between kind:3 hints and NIP-65 in authority:

```
nip65 (kind:10002) > nip05 (.well-known) > kind3_hint (p-tag relay hints)
```

If a NIP-05 resolution returns relay hints AND we later get a kind:10002 from that user, the kind:10002 data replaces the NIP-05 hints.

### nostr-sdk API

```rust
use nostr::nips::nip05;

// Returns Nip05Profile { public_key, relays: Vec<Url>, nip46: Vec<Url> }
let profile = nip05::profile("alice@example.com", None).await?;

// Verify only (no relay data)
let valid = nip05::verify(&pubkey, "alice@example.com", None).await?;
```

Both functions are available in nostr-sdk 0.35 with the `nip05` feature (enabled by default).

### Privacy considerations

- Every NIP-05 lookup reveals our IP to the domain hosting `.well-known/nostr.json`.
- The `?name=` parameter reveals which identity we're resolving.
- We cache results and minimize repeat lookups. Re-verify at most every 24 hours.
- Never resolve NIP-05 in background sync — only on user-initiated profile views or follows.

---

## NIP-42 Relay Authentication

Some relays require authentication before serving events (especially DMs, private groups, and paid relays).

### How it works

1. Relay sends `["AUTH", "<challenge>"]` on connect.
2. Client signs a kind:22242 ephemeral event containing the challenge and relay URL.
3. Client sends `["AUTH", <signed-event>]` back to that specific relay.
4. Relay verifies the signature and grants access.
5. Client resubscribes any subscriptions that were previously rejected.

### nostr-sdk handles this automatically

nostr-sdk 0.35 has **NIP-42 auto-authentication enabled by default**. When a relay sends an AUTH challenge, the SDK:
1. Intercepts it in the background notification handler.
2. Builds and signs a kind:22242 event using the client's signer (Keys, NIP-46, or NIP-07).
3. Sends the AUTH response.
4. Automatically resubscribes any subscriptions that were closed with `auth-required:`.

**Zero extra code needed** as long as the client has a signer configured.

### Relay response prefixes

- `"auth-required: <message>"` — client must authenticate first (solvable).
- `"restricted: <message>"` — client authenticated but doesn't have access (e.g., not on whitelist, hasn't paid).

### Integration with relay pool

- The relay pool should log AUTH events for debugging.
- When a relay responds with `restricted:`, mark it in `relay_stats` and deprioritize it — don't retry auth in a loop.
- NIP-11 info document tells us upfront if `auth_required: true` — use this to warn users before adding such relays.
- NIP-42 works transparently with NIP-46 remote signers (the signer signs kind:22242 the same way it signs any other event).

---

## NIP-11 Relay Info Document

On first encounter with any relay, and periodically (every 24h), fetch the relay's NIP-11 info document:

```
GET https://relay.example.com/ (with Accept: application/nostr+json)
```

Note: Convert `wss://` URLs to `https://` for the HTTP request (same host, same port or default 443).

Store results in the `relay_info` table (see [Data Model](./data-model.md)).

Use this data to:
- Sort relays in the cover set algorithm (prefer relays that support NIP-65, NIP-45).
- Show relay info cards in Settings > Relays.
- Warn before adding a relay that requires payment or auth.
