/** Onboarding wizard — 3 steps: Welcome → npub input → Confirmation */

import { showAppShell } from "../app";

export function renderWizard(container: HTMLElement): void {
  let step = 0;

  const render = () => {
    container.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div class="card" style="max-width: 480px; width: 100%; text-align: center;">
          ${stepContent(step)}
          <div style="margin-top: 24px; display: flex; justify-content: center; gap: 12px;">
            ${step > 0 ? '<button class="btn btn-ghost" id="wizard-back">Back</button>' : ""}
            <button class="btn btn-primary" id="wizard-next">${step === 2 ? "Launch nostrito" : "Continue"}</button>
          </div>
          <div style="margin-top: 16px; display: flex; justify-content: center; gap: 6px;">
            ${[0, 1, 2].map((i) => `<div style="width: 8px; height: 8px; border-radius: 50%; background: ${i === step ? "var(--accent)" : "var(--border)"}"></div>`).join("")}
          </div>
        </div>
      </div>
    `;

    container.querySelector("#wizard-back")?.addEventListener("click", () => {
      step--;
      render();
    });

    container.querySelector("#wizard-next")?.addEventListener("click", () => {
      if (step < 2) {
        step++;
        render();
      } else {
        // TODO: invoke('init_nostrito', { npub }) with value from step 1 input
        showAppShell();
      }
    });
  };

  render();
}

function stepContent(step: number): string {
  switch (step) {
    case 0:
      return `
        <h1 style="font-size: 28px; margin-bottom: 8px;">⚡ Welcome to nostrito</h1>
        <p style="color: var(--text-dim);">Your personal Nostr mini-relay. Store your events locally, sync with the network, and control your data.</p>
      `;
    case 1:
      return `
        <h2 style="font-size: 22px; margin-bottom: 8px;">Enter your npub</h2>
        <p style="color: var(--text-dim); margin-bottom: 16px;">We'll use this to build your Web of Trust and start syncing your events.</p>
        <input type="text" id="npub-input" placeholder="npub1..." style="
          width: 100%; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border);
          background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 14px;
        " />
      `;
    case 2:
      return `
        <h2 style="font-size: 22px; margin-bottom: 8px;">Ready to go</h2>
        <p style="color: var(--text-dim);">nostrito will start your local relay, begin syncing events, and build your Web of Trust graph.</p>
      `;
    default:
      return "";
  }
}
