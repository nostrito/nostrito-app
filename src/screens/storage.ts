/** Storage — database stats view */

export function renderStorage(container: HTMLElement): void {
  container.innerHTML = `
    <h1 style="font-size: 24px; margin-bottom: 20px;">💾 Storage</h1>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px;">
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Total Events</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Database Size</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Event Range</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom: 12px;">Events by Kind</h3>
      <p style="color: var(--text-dim); font-size: 14px;">
        <!-- TODO: invoke('get_storage_stats') and render breakdown -->
        Storage breakdown will appear here.
      </p>
    </div>
  `;
}
