# Nostrito - Project Guidelines

## UI Icons
- Use inline SVGs instead of emoji characters for all icons in the UI
- SVGs should be simple, monochrome, and match the app's design language
- Wrap SVGs in `<span class="icon">` for consistent sizing

## Relay Event Broadcasting
- When a new event is stored in the local relay (via WebSocket), it is automatically
  broadcast to **all configured outbound relays** (damus, primal, nos.lol, etc.)
- Write access is restricted to: the **owner npub** and any **tracked profiles**
- A native macOS notification is shown for each new event (via `tauri-plugin-notification`)
- The outbound broadcaster reads the relay list dynamically from config, so settings
  changes take effect without restarting the relay
- Events created from within the app (reactions, zaps) are published directly to outbound
  relays via Tauri commands — they do NOT go through the relay WebSocket path

## Implementation Protocol
- **Always proceed with implementation** — don't stop to ask for approval on obvious next
  steps. Follow through on the full scope of a feature.
- **Impact analysis before modifying features**: When changing or adding a feature, trace
  every place in the app it touches. Check all screens, components, hooks, Tauri commands,
  database methods, relay handling, CSS, routing, sidebar, and type definitions. Don't leave
  orphan references or half-wired functionality.
- **Full-stack follow-through**: A feature isn't done until it works end-to-end — backend
  (DB migration + queries + Tauri commands), frontend (hooks + components + screens + routing),
  relay support (NIP-11 info + event kind handling), and styling.

## Git Workflow
- Use feature branches for larger changes.
