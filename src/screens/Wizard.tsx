import React, { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IconCheck,
  IconBookOpen,
  IconKey,
  IconCastle,
  IconPlug,
  IconSparkles,
  IconLock,
  IconImage,
  IconVideo,
  IconVolume,
  IconClipboard,
  IconParty,
  IconFeather,
  IconScale,
  IconArchive,
} from "../components/Icon";
import {
  STORAGE_PRESETS,
  STORAGE_PRESET_KEYS,
  estimateStorage,
} from "../utils/storagePresets";
import { RelayCard } from "../components/RelayCard";
import { Slider } from "../components/Slider";
import { useAppContext } from "../context/AppContext";
import { RELAYS, resolveRelayUrl } from "../relays";
/* escapeHtml not needed — React auto-escapes JSX expressions */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type IdentityMode = "readonly" | "full";
type SignerType = "nsec" | "bunker" | "connect" | "new";
interface MediaTypes {
  images: boolean;
  videos: boolean;
  audio: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STEP_LABELS = ["identity", "relays", "storage"];

const CLIENTS = [
  { name: "damus", icon: "D" },
  { name: "amethyst", icon: "A" },
  { name: "primal", icon: "P" },
  { name: "coracle", icon: "C" },
  { name: "snort", icon: "S" },
];

const SIGNER_OPTIONS: { type: SignerType; icon: React.ReactNode; label: string }[] = [
  { type: "nsec", icon: <span className="icon"><IconKey /></span>, label: "paste nsec" },
  { type: "bunker", icon: <span className="icon"><IconCastle /></span>, label: "nbunker / NIP-46" },
  { type: "connect", icon: <span className="icon"><IconPlug /></span>, label: "nostr connect" },
  { type: "new", icon: <span className="icon"><IconSparkles /></span>, label: "create new account" },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isNpubValid(npub: string): boolean {
  return npub.startsWith("npub1") && npub.length === 63;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const Wizard: React.FC = () => {
  const navigate = useNavigate();
  const { setInitialized } = useAppContext();

  /* --- state -------------------------------------------------------- */
  const [step, setStep] = useState(1);
  const [identityMode, setIdentityMode] = useState<IdentityMode>("readonly");
  const [npub, setNpub] = useState("");
  const [npubError, setNpubError] = useState("");
  const [nsecInput, setNsecInput] = useState("");
  const [nsecError, setNsecError] = useState("");
  const [signerType, setSignerType] = useState<SignerType | null>(null);
  const [selectedRelays, setSelectedRelays] = useState<Set<string>>(
    () => new Set(RELAYS.filter((r) => r.defaultOn).map((r) => r.id))
  );
  const [storagePreset, setStoragePreset] = useState<string>("balanced");
  const [customMode, setCustomMode] = useState(false);
  const [othersEventsGb, setOthersEventsGb] = useState(5);
  const [trackedMediaGb, setTrackedMediaGb] = useState(3);
  const [wotMediaGb, setWotMediaGb] = useState(2);
  const [mediaTypes, setMediaTypes] = useState<MediaTypes>({ images: true, videos: true, audio: true });

  // Step 4 state (relay URL screen)
  const [relayPort, setRelayPort] = useState(4869);
  const [browserIntegration, setBrowserIntegration] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Finish state
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const npubInputRef = useRef<HTMLInputElement>(null);

  /* --- titlebar actions --------------------------------------------- */
  const handleClose = useCallback(() => getCurrentWindow().close(), []);
  const handleMinimize = useCallback(() => getCurrentWindow().minimize(), []);
  const handleMaximize = useCallback(() => getCurrentWindow().toggleMaximize(), []);

  /* --- relay toggle ------------------------------------------------- */
  const toggleRelay = useCallback((id: string) => {
    setSelectedRelays((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /* --- media type toggle -------------------------------------------- */
  const toggleMediaType = useCallback((type: keyof MediaTypes) => {
    setMediaTypes((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  /* --- storage preset application ---------------------------------- */
  const applyStoragePreset = useCallback((key: string) => {
    const preset = STORAGE_PRESETS[key];
    if (!preset) return;
    setStoragePreset(key);
    setOthersEventsGb(preset.othersEventsGb);
    setTrackedMediaGb(preset.trackedMediaGb);
    setWotMediaGb(preset.wotMediaGb);
    setMediaTypes({ ...preset.mediaTypes });
  }, []);

  /* --- navigation logic --------------------------------------------- */
  const canGoNext = (): boolean => {
    if (step === 1) {
      if (identityMode === "readonly") return isNpubValid(npub);
      if (identityMode === "full") {
        if (signerType === "nsec") return nsecInput.trim().startsWith("nsec1");
        return signerType !== null;
      }
    }
    if (step === 2) return selectedRelays.size > 0;
    return true;
  };

  const handleBack = useCallback(() => {
    if (step > 1) setStep((s) => s - 1);
  }, [step]);

  const handleNext = useCallback(async () => {
    if (step === 1) {
      if (identityMode === "readonly" && !isNpubValid(npub)) {
        setNpubError("enter a valid npub (starts with npub1, 63 characters)");
        return;
      }
      if (identityMode === "full" && signerType === "nsec") {
        if (!nsecInput.trim().startsWith("nsec1")) {
          setNsecError("enter a valid nsec (starts with nsec1)");
          return;
        }
        try {
          const derived = await invoke<string>("nsec_to_npub", { nsec: nsecInput.trim() });
          setNpub(derived);
          setNsecError("");
        } catch (e: any) {
          setNsecError(String(e));
          return;
        }
      }
    }
    if (step === 2 && selectedRelays.size === 0) return;

    if (step < 3) {
      setStep((s) => s + 1);
    } else {
      await handleFinish();
    }
  }, [step, identityMode, npub, nsecInput, signerType, selectedRelays]);

  /* --- finish handler ----------------------------------------------- */
  const handleFinish = async () => {
    setFinishing(true);
    setFinishError(null);

    const relays = Array.from(selectedRelays).map(resolveRelayUrl);

    try {
      const preset = STORAGE_PRESETS[storagePreset];
      console.log("[wizard] Calling init_nostrito with preset:", storagePreset);
      await invoke("init_nostrito", {
        npub,
        relays,
        storageOthersGb: othersEventsGb,
        storageTrackedMediaGb: trackedMediaGb,
        storageWotMediaGb: wotMediaGb,
        wotRetentionDays: preset?.wotRetentionDays ?? 30,
        maxEventAgeDays: preset?.maxEventAgeDays ?? 30,
        retentionOverrides: preset ? JSON.stringify(preset.retentionOverrides) : undefined,
        storagePreset,
      });

      console.log("[wizard] init_nostrito succeeded");

      // If nsec was provided, store it in keychain
      if (identityMode === "full" && signerType === "nsec" && nsecInput.trim()) {
        await invoke("set_nsec", { nsec: nsecInput.trim() });
        console.log("[wizard] nsec saved to keychain");
      }

      localStorage.setItem("nostrito_initialized", "true");
      localStorage.setItem(
        "nostrito_config",
        JSON.stringify({
          identityMode,
          npub,
          signerType: signerType || undefined,
          relays,
          storagePreset,
          storage: {
            othersEventsGb,
            trackedMediaGb,
            wotMediaGb,
            mediaTypes: { ...mediaTypes },
          },
        })
      );

      setInitialized(true);

      // Fetch relay port
      try {
        const status = await invoke<{ relay_port: number }>("get_status");
        setRelayPort(status.relay_port);
      } catch (_) {
        // Fall back to default port
      }

      // Check browser integration
      try {
        const bi = await invoke<boolean>("check_browser_integration");
        setBrowserIntegration(bi);
      } catch (_) {
        setBrowserIntegration(false);
      }

      setStep(4);
    } catch (e) {
      console.error("[nostrito] Failed to initialize:", e);
      setFinishError(`failed to initialize: ${e}`);
      setFinishing(false);
    }
  };

  /* --- copy relay URL ----------------------------------------------- */
  const handleCopyRelay = useCallback(async () => {
    const protocol = browserIntegration ? "wss" : "ws";
    const url = `${protocol}://localhost:${relayPort}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (err) {
      console.warn("[wizard] Clipboard write failed:", err);
    }
  }, [browserIntegration, relayPort]);

  /* --- npub input handler ------------------------------------------- */
  const handleNpubChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNpub(e.target.value.trim());
    setNpubError("");
  }, []);

  /* --- relay URL for display ---------------------------------------- */
  const relayUrl = `${browserIntegration ? "wss" : "ws"}://localhost:${relayPort}`;

  /* ================================================================== */
  /*  RENDER                                                            */
  /* ================================================================== */

  return (
    <div className="wizard-root">
      {/* ---- Titlebar ---- */}
      <div className="wizard-titlebar" data-tauri-drag-region="">
        <div className="wizard-dots-decorative">
          <button className="dot-red tb-btn" onClick={handleClose} title="Close" />
          <button className="dot-yellow tb-btn" onClick={handleMinimize} title="Minimize" />
          <button className="dot-green tb-btn" onClick={handleMaximize} title="Maximize" />
        </div>
        <span className="wizard-titlebar-text">nostrito — setup</span>
        <div style={{ width: 52 }} />
      </div>

      {/* ---- Step 4: Relay URL screen ---- */}
      {step === 4 ? (
        <div className="wizard-container">
          <div className="wiz-panel wiz-panel-ready">
            <div className="wiz-ready-content">
              <h3 className="wiz-title wiz-ready-title">
                your local relay is running <span className="icon"><IconParty /></span>
              </h3>
              <p className="wiz-subtitle">
                add this address to your favorite nostr clients to start using your WoT-filtered feed:
              </p>

              <div className="wiz-relay-url-box">
                <code className="wiz-relay-url-text">{relayUrl}</code>
                <button
                  className="btn btn-secondary wiz-relay-copy-btn"
                  onClick={handleCopyRelay}
                  title="Copy to clipboard"
                >
                  <span className="icon"><IconClipboard /></span> copy
                </button>
              </div>
              <span className={`wiz-copy-feedback${copyFeedback ? " visible" : ""}`}>
                {copyFeedback ? "copied!" : ""}
              </span>

              <div className="wiz-clients-section">
                <p className="wiz-clients-label">works with:</p>
                <ul className="wiz-clients-list">
                  {CLIENTS.map((c) => (
                    <li key={c.name} className="wiz-client-item">
                      <span className="wiz-client-initial">{c.icon}</span> {c.name}
                    </li>
                  ))}
                </ul>
              </div>

              <button
                className="btn btn-primary wiz-open-btn"
                onClick={() => navigate("/")}
              >
                open nostrito →
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="wizard-container">
          {/* ---- Progress bar ---- */}
          <div className="wizard-progress">
            {STEP_LABELS.map((label, i) => {
              const stepNum = i + 1;
              const isDone = stepNum < step;
              const isActive = stepNum === step;

              return (
                <React.Fragment key={label}>
                  <div className={`wiz-dot-wrap${isDone ? " done" : ""}${isActive ? " active" : ""}`}>
                    <span className="wiz-dot-num">
                      {isDone ? <span className="icon"><IconCheck /></span> : String(stepNum)}
                    </span>
                    <span className="wiz-dot-label">{label}</span>
                  </div>
                  {stepNum < 3 && (
                    <div className={`wiz-line${stepNum < step ? " done" : ""}`} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* ---- Panel content ---- */}
          <div className="wiz-panel">
            {step === 1 && (
              <StepIdentity
                identityMode={identityMode}
                onIdentityModeChange={setIdentityMode}
                npub={npub}
                npubError={npubError}
                onNpubChange={handleNpubChange}
                nsecInput={nsecInput}
                nsecError={nsecError}
                onNsecChange={(e) => { setNsecInput(e.target.value); setNsecError(""); }}
                signerType={signerType}
                onSignerTypeChange={setSignerType}
                npubInputRef={npubInputRef}
              />
            )}
            {step === 2 && (
              <StepRelays
                selectedRelays={selectedRelays}
                onToggle={toggleRelay}
              />
            )}
            {step === 3 && (
              <StepStorage
                storagePreset={storagePreset}
                onPresetChange={applyStoragePreset}
                customMode={customMode}
                onCustomModeToggle={() => setCustomMode((p) => !p)}
                othersEventsGb={othersEventsGb}
                onOthersEventsGbChange={setOthersEventsGb}
                trackedMediaGb={trackedMediaGb}
                onTrackedMediaGbChange={setTrackedMediaGb}
                wotMediaGb={wotMediaGb}
                onWotMediaGbChange={setWotMediaGb}
                mediaTypes={mediaTypes}
                onToggleMediaType={toggleMediaType}
                finishError={finishError}
              />
            )}
          </div>

          {/* ---- Navigation bar ---- */}
          <div className="wiz-nav">
            <button
              className="btn btn-secondary"
              style={{ visibility: step === 1 ? "hidden" : "visible" }}
              onClick={handleBack}
            >
              ← back
            </button>
            <button
              className={`btn btn-primary${!canGoNext() || finishing ? " disabled" : ""}`}
              disabled={!canGoNext() || finishing}
              onClick={handleNext}
            >
              {finishing ? "initializing..." : step === 3 ? "finish →" : "next →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ================================================================== */
/*  Step 1: Identity                                                   */
/* ================================================================== */

interface StepIdentityProps {
  identityMode: IdentityMode;
  onIdentityModeChange: (mode: IdentityMode) => void;
  npub: string;
  npubError: string;
  onNpubChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  nsecInput: string;
  nsecError: string;
  onNsecChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  signerType: SignerType | null;
  onSignerTypeChange: (type: SignerType) => void;
  npubInputRef: React.RefObject<HTMLInputElement | null>;
}

const StepIdentity: React.FC<StepIdentityProps> = ({
  identityMode,
  onIdentityModeChange,
  npub,
  npubError,
  onNpubChange,
  nsecInput,
  nsecError,
  onNsecChange,
  signerType,
  onSignerTypeChange,
  npubInputRef,
}) => (
  <>
    <h3 className="wiz-title">your identity</h3>
    <p className="wiz-subtitle">choose how to connect. you can always upgrade later.</p>

    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20, width: "100%", maxWidth: 480 }}>
      <div
        className={`wiz-identity-option${identityMode === "readonly" ? " selected" : ""}`}
        onClick={() => onIdentityModeChange("readonly")}
      >
        <div className="wiz-identity-title">
          <span className="icon"><IconBookOpen /></span> read-only
        </div>
        <div className="wiz-identity-desc">
          paste your npub. DMs disabled, everything else works.
        </div>
      </div>
      <div
        className={`wiz-identity-option${identityMode === "full" ? " selected" : ""}`}
        onClick={() => onIdentityModeChange("full")}
      >
        <div className="wiz-identity-title">
          <span className="icon"><IconKey /></span> full access
        </div>
        <div className="wiz-identity-desc">
          connect nsec, nbunker, or nostr connect. unlocks DMs.
        </div>
      </div>
    </div>

    {/* Readonly: npub input */}
    {identityMode === "readonly" && (
      <div style={{ width: "100%", maxWidth: 480 }}>
        <input
          type="text"
          className="wiz-input"
          placeholder="npub1..."
          value={npub}
          onChange={onNpubChange}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          ref={npubInputRef}
        />
        {npubError && <p className="wiz-error">{npubError}</p>}
      </div>
    )}

    {/* Full access: signer options */}
    {identityMode === "full" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 480 }}>
        {SIGNER_OPTIONS.map((opt) => (
          <div
            key={opt.type}
            className={`wiz-signer-option${signerType === opt.type ? " selected" : ""}`}
            onClick={() => onSignerTypeChange(opt.type)}
          >
            {opt.icon} {opt.label}
          </div>
        ))}
        {signerType === "nsec" && (
          <div style={{ marginTop: 8 }}>
            <input
              type="password"
              className="wiz-input"
              placeholder="nsec1..."
              value={nsecInput}
              onChange={onNsecChange}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            {nsecError && <p className="wiz-error">{nsecError}</p>}
          </div>
        )}
      </div>
    )}
  </>
);

/* ================================================================== */
/*  Step 2: Relays                                                     */
/* ================================================================== */

interface StepRelaysProps {
  selectedRelays: Set<string>;
  onToggle: (id: string) => void;
}

const StepRelays: React.FC<StepRelaysProps> = ({ selectedRelays, onToggle }) => (
  <>
    <h3 className="wiz-title">where do you want to sync from?</h3>
    <p className="wiz-subtitle">pick by name. we handle the rest.</p>

    <div className="relay-grid">
      {RELAYS.map((relay) => (
        <RelayCard
          key={relay.id}
          relay={relay}
          selected={selectedRelays.has(relay.id)}
          onToggle={onToggle}
        />
      ))}
    </div>
  </>
);

/* ================================================================== */
/*  Step 3: Storage                                                    */
/* ================================================================== */

const PRESET_ICONS: Record<string, React.ReactNode> = {
  minimal: <IconFeather />,
  balanced: <IconScale />,
  archive: <IconArchive />,
};

const PRESET_DETAILS: Record<string, string[]> = {
  minimal: ["last 7 days for follows & WoT", "tracked profiles: full history", "images only, no WoT media"],
  balanced: ["last 30 days for follows, 7 days for WoT", "tracked profiles: full history", "all media types, 2 GB WoT media"],
  archive: ["last year for follows, 90 days for WoT", "tracked profiles: full history", "all media types, 10 GB WoT media"],
};

interface StepStorageProps {
  storagePreset: string;
  onPresetChange: (key: string) => void;
  customMode: boolean;
  onCustomModeToggle: () => void;
  othersEventsGb: number;
  onOthersEventsGbChange: (v: number) => void;
  trackedMediaGb: number;
  onTrackedMediaGbChange: (v: number) => void;
  wotMediaGb: number;
  onWotMediaGbChange: (v: number) => void;
  mediaTypes: MediaTypes;
  onToggleMediaType: (type: keyof MediaTypes) => void;
  finishError: string | null;
}

const StepStorage: React.FC<StepStorageProps> = ({
  storagePreset,
  onPresetChange,
  customMode,
  onCustomModeToggle,
  othersEventsGb,
  onOthersEventsGbChange,
  trackedMediaGb,
  onTrackedMediaGbChange,
  wotMediaGb,
  onWotMediaGbChange,
  mediaTypes,
  onToggleMediaType,
  finishError,
}) => {
  const estimate = estimateStorage(200, storagePreset);

  return (
    <>
      <h3 className="wiz-title">storage</h3>
      <p className="wiz-subtitle">choose how much to store. you can change this later in settings.</p>

      {/* Your events & media — locked */}
      <div className="storage-section">
        <div className="storage-row locked">
          <div className="storage-row-info">
            <span className="storage-row-label">your events &amp; media</span>
            <span className="storage-row-meta">
              <span className="icon"><IconLock /></span> always stored. no exceptions.
            </span>
          </div>
          <div className="storage-bar-wrap">
            <div className="storage-bar">
              <div className="storage-bar-fill" />
            </div>
            <span className="storage-bar-label">100%</span>
          </div>
        </div>
      </div>

      {/* Preset cards */}
      <div className="storage-preset-grid">
        {STORAGE_PRESET_KEYS.map((key) => {
          const preset = STORAGE_PRESETS[key];
          const details = PRESET_DETAILS[key] || [];
          const isSelected = storagePreset === key;
          return (
            <div
              key={key}
              className={`storage-preset-card${isSelected ? " selected" : ""}`}
              onClick={() => onPresetChange(key)}
            >
              <div className="storage-preset-card-header">
                <span className="icon">{PRESET_ICONS[key]}</span>
                <span className="storage-preset-card-name">{preset.label}</span>
              </div>
              <span className="storage-preset-card-size">
                ~{preset.estimatedGb.low}-{preset.estimatedGb.typical} GB
              </span>
              <p className="storage-preset-card-desc">{preset.description}</p>
              <ul className="storage-preset-card-details">
                {details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Estimation summary */}
      <div className="storage-estimate-summary">
        with ~200 follows: ~{estimate.eventsPerDay.toLocaleString()} events/day, ~{estimate.growthGbPerMonth} GB/month
      </div>

      {/* Custom mode toggle */}
      <div className="storage-custom-toggle" onClick={onCustomModeToggle}>
        {customMode ? "hide" : "customize"} advanced settings
      </div>

      {/* Advanced sliders (shown when custom mode is on) */}
      {customMode && (
        <>
          {/* Others' events */}
          <div className="storage-section">
            <div className="storage-row">
              <div className="storage-row-info">
                <span className="storage-row-label">others' events</span>
                <span className="storage-row-meta">from your web of trust</span>
              </div>
              <Slider
                variant="storage"
                id="othersEventsSlider"
                min={1}
                max={50}
                value={othersEventsGb}
                suffix=" GB"
                onChange={onOthersEventsGbChange}
              />
            </div>
          </div>

          {/* Tracked profiles media */}
          <div className="storage-section">
            <div className="storage-row">
              <div className="storage-row-info">
                <span className="storage-row-label">tracked profiles media</span>
                <span className="storage-row-meta">media from profiles you track</span>
              </div>
              <Slider
                variant="storage"
                id="trackedMediaSlider"
                min={1}
                max={50}
                value={trackedMediaGb}
                suffix=" GB"
                onChange={onTrackedMediaGbChange}
              />
            </div>
          </div>

          {/* WoT media */}
          <div className="storage-section">
            <div className="storage-row">
              <div className="storage-row-info">
                <span className="storage-row-label">WoT media</span>
                <span className="storage-row-meta">images, videos, audio from your network</span>
              </div>
              <Slider
                variant="storage"
                id="wotMediaSlider"
                min={1}
                max={50}
                value={wotMediaGb}
                suffix=" GB"
                onChange={onWotMediaGbChange}
              />
            </div>
            <div className="media-toggles">
              <div
                className={`media-toggle${mediaTypes.images ? " active" : ""}`}
                onClick={() => onToggleMediaType("images")}
              >
                <span className="icon"><IconImage /></span> images
              </div>
              <div
                className={`media-toggle${mediaTypes.videos ? " active" : ""}`}
                onClick={() => onToggleMediaType("videos")}
              >
                <span className="icon"><IconVideo /></span> videos
              </div>
              <div
                className={`media-toggle${mediaTypes.audio ? " active" : ""}`}
                onClick={() => onToggleMediaType("audio")}
              >
                <span className="icon"><IconVolume /></span> audio
              </div>
            </div>
          </div>

        </>
      )}

      {finishError && <p className="wiz-error">{finishError}</p>}
    </>
  );
};
