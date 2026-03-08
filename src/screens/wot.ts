/** Web of Trust — trust graph view */

export function renderWot(container: HTMLElement): void {
  container.innerHTML = `
    <h1 style="font-size: 24px; margin-bottom: 20px;">🕸️ Web of Trust</h1>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px;">
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Root</div>
        <div style="font-size: 14px; font-weight: 600; margin-top: 4px; font-family: var(--mono);">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Trusted Pubkeys</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
      <div class="card">
        <div style="color: var(--text-dim); font-size: 13px;">Max Depth</div>
        <div style="font-size: 20px; font-weight: 600; margin-top: 4px;">—</div>
      </div>
    </div>
    <div class="card" style="color: var(--text-dim); text-align: center; padding: 48px;">
      <!-- TODO: invoke('get_wot') and render trust graph -->
      Web of Trust graph will appear here after initialization.
    </div>
  `;
}
