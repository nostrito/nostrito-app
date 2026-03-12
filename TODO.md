# Nostrito — TODO / Pending Features

## Long-Form Articles (kind 30023)

- [ ] **Video rendering in article reader** — Embedded videos in markdown (`![](video.mp4)`) are queued for download but rendered as `<img>` tags in the reader. Detect video URLs and render `<video>` elements instead.
- [ ] **SQLite d-tag index for parameterized replaceable events** — Currently all kind:30023 deduplication (by `pubkey:d-tag`) happens in the frontend. Add a database index or deduplicated view to avoid performance issues with many article revisions.
- [ ] **`published_at` vs `created_at` sort consistency** — The feed uses `created_at` for ordering and cursors, but NIP-23 articles use `published_at` for display. An article edited with a new `created_at` but old `published_at` can sort unexpectedly. Consider using `published_at` for article display ordering when available.
