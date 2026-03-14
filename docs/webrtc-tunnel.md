# WebRTC Mobile Tunnel

Connect mobile Nostr clients (Amethyst, Damus, Primal) to Nostrito's local relay from any network using a WebRTC data channel tunnel with Nostr-based signaling.

## Architecture

```
Phone
+-----------------------------+
| Nostr Client (Amethyst)     |
|   ws://localhost:4869       |
|           |                 |
|    +------v------+          |
|    | Bridge App  |          |
|    | (local WS   |          |
|    |  + WebRTC)  |          |
|    +------+------+          |
+-----------|-----------------+
            | WebRTC DataChannel
            | (signaled via Nostr encrypted events)
+-----------v-----------------+
|  Desktop (Nostrito)          |
|  +---------------+          |
|  | WebRTC peer   |          |
|  |   -> relay    |          |
|  +---------------+          |
+------------------------------+
```

**Two components:**
1. **Desktop (Nostrito)** -- New `tunnel/` Rust module with str0m WebRTC + Nostr signaling
2. **Phone (nostrito-bridge)** -- Companion Android app with local WebSocket relay + WebRTC tunnel

## How It Works

### Pairing (one-time)
1. Desktop: enter phone's npub in Settings > "Mobile Tunnel"
2. Phone: install nostrito-bridge, enter desktop's npub
3. Both sides know each other's pubkeys. No accounts, no servers.

### Connection
1. Phone creates WebRTC PeerConnection + data channel `"nostr-relay"`
2. Phone publishes SDP offer as NIP-04 encrypted kind 25050 ephemeral event
3. Desktop receives offer via Nostr relay, generates SDP answer, publishes it back
4. ICE candidates exchanged via same mechanism (trickle ICE)
5. DTLS handshake completes, data channel opens
6. Phone starts local WebSocket server on `127.0.0.1:4869`

### Data Flow

```
Amethyst (phone)
  | ws://localhost:4869
  v
LocalRelayServer (nostrito-bridge)
  | in-memory queue
  v
DataChannelBridge (nostrito-bridge)
  | WebRTC data channel (encrypted, NAT-traversed)
  v
tunnel/bridge.rs (Nostrito desktop)
  | calls handle_message()
  v
SQLite database
  | query results
  v
tunnel/bridge.rs -> WebRTC -> DataChannelBridge -> LocalRelayServer -> Amethyst
```

## Signaling Protocol

All signaling uses **kind 25050** ephemeral events, NIP-04 encrypted between paired pubkeys.

### Event Envelope

```json
{
  "kind": 25050,
  "pubkey": "<sender hex>",
  "tags": [["p", "<recipient hex>"]],
  "content": "<nip04-encrypted JSON>"
}
```

### Message Format (decrypted content)

```json
{
  "type": "offer" | "answer" | "ice-candidate" | "disconnect",
  "session_id": "<random-hex-16>",
  "payload": { ... }
}
```

### Message Types

**Offer** (phone -> desktop):
```json
{ "type": "offer", "session_id": "a1b2c3...", "payload": { "sdp": "<SDP offer string>" } }
```

**Answer** (desktop -> phone):
```json
{ "type": "answer", "session_id": "a1b2c3...", "payload": { "sdp": "<SDP answer string>" } }
```

**ICE Candidate** (bidirectional):
```json
{
  "type": "ice-candidate",
  "session_id": "a1b2c3...",
  "payload": { "candidate": "...", "sdp_mid": "0", "sdp_mline_index": 0 }
}
```

**Disconnect** (either side):
```json
{ "type": "disconnect", "session_id": "a1b2c3..." }
```

### Why Ephemeral Events

Kind 20000-29999 events are ephemeral: relays deliver them in real-time but don't store them long-term. This fits signaling perfectly -- SDP/ICE data is only meaningful in the moment and shouldn't persist.

### Why NIP-04

The codebase already uses `nostr_sdk::nip04::decrypt` for DM handling. NIP-44 can be adopted later as an upgrade.

## Multiplexing

Multiple local Nostr clients (e.g., Amethyst + Primal running simultaneously) share one WebRTC data channel. Messages are wrapped with a connection ID:

```json
{"conn_id": "ws-1", "msg": "[\"REQ\",\"sub1\",{\"kinds\":[1],\"limit\":10}]"}
```

The desktop bridge maintains separate subscription state per `conn_id`, routing responses back to the correct local WebSocket client.

## NAT Traversal

