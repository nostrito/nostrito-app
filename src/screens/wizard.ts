/** Onboarding wizard — 3 steps: Identity → Relays → Storage */

import { showAppShell } from "../app";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WizardConfig {
  npub: string;
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
  { id: "primal", name: "primal", description: "Popular social relay", defaultOn: true },
  { id: "damus", name: "damus", description: "iOS-first community", defaultOn: true },
  { id: "nos", name: "nos", description: "Open social network", defaultOn: true },
  { id: "snort", name: "snort", description: "Web client relay", defaultOn: false },
  { id: "coracle", name: "coracle", description: "Privacy-focused", defaultOn: false },
  { id: "nostr.wine", name: "nostr.wine", description: "Curated content", defaultOn: false },
  { id: "amethyst", name: "amethyst", description: "Android community", defaultOn: false },
  { id: "yakihonne", name: "yakihonne", description: "Long-form content", defaultOn: false },
];

const STEP_LABELS = ["Identity", "Relays", "Storage"];

export class WizardScreen {
  private step = 0;
  private container!: HTMLElement;
  private completeCallback: ((config: WizardConfig) => void) | null = null;

  // State
  private npub = "";
  private npubError = "";
  private selectedRelays: Set<string> = new Set(
    RELAYS.filter((r) => r.defaultOn).map((r) => r.id)
  );
  private othersEventsGb = 5;
  private othersMediaGb = 2;
  private mediaTypes = { images: true, videos: true, audio: false };
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

    // Title bar (appended to root, outside wrapper)
    const titlebar = el("div", "wizard-titlebar");
    titlebar.innerHTML = `
      <div class="wizard-dots-decorative">
        <button class="dot-red tb-btn" id="wiz-close" title="Close"></button>
        <button class="dot-yellow tb-btn" id="wiz-minimize" title="Minimize"></button>
        <button class="dot-green tb-btn" id="wiz-maximize" title="Maximize"></button>
      </div>
      <span class="wizard-titlebar-text">nostrito</span>
      <div class="wizard-dots-decorative" style="visibility:hidden">
        <span class="dot-red"></span>
        <span class="dot-yellow"></span>
        <span class="dot-green"></span>
      </div>
    `;
    c.appendChild(titlebar);

