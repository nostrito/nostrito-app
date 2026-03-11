# Relay Connection Pool

> Part of [Sync Engine v2](./README.md)

---

## Architecture

A single `RelayPool` manages all WebSocket connections for the entire sync engine. No more creating/destroying `Client` instances per tier.

```
RelayPool
  ├── connected: HashMap<String, RelayConnection>    (up to MAX_CONNECTIONS)
  ├── stats: HashMap<String, RelayStats>             (all known relays)
  ├── policies: HashMap<String, RelayPolicy>         (rate limiting)
  └── queue: VecDeque<PendingSubscription>           (overflow when pool is full)
```

---

## Connection limits

- **MAX_CONNECTIONS = 25** — maximum simultaneous WebSocket connections.
- **User-configured relays** — connected first, always in the pool, never idle-disconnect.
- **NIP-65 discovered relays** — connected on-demand when needed for specific users, disconnected when idle for >5 minutes.
- **Discovery relay (purplepag.es)** — connected on-demand only (see [Discovery](./discovery.md)), counts against the pool limit like any other relay.

---

## Connection lifecycle

1. When the scheduler needs a relay that's not connected:
   - If pool has room (< MAX_CONNECTIONS): connect immediately.
   - If pool is full: add to queue. When a relay disconnects (idle timeout), the next queued relay connects.
2. Relays disconnect after 5 minutes of no subscriptions.
3. User-configured relays never idle-disconnect.
4. On connection failure: exponential backoff (10s, 30s, 60s, 120s, 300s).

---

## RelayPolicy (per-relay rate limiting)

Same concept as today but **persistent across the cycle** (not reset):
- Min interval between requests: 3 seconds (configurable).
- On rate-limit NOTICE: pause 90 seconds, increase interval to 5s.
- On generic NOTICE: pause 5 seconds.
- On connection failure: exponential backoff.
- **Reset on successful response** — backoff clears on success.