### STUN Servers (no account required)
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`
- `stun:stun.cloudflare.com:3478`

STUN handles most home/office NAT configurations. For symmetric NATs (some carrier networks, corporate firewalls), an optional TURN server can be configured.

## Reconnection

- On disconnect: phone re-initiates SDP offer after exponential backoff (2s, 4s, 8s, max 30s)
- Desktop continuously listens for new offers from paired pubkey
- `session_id` prevents stale signaling from previous sessions interfering
- Local WebSocket clients are NOT disconnected during re-signaling; messages queue until data channel reopens

## Technology Stack

### Desktop (Rust)
- **str0m** -- Pure Rust WebRTC library (data channels, DTLS, ICE). Sans-I/O design integrates with tokio. No C dependencies.
- **nostr-sdk** -- Already used for NIP-04 encryption and Nostr event handling

### Phone (Kotlin)
- **org.webrtc:google-webrtc** -- Standard Android WebRTC SDK
- **Java-WebSocket** -- Local WebSocket server
- **rust-nostr Kotlin bindings** -- Same nostr-sdk library, Kotlin flavor

## Desktop Module Structure

```
src-tauri/src/tunnel/
  mod.rs          -- orchestrator: start_tunnel(), module exports
  types.rs        -- SignalMessage, TunnelState, PeerInfo, TunnelConfig
  signaling.rs    -- subscribe/publish kind 25050 via Nostr relays
  webrtc.rs       -- str0m agent, UDP socket driver, data channel management
  bridge.rs       -- data channel <-> handle_message() bridge
```

### types.rs
- `SignalMessage` -- enum: Offer, Answer, IceCandidate, Disconnect
- `TunnelState` -- enum: Idle, Signaling, Connecting, Connected, Disconnected
- `PeerInfo` -- remote_pubkey, session_id, connected_since, bytes_transferred
- `TunnelConfig` -- stun_servers, peer_pubkey, auto_reconnect

### signaling.rs
Subscribes to kind 25050 events from the paired peer pubkey using the same relay connection pattern as `sync/pool.rs`. Decrypts incoming messages via NIP-04. Publishes outgoing SDP/ICE events.

### webrtc.rs
Wraps str0m's `Rtc` agent. A dedicated tokio task drives the UDP socket I/O: polls outgoing packets from str0m, sends via socket; receives packets, feeds to str0m. Exposes the data channel as `mpsc::Sender/Receiver<Vec<u8>>`.

### bridge.rs
Receives NIP-01 JSON messages from the data channel, calls `handle_message()` from `relay/server.rs` (made `pub(crate)` for reuse), sends responses back. Maintains per-`conn_id` subscription state for multiplexing.

### Tauri Commands
- `start_tunnel(peer_npub: String)` -- begin listening for signaling
- `stop_tunnel()` -- disconnect and stop
- `get_tunnel_status()` -- returns TunnelState + PeerInfo

## Android Companion App: nostrito-bridge

```
nostrito-bridge/
  app/src/main/java/lat/nostrito/bridge/
    MainActivity.kt              -- UI: peer npub input, connection status
    service/
      BridgeService.kt           -- Foreground service, persistent notification
      LocalRelayServer.kt        -- WebSocket server on localhost:4869
      WebRtcManager.kt           -- PeerConnection + data channel
      NostrSignaling.kt          -- Kind 25050 subscribe/publish via Nostr relays
      DataChannelBridge.kt       -- Local WS <-> WebRTC multiplexing
    crypto/
      NostrKeys.kt              -- Keypair generation/import
      Nip04.kt                  -- NIP-04 encrypt/decrypt
    model/
      SignalMessage.kt          -- Data classes matching signaling protocol
      ConnectionState.kt        -- Disconnected | Signaling | Connecting | Connected
```

### Dependencies
```kotlin
implementation("org.webrtc:google-webrtc:1.0.32006")
implementation("org.java-websocket:Java-WebSocket:1.5.4")
implementation("org.rust-nostr:nostr-sdk:0.35.0")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.0")
```

## Security

- **WebRTC DTLS**: All data channel traffic is encrypted end-to-end
- **NIP-04 signaling**: SDP/ICE exchange is encrypted between paired pubkeys
- **Pubkey authentication**: Only the configured peer pubkey can initiate connections
- **No accounts**: Zero third-party services or logins required

## Known Limitations

| Limitation | Notes |
|-----------|-------|
| Symmetric NAT | STUN alone may fail. Add optional TURN config for carrier/corporate networks. |
| Data channel message size | ~256KB practical limit. Nostr events are typically <64KB. Fragmentation needed for very large kind:30023 articles. |
| nsec required | Tunnel needs nsec for signing signaling events. UI should guide user to configure nsec first. |
| Signaling latency | 100-500ms per message through Nostr relays. One-time cost during connection setup. Trickle ICE mitigates. |
| Android only | iOS companion app not yet planned. iOS Nostr clients would need a separate bridge app. |
