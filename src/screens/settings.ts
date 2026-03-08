/** Settings — app configuration view */

export function renderSettings(container: HTMLElement): void {
  container.innerHTML = `
    <h1 style="font-size: 24px; margin-bottom: 20px;">⚙️ Settings</h1>
    <div class="card" style="max-width: 600px;">
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <div>
          <label style="color: var(--text-dim); font-size: 13px; display: block; margin-bottom: 6px;">npub</label>
          <input type="text" disabled placeholder="npub1..." style="
            width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
            background: var(--bg); color: var(--text-dim); font-family: var(--mono); font-size: 13px;
          " />
        </div>
        <div>
          <label style="color: var(--text-dim); font-size: 13px; display: block; margin-bottom: 6px;">Relay Port</label>
          <input type="number" value="4869" style="
            width: 120px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
            background: var(--bg); color: var(--text); font-size: 14px;
          " />
        </div>
        <div>
          <label style="color: var(--text-dim); font-size: 13px; display: block; margin-bottom: 6px;">WoT Max Depth</label>
          <input type="number" value="2" min="1" max="5" style="
            width: 120px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
            background: var(--bg); color: var(--text); font-size: 14px;
          " />
        </div>
        <div>
          <label style="color: var(--text-dim); font-size: 13px; display: block; margin-bottom: 6px;">Max Storage (MB)</label>
          <input type="number" value="500" style="
            width: 120px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
            background: var(--bg); color: var(--text); font-size: 14px;
          " />
        </div>
        <div>
          <label style="color: var(--text-dim); font-size: 13px; display: block; margin-bottom: 6px;">Outbound Relays</label>
          <textarea rows="3" placeholder="wss://relay.damus.io&#10;wss://nos.lol" style="
            width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
            background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; resize: vertical;
          "></textarea>
        </div>
        <div style="display: flex; gap: 12px;">
          <!-- TODO: invoke('save_settings', { settings }) -->
          <button class="btn btn-primary">Save Settings</button>
          <button class="btn btn-ghost">Reset</button>
        </div>
      </div>
    </div>
  `;
}
