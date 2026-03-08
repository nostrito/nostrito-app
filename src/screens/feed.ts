/** Feed — event feed view */

export function renderFeed(container: HTMLElement): void {
  container.innerHTML = `
    <h1 style="font-size: 24px; margin-bottom: 20px;">📝 Feed</h1>
    <div style="display: flex; gap: 12px; margin-bottom: 20px;">
      <button class="btn btn-primary">All Events</button>
      <button class="btn btn-ghost">WoT Only</button>
      <button class="btn btn-ghost">Notes</button>
      <button class="btn btn-ghost">Reactions</button>
    </div>
    <div class="card" style="color: var(--text-dim); text-align: center; padding: 48px;">
      <!-- TODO: invoke('get_feed', { filter }) and render events -->
      No events yet. Start syncing to populate your feed.
    </div>
  `;
}
