/** Dashboard — main overview screen */

export function renderDashboard(container: HTMLElement): void {
  container.innerHTML = `
    <h1 style="font-size: 24px; margin-bottom: 20px;">📊 Dashboard</h1>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Relay Status</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px; color: var(--green);">● Running</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Events Stored</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">WoT Size</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Sync Status</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">Idle</div>
      </div>
    </div>
    <p style="color: var(--text-dim); margin-top: 24px; font-size: 14px;">
      <!-- TODO: Wire up invoke('get_status') to populate dashboard cards -->
      Dashboard data will be populated once Rust backend is implemented.
    </p>
  `;
}
