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

## Git Workflow
- Never use git worktrees. Always commit directly to the working branch.
