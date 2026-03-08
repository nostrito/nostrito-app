# ⚡ nostrito

A personal Nostr mini-relay desktop app. nostrito runs a local WebSocket relay on your machine, stores your events in SQLite, builds a Web of Trust graph from your social connections, and syncs with the broader Nostr network — giving you full control over your data.

## Stack

- **Tauri 2** — Rust backend + web frontend in a native desktop shell
- **Rust** — Relay server, WoT engine, sync engine, SQLite storage
- **TypeScript** — Frontend UI (vanilla, no framework)
- **SQLite** — Local event storage via rusqlite
- **nostr-sdk** — Nostr protocol handling
- **Vite** — Frontend dev server + bundler

## Architecture

### Frontend (TypeScript)

Screen-based routing with a sidebar navigation:

| Screen | Description |
|--------|-------------|
| **Wizard** | 3-step onboarding: welcome → npub input → confirmation |
| **Dashboard** | Overview: relay status, event count, WoT size, sync status |
| **Feed** | Browse stored events with filtering (kind, WoT-only) |
| **Web of Trust** | Trust graph visualization and stats |
| **Storage** | Database stats: size, event breakdown, time range |
| **Settings** | Configure relay port, WoT depth, sync interval, outbound relays |

### Backend (Rust)

| Module | Description |
|--------|-------------|
| `relay/` | NIP-01 compliant WebSocket relay server |
| `wot/` | BFS-based Web of Trust engine (kind:3 crawling) |
| `sync/` | Outbound sync engine (pull events from external relays) |
| `storage/` | SQLite persistence layer (events, WoT, settings) |

## Development

```bash
# Install dependencies
npm install

# Run in development mode (starts Vite + Tauri)
npm run tauri dev

# Build for production
npm run tauri build
```

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) ≥ 18
- System dependencies for Tauri: see [prerequisites](https://v2.tauri.app/start/prerequisites/)

## License

MIT
