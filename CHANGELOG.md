# Changelog

## [0.1.0] — 2026-03-14

First public release of nostrito — a personal Nostr mini-relay desktop app.

### Core Features

- **Local Nostr Relay** — NIP-01 compliant WebSocket relay running on your machine with NIP-11 info document support
- **TLS Support** — Secure `wss://` relay with auto-generated certificates via mkcert
- **SQLite Storage** — All your events stored locally with configurable size limits (default 2 GB)
- **Web of Trust Engine** — BFS-based trust graph built from your social connections with interactive graph explorer
- **Multi-phase Sync Engine** — Layered sync: own data → follows → WoT → media, with historical backfill and self-healing cursors
- **Per-user Databases** — Separate storage per Nostr identity with Change Account support

### Frontend (React)

- **Onboarding Wizard** — 3-step setup: welcome → npub/nsec input → confirmation → relay URL
- **Dashboard** — Real-time stats (relay status, event count, WoT size, sync progress) with live events table
- **Feed** — Infinite scroll, WoT filtering, keyword/npub/NIP-05 search, hashtag search, reply context, article support
- **Profile View** — Banner hero, follows sidebar, tabbed Notes/Articles/Media view, on-demand profile fetch
- **Storage** — Ownership-based layout with donut charts, event breakdown by kind, tracked profiles with media galleries
- **Web of Trust** — Interactive graph explorer with lazy node expansion, pan/zoom, hop distance display
- **Settings** — Relay picker, sync configuration presets, tracked profiles management, offline mode, danger zone
- **DM Viewer** — Encrypted DM conversation viewer (read-only when keys unavailable)

### Media & Content

- **Blossom Media Backup** — Automatic media download from Nostr CDNs (void.cat, nostr.build, etc.)
- **Media Viewer** — Lightbox for images and videos, three-dots menu with view event and bookmark
- **Long-form Articles** — Kind 30023 support with reader view and article cards
- **Nostr Entity Links** — Clickable note, nevent, naddr, nprofile links in posts
- **Repost Display** — Social media style reposts with grouping and relay fetch

### Desktop Integration

- **Tauri 2** — Native macOS app with custom window chrome (frameless, transparent)
- **System Tray** — Tray icon with menu
- **Custom App Icon** — nostrito mascot (duckling hatching from egg) with macOS-style squircle

### Stability

- Bulletproof relay connections — sync engine no longer freezes
- SIGABRT crash prevention from mutex poisoning and array bounds panics
- Subscription ID filtering to prevent stale subscription crosstalk
- Incremental sync cursors to avoid missing events
