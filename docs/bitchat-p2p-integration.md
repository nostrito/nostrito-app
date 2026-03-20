# BitChat & Gozzip P2P Integration

Extend Nostrito's event transmission beyond relay-only to include Bluetooth mesh (BitChat) and peer-storage pacts (Gozzip.org), creating a multi-network Nostr client that works offline and resists censorship.

---

## Why P2P Event Transmission

Nostrito currently depends entirely on WebSocket relays for event propagation. This creates three problems:

1. **Relay dependency** — `spawn_outbound_broadcaster()` (`lib.rs:47`) creates a fresh `nostr_sdk::Client` per broadcast, connecting to configured outbound relays each time. If the internet goes down, events cannot propagate at all. The 5-phase sync engine (`sync/engine.rs`) cannot fetch new content without relay connectivity either.

2. **Censorship surface** — All configured outbound relays (`AppConfig.outbound_relays`) are centrally operated. If relays choose to censor content or users, Nostrito has no alternative delivery path.

3. **Local-first latency** — Events published by nearby users (same conference, neighborhood, protest) take a round-trip through remote relays before appearing in feeds. Bluetooth mesh delivers them in milliseconds.

### What BitChat and Gozzip.org Bring

| System | Transport | Key Benefit |
|--------|-----------|-------------|
| **BitChat** | Bluetooth LE mesh (offline, ~30m range, up to 7 hops) | Offline local P2P, censorship-immune |
| **Gozzip.org** | Internet (peer storage pacts over Nostr-compatible keys) | Decentralized persistence without relay operators |

---

## Current Architecture

### Event Flow

Two paths exist today:

```
Path A: WebSocket Relay
─────────────────────────────────────────────────────────────────
Client app
  │ ws://127.0.0.1:4869
  v
relay/server.rs  handle_event()
  │
  ├──> SQLite  db.store_event()
  │
  ├──> broadcast_tx ──> all connected WS clients (local)
  │
  └──> outbound_tx ──> spawn_outbound_broadcaster()  (lib.rs:47)
                          │
                          ├──> nostr_sdk::Client
                          │      ├── wss://relay.primal.net
                          │      ├── wss://relay.damus.io
                          │      ├── wss://nos.lol
                          │      └── ... (up to 14 relays)
                          │
                          └──> macOS notification (tauri-plugin-notification)

Path B: Direct Tauri Commands (reactions, zaps)
─────────────────────────────────────────────────────────────────
Frontend
  │ invoke("publish_reaction") / invoke("send_zap")
  v
lib.rs  publish_reaction() / send_zap()
  │
  ├──> nostr_sdk::Client ──> outbound relays (direct)
  └──> store locally
```

### Key Integration Points

| Component | File | Type / Function | Role |
|-----------|------|-----------------|------|
| Outbound sender | `relay/server.rs:24` | `OutboundEventSender` (`mpsc::UnboundedSender<String>`) | Channel for forwarding new events |
| Outbound broadcaster | `lib.rs:47` | `spawn_outbound_broadcaster()` | Receives events, fans out to relays |
| Event storage | `storage/db.rs` | `Database::store_event()` | Persists events in SQLite |
| Sync engine | `sync/engine.rs` | `SyncEngine::run()` | 5-phase fetch cycle |
| WoT graph | `wot/` | `WotGraph` | Trust-based filtering |
| Event processing | `sync/processing.rs` | `process_event()` | Kind-specific event pipeline |

### Current Limitations

- No offline event propagation
- No local-network peer discovery
- No peer-to-peer storage agreements
- No Bluetooth/BLE capability
- All event signing requires nsec or NIP-46 bunker (both need internet for bunker mode)

---

## BitChat Integration (Bluetooth Mesh Layer)

### Overview

BitChat is a decentralized P2P messaging system that combines:

- **BLE GATT service** — Devices advertise and scan for nearby peers
- **Noise Protocol (XX pattern)** — X25519 key exchange + AES-256-GCM encryption for transport
- **7-hop mesh** — Messages relay through up to 7 intermediate devices (~210m effective range)
- **NIP-17** — Encrypted private messages over Nostr
- **LZ4 compression** — Bandwidth-efficient message encoding

