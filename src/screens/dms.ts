/** DMs — Direct Messages screen. No mock data. */

export function renderDms(container: HTMLElement): void {
  container.className = "main-content";
  container.innerHTML = `
    <div class="dms-page-inner">
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;color:var(--text-muted);text-align:center;gap:12px;">
        <div style="font-size:2rem;">🔒</div>
        <div style="font-size:0.95rem;font-weight:500;color:var(--text-dim);">No DMs yet.</div>
        <div style="font-size:0.82rem;line-height:1.5;">
          DMs require a signer. Connect nsec or NBunker in Settings → Identity.
        </div>
      </div>
    </div>
  `;
}
