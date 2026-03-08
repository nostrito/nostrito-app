/** Onboarding wizard — 3 steps: Identity → Relays → Storage
 *  Design matches the landing page interactive demo exactly.
 */

import { showAppShell } from "../app";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WizardConfig {
  identityMode: "readonly" | "full";
  npub: string;
  signerType?: "nsec" | "bunker" | "connect" | "new";
  relays: string[];
  storage: {
    othersEventsGb: number;
    othersMediaGb: number;
    mediaTypes: { images: boolean; videos: boolean; audio: boolean };
    cleanupPolicy: "oldest" | "least-interacted";
  };
}

interface RelayOption {
  id: string;
  name: string;
  description: string;
  defaultOn: boolean;
}

const RELAYS: RelayOption[] = [
  { id: "primal", name: "primal", description: "Fast global relay", defaultOn: true },
  { id: "damus", name: "damus", description: "iOS community hub", defaultOn: true },
  { id: "nos", name: "nos", description: "Curated social relay", defaultOn: false },
  { id: "snort", name: "snort", description: "Web client relay", defaultOn: false },
  { id: "coracle", name: "coracle", description: "Discovery-focused", defaultOn: false },
  { id: "nostr.wine", name: "nostr.wine", description: "Premium paid relay", defaultOn: true },
  { id: "amethyst", name: "amethyst", description: "Android community", defaultOn: false },
  { id: "yakihonne", name: "yakihonne", description: "Long-form content", defaultOn: true },
];

const STEP_LABELS = ["Identity", "Relays", "Storage"];

export class WizardScreen {
  private step = 1; // 1-indexed to match landing page
  private container!: HTMLElement;
  private completeCallback: ((config: WizardConfig) => void) | null = null;

  // State
  private identityMode: "readonly" | "full" = "readonly";
  private npub = "";
  private npubError = "";
  private signerType: "nsec" | "bunker" | "connect" | "new" | null = null;
  private selectedRelays: Set<string> = new Set(
    RELAYS.filter((r) => r.defaultOn).map((r) => r.id)
  );
  private othersEventsGb = 5;
  private othersMediaGb = 2;
  private mediaTypes = { images: true, videos: true, audio: true };
  private cleanupPolicy: "oldest" | "least-interacted" = "oldest";

  render(container: HTMLElement): void {
    this.container = container;
    this.draw();
  }

  onComplete(callback: (config: WizardConfig) => void): void {
    this.completeCallback = callback;
  }

