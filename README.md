<p align="center">
  <img src="https://raw.githubusercontent.com/nostrito/nostrito/main/public/assets/nostrito-white.svg" alt="nostrito" width="160" />
</p>

<h1 align="center">nostrito-app</h1>

<p align="center">
  <strong>A personal Nostr mini-relay desktop app.</strong><br />
  <em>Your relay. Your network. Your machine.</em>
</p>

<p align="center">
  <a href="https://nostrito.com">Website</a> ·
  <a href="https://github.com/nostrito/.github">Organization</a>
</p>

---

nostrito runs a local WebSocket relay on your machine, stores your events in SQLite, builds a Web of Trust graph from your social connections, and syncs with the broader Nostr network — giving you full control over your data.

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/nostrito/nostrito/main/public/assets/architecture-diagram.svg" alt="nostrito architecture" width="720" />
</p>

## Stack

| Layer | Technology |
|-------|-----------|
| **Shell** | Tauri 2 — Rust backend + web frontend in a native desktop app |
| **Backend** | Rust — relay server, WoT engine, sync engine, SQLite storage |
| **Frontend** | TypeScript — screen-based UI |
| **Storage** | SQLite via rusqlite |
| **Protocol** | nostr-sdk |
| **Bundler** | Vite |

## Frontend Screens

| Screen | Description |
|--------|-------------|
| **Wizard** | 3-step onboarding: welcome → npub input → confirmation |
| **Dashboard** | Overview: relay status, event count, WoT size, sync status |
| **Feed** | Browse stored events with filtering (kind, WoT-only) |
| **Web of Trust** | Trust graph visualization and stats |
| **Storage** | Database stats: size, event breakdown, time range |
| **Settings** | Configure relay port, WoT depth, sync interval, outbound relays |

## Backend Modules

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

# Build macOS DMG installer
npm run tauri build -- --bundles dmg
```

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) ≥ 18
- System dependencies for Tauri: see [prerequisites](https://v2.tauri.app/start/prerequisites/)

## License

MIT