    // Wire wizard titlebar buttons
    const appWindow = getCurrentWindow();
    titlebar.querySelector("#wiz-close")?.addEventListener("click", () => appWindow.close());
    titlebar.querySelector("#wiz-minimize")?.addEventListener("click", () => appWindow.minimize());
    titlebar.querySelector("#wiz-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());

    // Wrapper
    const wrapper = el("div", "wizard-wrapper");

    // Logo
    const logo = el("div", "wizard-logo");
    logo.innerHTML = `<span class="wizard-logo-icon">🌶️</span> <span class="wizard-logo-text">nostrito</span>`;
    wrapper.appendChild(logo);

    // Progress
    const progress = el("div", "wizard-progress");
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        const line = el("div", `wizard-progress-line${i <= this.step ? " done" : ""}`);
        progress.appendChild(line);
      }
      const dot = el("div", `wizard-progress-dot${i <= this.step ? " active" : ""}${i < this.step ? " completed" : ""}`);
      progress.appendChild(dot);
    }
    wrapper.appendChild(progress);

    // Progress labels
    const labels = el("div", "wizard-progress-labels");
    STEP_LABELS.forEach((label, i) => {
      const lbl = el("span", `wizard-progress-label${i <= this.step ? " active" : ""}`);
      lbl.textContent = label;
      labels.appendChild(lbl);
    });
    wrapper.appendChild(labels);

    // Step content
    const content = el("div", "wizard-content");
    content.setAttribute("key", String(this.step));
    // Animate in
    requestAnimationFrame(() => content.classList.add("visible"));

    switch (this.step) {
      case 0:
        this.renderIdentity(content);
        break;
      case 1:
        this.renderRelays(content);
        break;
      case 2:
        this.renderStorage(content);
        break;
    }
    wrapper.appendChild(content);

    // Buttons
    const buttons = el("div", "wizard-buttons");
    if (this.step > 0) {
      const back = el("button", "btn btn-ghost");
      back.textContent = "Back";
      back.addEventListener("click", () => {
        this.step--;
        this.draw();
      });
      buttons.appendChild(back);
    }

    if (this.step < 2) {
      const next = el("button", "btn btn-primary");
      next.textContent = "Next →";
      if (this.step === 0 && !this.isNpubValid()) {
        next.classList.add("disabled");
        next.setAttribute("disabled", "true");
      }
      if (this.step === 1 && this.selectedRelays.size === 0) {
        next.classList.add("disabled");
        next.setAttribute("disabled", "true");
      }
      next.addEventListener("click", () => {
        if (this.step === 0) {
          if (!this.isNpubValid()) {
            this.npubError = "Enter a valid npub (starts with npub1, 63 characters)";
            this.draw();
            return;
          }
        }
        if (this.step === 1 && this.selectedRelays.size === 0) return;
        this.step++;
        this.draw();
      });
      buttons.appendChild(next);
    } else {
      const finish = el("button", "btn btn-primary btn-finish");
      finish.textContent = "Launch nostrito 🚀";
      finish.addEventListener("click", () => this.finish());
      buttons.appendChild(finish);
    }
    wrapper.appendChild(buttons);

    c.appendChild(wrapper);
  }

  private isNpubValid(): boolean {
    return this.npub.startsWith("npub1") && this.npub.length === 63;
  }

  private renderIdentity(container: HTMLElement): void {
    container.innerHTML = `
      <h1 class="wizard-heading">What's your npub?</h1>
      <p class="wizard-subtext">Your relay, your rules. Only you connect to it.</p>
      <div class="wizard-input-group">
        <input
          type="text"
          id="npub-input"
          class="wizard-input"
          placeholder="npub1..."
          value="${escapeHtml(this.npub)}"
          spellcheck="false"
          autocomplete="off"
        />
        ${this.npubError ? `<p class="wizard-error">${escapeHtml(this.npubError)}</p>` : ""}
      </div>
    `;

    const input = container.querySelector("#npub-input") as HTMLInputElement;
    input.addEventListener("input", () => {
      this.npub = input.value.trim();
      this.npubError = "";
      // Update next button state
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
    // Focus input
    requestAnimationFrame(() => input.focus());
  }

  private renderRelays(container: HTMLElement): void {
    const heading = el("h1", "wizard-heading");
    heading.textContent = "Where do you sync from?";
    container.appendChild(heading);

    const sub = el("p", "wizard-subtext");
    sub.textContent = "Pick by name. We handle the rest.";
    container.appendChild(sub);

    const grid = el("div", "relay-grid");
    RELAYS.forEach((relay) => {
      const isOn = this.selectedRelays.has(relay.id);
      const card = el("div", `relay-card${isOn ? " on" : ""}`);
      card.innerHTML = `
        <span class="relay-name">${escapeHtml(relay.name)}</span>
        <span class="relay-desc">${escapeHtml(relay.description)}</span>
        <span class="relay-toggle">${isOn ? "ON" : "OFF"}</span>
      `;
      card.addEventListener("click", () => {
        if (this.selectedRelays.has(relay.id)) {
          this.selectedRelays.delete(relay.id);
        } else {
          this.selectedRelays.add(relay.id);
        }
        this.draw();
      });
      grid.appendChild(card);
    });
    container.appendChild(grid);
  }

  private renderStorage(container: HTMLElement): void {
    container.innerHTML = `
      <h1 class="wizard-heading">How much space can nostrito use?</h1>

      <div class="storage-section">
        <div class="storage-bar-own">
          <div class="storage-bar-fill"></div>
          <span class="storage-bar-label">🔒 Your events & media — Always kept. No exceptions.</span>
        </div>
      </div>

      <div class="storage-section">
        <label class="storage-slider-label">
          Others' events: <strong id="events-val">${this.othersEventsGb} GB</strong>
        </label>
        <input type="range" id="events-slider" class="wizard-slider" min="1" max="50" value="${this.othersEventsGb}" />
      </div>

      <div class="storage-section">
        <label class="storage-slider-label">
          Others' media: <strong id="media-val">${this.othersMediaGb} GB</strong>
        </label>
        <input type="range" id="media-slider" class="wizard-slider" min="0" max="20" value="${this.othersMediaGb}" />
      </div>

      <div class="storage-section">
        <div class="media-types-row">
          <button class="media-pill${this.mediaTypes.images ? " active" : ""}" data-type="images">Images ✓</button>
          <button class="media-pill${this.mediaTypes.videos ? " active" : ""}" data-type="videos">Videos ✓</button>
          <button class="media-pill${this.mediaTypes.audio ? " active" : ""}" data-type="audio">Audio ✗</button>
        </div>
      </div>

      <div class="storage-section">
        <p class="storage-slider-label">Cleanup policy</p>
        <div class="radio-group">
          <label class="radio-option${this.cleanupPolicy === "oldest" ? " selected" : ""}">
            <input type="radio" name="cleanup" value="oldest" ${this.cleanupPolicy === "oldest" ? "checked" : ""} />
            Oldest first
          </label>
          <label class="radio-option${this.cleanupPolicy === "least-interacted" ? " selected" : ""}">
            <input type="radio" name="cleanup" value="least-interacted" ${this.cleanupPolicy === "least-interacted" ? "checked" : ""} />
            Least interacted
          </label>
        </div>
      </div>
    `;

    // Sliders
    const evSlider = container.querySelector("#events-slider") as HTMLInputElement;
    const evVal = container.querySelector("#events-val") as HTMLElement;
    evSlider.addEventListener("input", () => {
      this.othersEventsGb = parseInt(evSlider.value);
      evVal.textContent = `${this.othersEventsGb} GB`;
    });

    const mdSlider = container.querySelector("#media-slider") as HTMLInputElement;
    const mdVal = container.querySelector("#media-val") as HTMLElement;
    mdSlider.addEventListener("input", () => {
      this.othersMediaGb = parseInt(mdSlider.value);
      mdVal.textContent = `${this.othersMediaGb} GB`;
    });

    // Media pills
    container.querySelectorAll(".media-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const type = (pill as HTMLElement).dataset.type as keyof typeof this.mediaTypes;
        this.mediaTypes[type] = !this.mediaTypes[type];
        pill.classList.toggle("active");
        pill.textContent = `${type.charAt(0).toUpperCase() + type.slice(1)} ${this.mediaTypes[type] ? "✓" : "✗"}`;
      });
    });

    // Radio
    container.querySelectorAll('input[name="cleanup"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        this.cleanupPolicy = (radio as HTMLInputElement).value as "oldest" | "least-interacted";
        container.querySelectorAll(".radio-option").forEach((opt) => {
          opt.classList.toggle("selected", (opt.querySelector("input") as HTMLInputElement).checked);
        });
      });
    });
  }

  private async finish(): Promise<void> {
    const config: WizardConfig = {
      npub: this.npub,
      relays: Array.from(this.selectedRelays),
      storage: {
        othersEventsGb: this.othersEventsGb,
        othersMediaGb: this.othersMediaGb,
        mediaTypes: { ...this.mediaTypes },
        cleanupPolicy: this.cleanupPolicy,
      },
    };

    // Disable button to prevent double-clicks
    const finishBtn = this.container.querySelector(".btn-finish") as HTMLButtonElement | null;
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
      // Show error in UI
      const content = this.container.querySelector(".wizard-content");
      if (content) {
        const existing = content.querySelector(".wizard-error");
        if (existing) existing.remove();
        const errEl = document.createElement("p");
        errEl.className = "wizard-error";
        errEl.textContent = `Failed to initialize: ${e}`;
        content.appendChild(errEl);
      }
      // Re-enable button
      if (finishBtn) {
        finishBtn.disabled = false;
        finishBtn.textContent = "Launch nostrito 🚀";
      }
    }
  }
}

/** Convenience function for existing app.ts import */
export function renderWizard(container: HTMLElement): void {
  const wizard = new WizardScreen();
  wizard.render(container);
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