  private draw(): void {
    const c = this.container;
    c.innerHTML = "";
    c.className = "wizard-root";

    // Titlebar
    const titlebar = document.createElement("div");
    titlebar.className = "wizard-titlebar";
    titlebar.setAttribute("data-tauri-drag-region", "");
    titlebar.innerHTML = `
      <div class="wizard-dots-decorative">
        <button class="dot-red tb-btn" id="wiz-close" title="Close"></button>
        <button class="dot-yellow tb-btn" id="wiz-minimize" title="Minimize"></button>
        <button class="dot-green tb-btn" id="wiz-maximize" title="Maximize"></button>
      </div>
      <span class="wizard-titlebar-text">nostrito — Setup</span>
      <div style="width:52px"></div>
    `;
    c.appendChild(titlebar);

    // Wire titlebar buttons
    const appWindow = getCurrentWindow();
    titlebar.querySelector("#wiz-close")?.addEventListener("click", () => appWindow.close());
    titlebar.querySelector("#wiz-minimize")?.addEventListener("click", () => appWindow.minimize());
    titlebar.querySelector("#wiz-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());

    // Wizard container
    const wizContainer = document.createElement("div");
    wizContainer.className = "wizard-container";

    // Progress bar
    const progress = document.createElement("div");
    progress.className = "wizard-progress";
    for (let i = 1; i <= 3; i++) {
      const dotWrap = document.createElement("div");
      dotWrap.className = "wiz-dot-wrap";
      if (i < this.step) dotWrap.classList.add("done");
      else if (i === this.step) dotWrap.classList.add("active");

      const dotNum = document.createElement("span");
      dotNum.className = "wiz-dot-num";
      dotNum.textContent = i < this.step ? "✓" : String(i);
      dotWrap.appendChild(dotNum);

      const dotLabel = document.createElement("span");
      dotLabel.className = "wiz-dot-label";
      dotLabel.textContent = STEP_LABELS[i - 1];
      dotWrap.appendChild(dotLabel);

      progress.appendChild(dotWrap);

      if (i < 3) {
        const line = document.createElement("div");
        line.className = "wiz-line";
        if (i < this.step) line.classList.add("done");
        progress.appendChild(line);
      }
    }
    wizContainer.appendChild(progress);

    // Panel content
    const panel = document.createElement("div");
    panel.className = "wiz-panel";

    switch (this.step) {
      case 1:
        this.renderIdentity(panel);
        break;
      case 2:
        this.renderRelays(panel);
        break;
      case 3:
        this.renderStorage(panel);
        break;
    }
    wizContainer.appendChild(panel);

    // Navigation bar
    const nav = document.createElement("div");
    nav.className = "wiz-nav";

    const backBtn = document.createElement("button");
    backBtn.className = "btn btn-secondary";
    backBtn.textContent = "← Back";
    backBtn.style.visibility = this.step === 1 ? "hidden" : "visible";
    backBtn.addEventListener("click", () => {
      if (this.step > 1) {
        this.step--;
        this.draw();
      }
    });
    nav.appendChild(backBtn);

    const nextBtn = document.createElement("button");
    nextBtn.className = "btn btn-primary";
    nextBtn.textContent = this.step === 3 ? "Finish →" : "Next →";

    if (this.step === 1 && this.identityMode === "readonly" && !this.isNpubValid()) {
      nextBtn.classList.add("disabled");
      nextBtn.setAttribute("disabled", "true");
    }
    if (this.step === 1 && this.identityMode === "full" && !this.signerType) {
      nextBtn.classList.add("disabled");
      nextBtn.setAttribute("disabled", "true");
    }
    if (this.step === 2 && this.selectedRelays.size === 0) {
      nextBtn.classList.add("disabled");
      nextBtn.setAttribute("disabled", "true");
    }

    nextBtn.addEventListener("click", () => {
      if (this.step === 1) {
        if (this.identityMode === "readonly" && !this.isNpubValid()) {
          this.npubError = "Enter a valid npub (starts with npub1, 63 characters)";
          this.draw();
          return;
        }
      }
      if (this.step === 2 && this.selectedRelays.size === 0) return;
      if (this.step < 3) {
        this.step++;
        this.draw();
      } else {
        this.finish();
      }
    });
    nav.appendChild(nextBtn);

    wizContainer.appendChild(nav);
    c.appendChild(wizContainer);
  }

  private isNpubValid(): boolean {
    return this.npub.startsWith("npub1") && this.npub.length === 63;
  }

  private renderIdentity(container: HTMLElement): void {
    container.innerHTML = `
      <h3 class="wiz-title">Your identity</h3>
      <p class="wiz-subtitle">Choose how to connect. You can always upgrade later.</p>

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;width:100%;max-width:480px">
        <div class="wiz-identity-option${this.identityMode === "readonly" ? " selected" : ""}" id="opt-readonly">
          <div class="wiz-identity-title">📖 Read-only <span class="wiz-identity-badge">Recommended</span></div>
          <div class="wiz-identity-desc">Paste your npub. DMs disabled, everything else works.</div>
        </div>
        <div class="wiz-identity-option${this.identityMode === "full" ? " selected" : ""}" id="opt-full">
          <div class="wiz-identity-title">🔑 Full access</div>
          <div class="wiz-identity-desc">Connect nsec, NBunker, or Nostr Connect. Unlocks DMs.</div>
        </div>
      </div>

      <div id="wiz-readonly-input" style="width:100%;max-width:480px;${this.identityMode !== "readonly" ? "display:none" : ""}">
        <input type="text" class="wiz-input" id="npub-input" placeholder="npub1..." value="${escapeHtml(this.npub)}" spellcheck="false" autocomplete="off" />
        ${this.npubError ? `<p class="wiz-error">${escapeHtml(this.npubError)}</p>` : ""}
      </div>

      <div id="wiz-full-input" style="${this.identityMode !== "full" ? "display:none;" : "display:flex;"}flex-direction:column;gap:10px;width:100%;max-width:480px">
        <div class="wiz-signer-option${this.signerType === "nsec" ? " selected" : ""}" data-signer="nsec">🔑 Paste nsec</div>
        <div class="wiz-signer-option${this.signerType === "bunker" ? " selected" : ""}" data-signer="bunker">🏰 NBunker / NIP-46</div>
        <div class="wiz-signer-option${this.signerType === "connect" ? " selected" : ""}" data-signer="connect">🔌 Nostr Connect</div>
        <div class="wiz-signer-option${this.signerType === "new" ? " selected" : ""}" data-signer="new">✨ Create new account</div>
      </div>
    `;

    // Identity mode selector
    container.querySelector("#opt-readonly")?.addEventListener("click", () => {
      this.identityMode = "readonly";
      this.draw();
    });
    container.querySelector("#opt-full")?.addEventListener("click", () => {
      this.identityMode = "full";
      this.draw();
    });

    // Signer options
    container.querySelectorAll(".wiz-signer-option").forEach((el) => {
      el.addEventListener("click", () => {
        this.signerType = (el as HTMLElement).dataset.signer as any;
        this.draw();
      });
    });

    // Npub input
    const input = container.querySelector("#npub-input") as HTMLInputElement | null;
    if (input) {
      input.addEventListener("input", () => {
        this.npub = input.value.trim();
        this.npubError = "";
        const next = this.container.querySelector(".btn-primary") as HTMLButtonElement | null;
        if (next) {
          if (this.isNpubValid()) {
            next.classList.remove("disabled");
            next.removeAttribute("disabled");
          } else {
            next.classList.add("disabled");
            next.setAttribute("disabled", "true");
          }
        }
      });
      requestAnimationFrame(() => input.focus());
    }
  }

  private renderRelays(container: HTMLElement): void {
    const heading = document.createElement("h3");
    heading.className = "wiz-title";
    heading.textContent = "Where do you want to sync from?";
    container.appendChild(heading);

    const sub = document.createElement("p");
    sub.className = "wiz-subtitle";
    sub.textContent = "Pick by name. We handle the rest.";
    container.appendChild(sub);

    const grid = document.createElement("div");
    grid.className = "relay-grid";

    RELAYS.forEach((relay) => {
      const isOn = this.selectedRelays.has(relay.id);
      const card = document.createElement("div");
      card.className = `relay-card${isOn ? " selected" : ""}`;
      card.setAttribute("data-relay", relay.id);
      card.innerHTML = `
        <div class="relay-card-info">
          <span class="relay-card-name">${escapeHtml(relay.name)}</span>
          <span class="relay-card-desc">${escapeHtml(relay.description)}</span>
        </div>
        <div class="relay-check">${isOn ? "✓" : ""}</div>
      `;
      card.addEventListener("click", () => {
        if (this.selectedRelays.has(relay.id)) {
          this.selectedRelays.delete(relay.id);
        } else {
          this.selectedRelays.add(relay.id);
        }
        // Update UI without full redraw
        card.classList.toggle("selected");
        const check = card.querySelector(".relay-check")!;
        check.textContent = this.selectedRelays.has(relay.id) ? "✓" : "";
        // Update next button
        const next = this.container.querySelector(".btn-primary") as HTMLButtonElement | null;
        if (next) {
          if (this.selectedRelays.size === 0) {
            next.classList.add("disabled");
            next.setAttribute("disabled", "true");
          } else {
            next.classList.remove("disabled");
            next.removeAttribute("disabled");
          }
        }
      });
      grid.appendChild(card);
    });
    container.appendChild(grid);
  }

  private renderStorage(container: HTMLElement): void {
    container.innerHTML = `
      <h3 class="wiz-title">Storage</h3>
      <p class="wiz-subtitle">Control what gets stored and how much space to use.</p>

      <div class="storage-section">
        <div class="storage-row locked">
          <div class="storage-row-info">
            <span class="storage-row-label">Your events & media</span>
            <span class="storage-row-meta">🔒 Always stored. No exceptions.</span>
          </div>
          <div class="storage-bar-wrap">
            <div class="storage-bar"><div class="storage-bar-fill"></div></div>
            <span class="storage-bar-label">100%</span>
          </div>
        </div>
      </div>

      <div class="storage-section">
        <div class="storage-row">
          <div class="storage-row-info">
            <span class="storage-row-label">Others' events</span>
            <span class="storage-row-meta">From your Web of Trust</span>
          </div>
          <div class="storage-slider-wrap">
            <input type="range" class="storage-slider" min="1" max="50" value="${this.othersEventsGb}" id="othersEventsSlider">
            <span class="storage-slider-value" id="othersEventsVal">${this.othersEventsGb} GB</span>
          </div>
        </div>
      </div>

      <div class="storage-section">
        <div class="storage-row">
          <div class="storage-row-info">
            <span class="storage-row-label">Others' media (Blossom)</span>
            <span class="storage-row-meta">Images, videos, audio from your network</span>
          </div>
          <div class="storage-slider-wrap">
            <input type="range" class="storage-slider" min="1" max="50" value="${this.othersMediaGb}" id="othersMediaSlider">
            <span class="storage-slider-value" id="othersMediaVal">${this.othersMediaGb} GB</span>
          </div>
        </div>
        <div class="media-toggles" id="mediaToggles">
          <div class="media-toggle${this.mediaTypes.images ? " active" : ""}" data-media="images">🖼️ Images</div>
          <div class="media-toggle${this.mediaTypes.videos ? " active" : ""}" data-media="videos">🎬 Videos</div>
          <div class="media-toggle${this.mediaTypes.audio ? " active" : ""}" data-media="audio">🔊 Audio</div>
        </div>
      </div>

      <div class="storage-section">
        <div class="storage-row">
          <div class="storage-row-info">
            <span class="storage-row-label">Auto-cleanup</span>
            <span class="storage-row-meta">When storage limit is reached</span>
          </div>
          <div class="cleanup-group" id="cleanupGroup">
            <div class="cleanup-radio${this.cleanupPolicy === "oldest" ? " active" : ""}" data-cleanup="oldest">Oldest first</div>
            <div class="cleanup-radio${this.cleanupPolicy === "least-interacted" ? " active" : ""}" data-cleanup="least-interacted">Least interacted</div>
          </div>
        </div>
      </div>
    `;

    // Sliders
    const evSlider = container.querySelector("#othersEventsSlider") as HTMLInputElement;
    const evVal = container.querySelector("#othersEventsVal") as HTMLElement;
    evSlider.addEventListener("input", () => {
      this.othersEventsGb = parseInt(evSlider.value);
      evVal.textContent = `${this.othersEventsGb} GB`;
    });

    const mdSlider = container.querySelector("#othersMediaSlider") as HTMLInputElement;
    const mdVal = container.querySelector("#othersMediaVal") as HTMLElement;
    mdSlider.addEventListener("input", () => {
      this.othersMediaGb = parseInt(mdSlider.value);
      mdVal.textContent = `${this.othersMediaGb} GB`;
    });

    // Media toggles
    container.querySelectorAll(".media-toggle").forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const type = (toggle as HTMLElement).dataset.media as keyof typeof this.mediaTypes;
        this.mediaTypes[type] = !this.mediaTypes[type];
        toggle.classList.toggle("active");
      });
    });

    // Cleanup radios
    container.querySelector("#cleanupGroup")?.addEventListener("click", (e) => {
      const radio = (e.target as HTMLElement).closest(".cleanup-radio");
      if (!radio) return;
      this.cleanupPolicy = (radio as HTMLElement).dataset.cleanup as "oldest" | "least-interacted";
      container.querySelectorAll(".cleanup-radio").forEach((el) => el.classList.remove("active"));
      radio.classList.add("active");
    });
  }

  private async finish(): Promise<void> {
    const config: WizardConfig = {
      identityMode: this.identityMode,
      npub: this.npub,
      signerType: this.signerType || undefined,
      relays: Array.from(this.selectedRelays),
      storage: {
        othersEventsGb: this.othersEventsGb,
        othersMediaGb: this.othersMediaGb,
        mediaTypes: { ...this.mediaTypes },
        cleanupPolicy: this.cleanupPolicy,
      },
    };

    // Disable finish button
    const finishBtn = this.container.querySelector(".btn-primary") as HTMLButtonElement | null;
    if (finishBtn) {
      finishBtn.disabled = true;
      finishBtn.textContent = "Initializing...";
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("init_nostrito", {
        npub: config.npub,
        relays: config.relays,
        storageOthersGb: config.storage.othersEventsGb,
        storageMediaGb: config.storage.othersMediaGb,
      });

      localStorage.setItem("nostrito_initialized", "true");
      localStorage.setItem("nostrito_config", JSON.stringify(config));

      if (this.completeCallback) {
        this.completeCallback(config);
      }

      showAppShell();
    } catch (e) {
      console.error("[nostrito] Failed to initialize:", e);
      const errEl = document.createElement("p");
      errEl.className = "wiz-error";
      errEl.textContent = `Failed to initialize: ${e}`;
      const panel = this.container.querySelector(".wiz-panel");
      if (panel) {
        const existing = panel.querySelector(".wiz-error");
        if (existing) existing.remove();
        panel.appendChild(errEl);
      }
      if (finishBtn) {
        finishBtn.disabled = false;
        finishBtn.textContent = "Finish →";
      }
    }
  }
}

/** Convenience function for existing app.ts import */
export function renderWizard(container: HTMLElement): void {
  const wizard = new WizardScreen();
  wizard.render(container);
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