GitHub: [permissionlesstech/bitchat](https://github.com/permissionlesstech/bitchat)

### Identity Bridging

BitChat uses **Ed25519** for its Noise Protocol transport. Nostr uses **secp256k1 Schnorr** for event signatures. Three approaches:

| Approach | Pros | Cons | Recommended |
|----------|------|------|:-----------:|
| **Use BLE as raw transport** for standard Nostr events (secp256k1 signed) | Simplest integration, no key translation | Loses BitChat's own auth model | Phase 1 |
| **Dual key derivation** (HKDF-SHA256 from nsec with domain separation `"bitchat-ed25519"`) | Single secret | Custom, non-standard | Phase 2+ |
| **Separate Ed25519 keypair** linked via signed attestation event | Clean separation | Two keys to manage | Future |

**Recommendation:** Start with option 1 — use BLE purely as a transport pipe for standard Nostr event JSON. This lets us integrate with the existing event pipeline without any key management changes.

### Rust Module Structure

```
src-tauri/src/p2p/
  mod.rs          Module exports, P2pManager lifecycle
  ble.rs          BLE scanner/advertiser (btleplug crate)
  mesh.rs         Multi-hop routing, TTL management, duplicate detection
  bridge.rs       BLE <-> local event pipeline bridge
  types.rs        BleMessage, MeshHeader, PeerInfo, P2pConfig
```

### BLE Transport Protocol

Wire format for mesh messages wrapping Nostr events:

```json
{
  "v": 1,
  "ttl": 7,
  "hops": 0,
  "origin": "<32-byte hex peer ID>",
  "hash": "<sha256 of payload>",
  "payload": "<nostr event JSON>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `v` | `u8` | Protocol version |
| `ttl` | `u8` | Remaining hops (decremented on forward, discard at 0) |
| `hops` | `u8` | Number of hops traversed so far |
| `origin` | `String` | Originating peer ID (for loop prevention) |
| `hash` | `String` | SHA-256 of `payload` (for deduplication) |
| `payload` | `String` | Raw Nostr event JSON (secp256k1 signed) |

BLE specifics:
- GATT service UUID: `0xNOST` (to be assigned)
- Characteristic: notify (outbound) + write-without-response (inbound)
- MTU negotiation: request 512 bytes, fragment larger events across multiple writes
- LZ4 compression on `payload` when > 256 bytes

### Event Flow with BLE

```
Outbound (local event → nearby peers):
──────────────────────────────────────
relay/server.rs
  outbound_tx ──> EventRouter (new)
                    │
                    ├──> Relay broadcaster (existing path)
                    │
                    └──> p2p/bridge.rs
                           │ wrap in BleMessage (ttl=7, hops=0)
                           v
                         p2p/ble.rs
                           │ GATT notify
                           v
                         Nearby BLE peers

Inbound (nearby peer → local storage):
──────────────────────────────────────
Nearby BLE peer
  │ GATT write
  v
p2p/ble.rs
  │ receive BleMessage
  v
p2p/bridge.rs
  │ 1. Check dedup (moka LRU on hash)
  │ 2. Verify Nostr event signature
  │ 3. Decrement TTL
  v
  ├──> process_event() ──> SQLite (store)
  │
  └──> IF ttl > 0: re-advertise via BLE (mesh forward)
       IF online: forward to relay broadcaster (bridge to internet)
```

### Deduplication

BLE mesh messages arrive multiple times via different paths. Three-layer strategy:

1. **In-memory LRU** — `moka` cache (already a dependency) keyed on `BleMessage.hash`. ~10,000 entries, 5-minute TTL. Prevents re-broadcasting.
2. **SQLite constraint** — `nostr_events.id PRIMARY KEY` prevents duplicate storage (already exists).
3. **Echo prevention** — Events that arrived via P2P are NOT re-sent to the outbound relay broadcaster if they're already present in SQLite (prevents internet echo loops).

### Platform Considerations

| Platform | BLE Library | Notes |
|----------|-------------|-------|
| **macOS** | `btleplug` (CoreBluetooth backend) | Requires Bluetooth entitlement in app bundle |
| **Android** | `btleplug` Android backend or JNI bridge | Tauri mobile entry point already exists (`src-tauri/src/main.rs`) |
| **iOS** | CoreBluetooth via `btleplug` | Requires background BLE entitlements (future) |

New Cargo dependencies:

```toml
btleplug = "0.11"        # Cross-platform BLE
uuid = "1"                # GATT service/characteristic UUIDs
```

---

## Gozzip.org Integration (Storage Pacts)

### Overview

Gozzip is a decentralized social protocol where the **social graph itself becomes the infrastructure**. Instead of relying on relay operators, peers form bilateral "storage pacts" — cryptographically verified agreements to store each other's data.

Key properties:
- **Identity compatibility** — Uses the same **secp256k1** keypair system as Nostr. A Nostrito user's existing nsec/npub works directly. No key translation needed.
- **Self-authenticating events** — Events are portable across protocols (Nostr, ActivityPub, AT Protocol)
- **Two node types:**
  - **Keepers** (full nodes, always-on) — Store complete event history
  - **Witnesses** (light nodes) — Store recent 30 days, sync when available

### Storage Pact Data Model

New SQLite table for tracking pacts:

```sql
CREATE TABLE IF NOT EXISTS storage_pacts (
    pact_id         TEXT    NOT NULL PRIMARY KEY,
    peer_pubkey     TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER,
    our_role        TEXT    NOT NULL,   -- 'keeper' or 'witness'
    peer_role       TEXT    NOT NULL,   -- 'keeper' or 'witness'
    status          TEXT    NOT NULL DEFAULT 'active',
    last_verified   INTEGER,
    events_we_store INTEGER DEFAULT 0, -- count of events we hold for peer
    events_they_store INTEGER DEFAULT 0, -- count of our events peer holds
    storage_bytes   INTEGER DEFAULT 0  -- bytes used by pact
);

CREATE INDEX idx_pacts_peer ON storage_pacts(peer_pubkey);
CREATE INDEX idx_pacts_status ON storage_pacts(status);
```

### Rust Module Structure

```
src-tauri/src/p2p/
  gozzip.rs       Gozzip protocol client: pact negotiation, sync, verification
  pact_store.rs   SQLite operations for storage_pacts table
```

### Pact Lifecycle

```
1. Discovery          Find candidates from WoT graph (hop 1-2 follows)
       │               Use existing WotGraph in wot/
       v
2. Negotiation        Exchange proposals via NIP-17 encrypted DMs
       │               Terms: duration, event kinds, storage limits
       v
3. Activation         Both parties sign pact event (new kind, both pubkeys in tags)
       │               Each side begins storing the other's events
       v
4. Verification       Periodic Merkle proofs over stored event IDs
       │               Proves data is still held without transferring it
       v
5. Expiry/Renewal     Optional expiry date. Auto-renew if both parties active.
```

### Event Flow with Gozzip

```
Outbound:
─────────
EventRouter
  └──> gozzip.rs
         │ For each active pact partner:
         │   send event via their preferred relay (from NIP-65)
         │   or via direct WebSocket if peer supports it
         v
       Pact partner stores event (fulfilling pact obligation)

Inbound:
────────
gozzip.rs
  │ Query pact partners for events we're missing
  │ (prioritize over public relay queries — trusted, low-latency)
  v
process_event()  ──>  SQLite

Recovery:
─────────
If our local DB is lost:
  1. Query all active pact Keepers for our complete history
  2. Verify each event signature
  3. Rebuild local database from pact partner copies
```

### Gozzip vs Relays

| Aspect | Traditional Relays | Gozzip Pacts |
|--------|-------------------|--------------|
| **Trust model** | Trust relay operator | Trust social graph (WoT) |
| **Storage guarantee** | None (relay can drop events) | Cryptographically verified |
| **Cost** | Free or paid per relay | Reciprocal (you store mine, I store yours) |
| **Discovery** | Hardcoded list or NIP-65 | WoT-based peer discovery |
| **Censorship** | Relay can censor | Peer-to-peer, no gatekeeper |
| **Availability** | Relay uptime | Distributed across pact partners |

---

## Multi-Network Event Transmission

### Unified EventRouter

The core architectural change: replace `spawn_outbound_broadcaster()` with an `EventRouter` that fans events out to all three networks.

```
                              +-----------------+
relay/server.rs  ────────────>|                 |────> Relay Broadcaster (existing)
  (OutboundEventSender)       |   EventRouter   |────> BLE Mesh (p2p/bridge.rs)
                              |                 |────> Gozzip Peers (p2p/gozzip.rs)
Tauri commands  ─────────────>|                 |────> Offline Queue (if no connectivity)
  (publish_reaction, etc.)    +-----------------+
```

```rust
// Proposed EventRouter API (lib.rs)
struct EventRouter {
    relay_tx:  mpsc::UnboundedSender<String>,   // existing path
    ble_tx:    Option<mpsc::UnboundedSender<String>>,  // BitChat
    gozzip_tx: Option<mpsc::UnboundedSender<String>>,  // Gozzip
    offline_queue: Arc<RwLock<Vec<String>>>,     // drain when online
}

impl EventRouter {
    async fn route(&self, event_json: String, source: EventSource) {
        // Always store locally
        // Route to relay (if online)
        // Route to BLE (if enabled and event is public)
        // Route to Gozzip pact peers (if enabled)
        // Queue if all networks unavailable
    }
}
```

### Inbound Event Merging

Events arrive from three sources but all enter the same processing pipeline:

```
Relay sync (sync/engine.rs)   ─┐
BLE mesh (p2p/bridge.rs)       ├──> process_event() ──> SQLite
Gozzip peers (p2p/gozzip.rs)   ┘
```

Deduplication is handled by SQLite's `id PRIMARY KEY` constraint (already exists). Extend the event source tracking to include P2P origins:

```rust
pub enum EventSource {
    WebSocket,      // existing
    RelaySync,      // existing
    Restore,        // existing
    BleMesh,        // NEW
    GozzipPact,     // NEW
}
```

### Network Priority by Scenario

| Scenario | Priority Order |
|----------|----------------|
| **Offline** (no internet) | BLE mesh → Gozzip (if peer is local) → offline queue |
| **Online + local peers** | BLE mesh (immediate) + relay (background) + Gozzip |
| **Online, no local peers** | Relay + Gozzip pact peers |
| **Fetching historical events** | Gozzip pact Keepers (trusted) → public relays |
| **Recovery after data loss** | Gozzip pact Keepers → relays → BLE (limited history) |

### Sync Phase Extension

Add a 6th phase to the sync cycle:

```
Cycle N
  ├── Phase 1: Own Data
  ├── Phase 2: Discovery
  ├── Phase 3: Content Fetch (relay-centric)
  ├── Phase 4: Thread Context
  ├── Phase 5: Media Download
  ├── Phase 6: P2P Sync (NEW)
  │     ├── 6a: BLE mesh scan (discover nearby peers, exchange recent events)
  │     ├── 6b: Gozzip pact sync (query pact partners for missing events)
  │     └── 6c: Gozzip pact verification (periodic Merkle proof checks)
  └── [wait cycle_interval_secs]
```

---

## Implementation Phases

### Phase 0: Foundation

- Create `src-tauri/src/p2p/` module directory with `mod.rs`, `types.rs`
- Define `P2pConfig` struct (BLE enabled/disabled, Gozzip enabled/disabled, mesh TTL, max peers)
- Add P2P settings to `AppConfig` and Settings UI
- Extend `EventSource` enum with `BleMesh` and `GozzipPact` variants
- Stub `EventRouter` that wraps existing `spawn_outbound_broadcaster`

### Phase 1: BLE Mesh — Receive Only

- Add `btleplug` dependency
- Implement BLE scanner in `p2p/ble.rs` — discover nearby Nostr/BitChat peers
- Implement `p2p/bridge.rs` — receive `BleMessage`, validate Nostr event signatures, store via `process_event()`
- Dedup via `moka` LRU cache
- No broadcasting yet — passive reception only
- UI: indicator showing nearby BLE peer count

### Phase 2: BLE Mesh — Bidirectional

- Implement BLE GATT server (advertise as a Nostr BLE peer)
- Route outbound events from `EventRouter` to BLE
- Implement mesh forwarding (TTL-based multi-hop)
- Add peer discovery UI (list nearby BLE peers in Settings)
- Filter: only broadcast public events (kind 1, 6, 7) over BLE — never encrypted DMs

### Phase 3: Gozzip Storage Pacts

- Add `storage_pacts` table and `pact_store.rs`
- Implement pact negotiation protocol in `gozzip.rs`
- Integrate with `WotGraph` for peer selection (hop 1-2 follows)
- Pact sync: push our events to partners, pull their events
- Add pact management UI (active pacts, storage used, verification status)

### Phase 4: Unified EventRouter

- Refactor `spawn_outbound_broadcaster` into full `EventRouter`
- Parallel dispatch to relay, BLE, and Gozzip channels
- Implement offline queue (events created while offline, dispatched when connectivity returns)
- Add Phase 6 (P2P Sync) to sync cycle
- Source-aware dedup (prevent echo loops between networks)

### Phase 5: Advanced Features

- Gozzip Merkle verification proofs
- BLE mesh optimization (adaptive TTL based on peer density)
- Cross-network event propagation analytics
- Data recovery from pact partners after local DB loss
- Gozzip pact auto-discovery and auto-negotiation

---

## Technical Considerations

### Encryption and Privacy

- **BLE mesh broadcasts are public** — anyone in range can receive. Only broadcast public events (kind 1, 6, 7, 0, 3) over BLE. Never transmit kind 4 (encrypted DMs) or kind 1059 (gift-wrapped) over BLE.
- **Gozzip pact storage** — Pact partners see all event content they store. Allow users to configure which event kinds to include in pacts (e.g., exclude kind 4, 7).
- **NIP-17** — For private P2P messages between known peers, use NIP-17 encryption (already part of BitChat's design).

### Signature Verification for P2P Ingress

The existing relay `handle_event()` in `server.rs` trusts the local client and does not verify signatures. For P2P ingress from untrusted peers, explicit verification is required:

```rust
// p2p/bridge.rs — required for all BLE and Gozzip ingress
use nostr_sdk::Event;

fn validate_p2p_event(event: &Event) -> Result<(), String> {
    event.verify()
        .map_err(|e| format!("Invalid signature from P2P peer: {}", e))?;
    Ok(())
}
```

### WoT-Based P2P Filtering

Not all P2P events should be stored. Apply trust-distance filtering (mirrors existing `RetentionTier` logic):

| WoT Distance | Storage Policy |
|:------------:|----------------|
| Hop 0 (self) | Always store |
| Hop 1-2 (follows, follows-of-follows) | Store all event kinds |
| Hop 3+ | Store metadata only (kind 0, kind 3) |
| Unknown pubkey | Discard (unless explicitly whitelisted) |

### Bandwidth and Storage

**BLE bandwidth:**
- BLE 5.0: ~2 Mbps theoretical, ~1 Mbps practical
- Typical kind:1 event: ~500 bytes
- With mesh overhead (7 hops max): 7x amplification in worst case
- Budget: ~100-200 events/second throughput per peer

**Gozzip storage budget:**
- Must integrate with existing `AppConfig.max_storage_mb` and tiered pruning
- Events stored for pact partners should have their own storage tier and budget
- Suggested default: 10% of `max_storage_mb` allocated to pact obligations
- Pruning priority: pact events are lower priority than own events but higher than WoT hop 3+ events

### Echo Loop Prevention

When events flow between networks, loops can form:

```
Event created locally
  → sent to relay
  → relay sends to remote client
  → remote client's BLE broadcasts it
  → we receive it via BLE
  → we forward to relay again (LOOP!)
```

Prevention:
1. Tag outbound events with a per-session nonce in the `EventRouter`
2. Track `nostr_events.id` that we've already processed (SQLite gives this for free)
3. Never re-route an event to a network it already arrived from (source-aware routing)

---

## Open Questions

| Question | Options | Notes |
|----------|---------|-------|
| BLE foreground-only or background? | Foreground only vs. background service | Battery impact vs. mesh resilience |
| Gozzip pact events: same table or separate? | `nostr_events` with `source='gozzip_pact'` vs. new `pact_events` table | Pruning complexity, query performance |
| NIP-46 bunker signing + offline BLE? | Require nsec for BLE mode vs. queue-and-sign-later | NIP-46 needs relay roundtrip, incompatible with offline |
| BitChat protocol version compat? | Pin to specific version vs. negotiate | BitChat is evolving rapidly |
| Gozzip pact negotiation channel? | NIP-17 DMs vs. custom event kind (30xxx) | Interoperability vs. specificity |
| How to handle relay-only users? | Graceful fallback vs. require P2P | Most Nostr users don't run P2P nodes yet |
| BLE scanning power management? | Continuous vs. periodic (every N seconds) | Battery vs. responsiveness tradeoff |

---

## References

- [BitChat GitHub](https://github.com/permissionlesstech/bitchat) — Bluetooth mesh chat implementation
- [Gozzip.org](https://gozzip.org) — Decentralized storage pact protocol
- [btleplug](https://github.com/deviceplug/btleplug) — Cross-platform Rust BLE library
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) — Private direct messages
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay list metadata
- [Noise Protocol](https://noiseprotocol.org/) — Framework for crypto protocols
- [NostrP2P](https://github.com/ryogrid/nostrp2p) — Pure P2P Nostr microblogging experiment
