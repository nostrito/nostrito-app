/** DMs — Direct Messages placeholder */

export function renderDms(container: HTMLElement): void {
  container.style.padding = "0";
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);font-size:0.9rem;font-weight:700;">
        💬 Direct Messages
      </div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-dim);padding:48px;text-align:center;">
        <div>
          <div style="font-size:2rem;margin-bottom:12px;">🔒</div>
          <div style="font-size:0.9rem;font-weight:600;margin-bottom:8px;color:var(--text);">Read-only mode</div>
          <div style="font-size:0.82rem;">Connect a signer (nsec or NBunker) in Settings to unlock DMs.</div>
          <div style="font-size:0.72rem;margin-top:8px;color:var(--green);">NIP-44 encrypted · End-to-end</div>
        </div>
      </div>
    </div>
  `;
}
