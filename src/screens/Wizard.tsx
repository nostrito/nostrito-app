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
} from "../components/Icon";
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
type CleanupPolicy = "oldest" | "least-interacted";

interface MediaTypes {
  images: boolean;
  videos: boolean;
  audio: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STEP_LABELS = ["Identity", "Relays", "Storage"];

const CLIENTS = [
  { name: "Damus", icon: "D" },
  { name: "Amethyst", icon: "A" },
  { name: "Primal", icon: "P" },
  { name: "Coracle", icon: "C" },
  { name: "Snort", icon: "S" },
];

const SIGNER_OPTIONS: { type: SignerType; icon: React.ReactNode; label: string }[] = [
  { type: "nsec", icon: <span className="icon"><IconKey /></span>, label: "Paste nsec" },
  { type: "bunker", icon: <span className="icon"><IconCastle /></span>, label: "NBunker / NIP-46" },
  { type: "connect", icon: <span className="icon"><IconPlug /></span>, label: "Nostr Connect" },
  { type: "new", icon: <span className="icon"><IconSparkles /></span>, label: "Create new account" },
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
  const [othersEventsGb, setOthersEventsGb] = useState(5);
  const [trackedMediaGb, setTrackedMediaGb] = useState(3);
  const [wotMediaGb, setWotMediaGb] = useState(2);
  const [mediaTypes, setMediaTypes] = useState<MediaTypes>({ images: true, videos: true, audio: true });
  const [cleanupPolicy, setCleanupPolicy] = useState<CleanupPolicy>("oldest");

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
        setNpubError("Enter a valid npub (starts with npub1, 63 characters)");
        return;
      }
      if (identityMode === "full" && signerType === "nsec") {
        if (!nsecInput.trim().startsWith("nsec1")) {
          setNsecError("Enter a valid nsec (starts with nsec1)");
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
      console.log("[wizard] Calling init_nostrito...");
      await invoke("init_nostrito", {
        npub,
        relays,
        storageOthersGb: othersEventsGb,
        storageTrackedMediaGb: trackedMediaGb,
        storageWotMediaGb: wotMediaGb,
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
          storage: {
            othersEventsGb,
            trackedMediaGb,
            wotMediaGb,
            mediaTypes: { ...mediaTypes },
            cleanupPolicy,
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
      setFinishError(`Failed to initialize: ${e}`);
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
        <span className="wizard-titlebar-text">nostrito — Setup</span>
        <div style={{ width: 52 }} />
      </div>

      {/* ---- Step 4: Relay URL screen ---- */}
      {step === 4 ? (
        <div className="wizard-container">
          <div className="wiz-panel wiz-panel-ready">
            <div className="wiz-ready-content">
              <h3 className="wiz-title wiz-ready-title">
                Your local relay is running <span className="icon"><IconParty /></span>
              </h3>
              <p className="wiz-subtitle">
                Add this address to your favorite Nostr clients to start using your WoT-filtered feed:
              </p>

              <div className="wiz-relay-url-box">
                <code className="wiz-relay-url-text">{relayUrl}</code>
                <button
                  className="btn btn-secondary wiz-relay-copy-btn"
                  onClick={handleCopyRelay}
                  title="Copy to clipboard"
                >
                  <span className="icon"><IconClipboard /></span> Copy
                </button>
              </div>
              <span className={`wiz-copy-feedback${copyFeedback ? " visible" : ""}`}>
                {copyFeedback ? "Copied!" : ""}
              </span>

              <div className="wiz-clients-section">
                <p className="wiz-clients-label">Works with:</p>
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
                Open nostrito →
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
                othersEventsGb={othersEventsGb}
                onOthersEventsGbChange={setOthersEventsGb}
                trackedMediaGb={trackedMediaGb}
                onTrackedMediaGbChange={setTrackedMediaGb}
                wotMediaGb={wotMediaGb}
                onWotMediaGbChange={setWotMediaGb}
                mediaTypes={mediaTypes}
                onToggleMediaType={toggleMediaType}
                cleanupPolicy={cleanupPolicy}
                onCleanupPolicyChange={setCleanupPolicy}
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
              ← Back
            </button>
            <button
              className={`btn btn-primary${!canGoNext() || finishing ? " disabled" : ""}`}
              disabled={!canGoNext() || finishing}
              onClick={handleNext}
            >
              {finishing ? "Initializing..." : step === 3 ? "Finish →" : "Next →"}
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
    <h3 className="wiz-title">Your identity</h3>
    <p className="wiz-subtitle">Choose how to connect. You can always upgrade later.</p>

    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20, width: "100%", maxWidth: 480 }}>
      <div
        className={`wiz-identity-option${identityMode === "readonly" ? " selected" : ""}`}
        onClick={() => onIdentityModeChange("readonly")}
      >
        <div className="wiz-identity-title">
          <span className="icon"><IconBookOpen /></span> Read-only{" "}
          <span className="wiz-identity-badge">Recommended</span>
        </div>
        <div className="wiz-identity-desc">
          Paste your npub. DMs disabled, everything else works.
        </div>
      </div>
      <div
        className={`wiz-identity-option${identityMode === "full" ? " selected" : ""}`}
        onClick={() => onIdentityModeChange("full")}
      >
        <div className="wiz-identity-title">
          <span className="icon"><IconKey /></span> Full access
        </div>
        <div className="wiz-identity-desc">
          Connect nsec, NBunker, or Nostr Connect. Unlocks DMs.
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
    <h3 className="wiz-title">Where do you want to sync from?</h3>
    <p className="wiz-subtitle">Pick by name. We handle the rest.</p>

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

interface StepStorageProps {
  othersEventsGb: number;
  onOthersEventsGbChange: (v: number) => void;
  trackedMediaGb: number;
  onTrackedMediaGbChange: (v: number) => void;
  wotMediaGb: number;
  onWotMediaGbChange: (v: number) => void;
  mediaTypes: MediaTypes;
  onToggleMediaType: (type: keyof MediaTypes) => void;
  cleanupPolicy: CleanupPolicy;
  onCleanupPolicyChange: (policy: CleanupPolicy) => void;
  finishError: string | null;
}

const StepStorage: React.FC<StepStorageProps> = ({
  othersEventsGb,
  onOthersEventsGbChange,
  trackedMediaGb,
  onTrackedMediaGbChange,
  wotMediaGb,
  onWotMediaGbChange,
  mediaTypes,
  onToggleMediaType,
  cleanupPolicy,
  onCleanupPolicyChange,
  finishError,
}) => (
  <>
    <h3 className="wiz-title">Storage</h3>
    <p className="wiz-subtitle">Control what gets stored and how much space to use.</p>

    {/* Your events & media — locked */}
    <div className="storage-section">
      <div className="storage-row locked">
        <div className="storage-row-info">
          <span className="storage-row-label">Your events &amp; media</span>
          <span className="storage-row-meta">
            <span className="icon"><IconLock /></span> Always stored. No exceptions.
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

    {/* Others' events */}
    <div className="storage-section">
      <div className="storage-row">
        <div className="storage-row-info">
          <span className="storage-row-label">Others' events</span>
          <span className="storage-row-meta">From your Web of Trust</span>
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
          <span className="storage-row-label">Tracked profiles media</span>
          <span className="storage-row-meta">Media from profiles you track</span>
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
          <span className="storage-row-meta">Images, videos, audio from your network</span>
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
          <span className="icon"><IconImage /></span> Images
        </div>
        <div
          className={`media-toggle${mediaTypes.videos ? " active" : ""}`}
          onClick={() => onToggleMediaType("videos")}
        >
          <span className="icon"><IconVideo /></span> Videos
        </div>
        <div
          className={`media-toggle${mediaTypes.audio ? " active" : ""}`}
          onClick={() => onToggleMediaType("audio")}
        >
          <span className="icon"><IconVolume /></span> Audio
        </div>
      </div>
    </div>

    {/* Auto-cleanup */}
    <div className="storage-section">
      <div className="storage-row">
        <div className="storage-row-info">
          <span className="storage-row-label">Auto-cleanup</span>
          <span className="storage-row-meta">When storage limit is reached</span>
        </div>
        <div className="cleanup-group">
          <div
            className={`cleanup-radio${cleanupPolicy === "oldest" ? " active" : ""}`}
            onClick={() => onCleanupPolicyChange("oldest")}
          >
            Oldest first
          </div>
          <div
            className={`cleanup-radio${cleanupPolicy === "least-interacted" ? " active" : ""}`}
            onClick={() => onCleanupPolicyChange("least-interacted")}
          >
            Least interacted
          </div>
        </div>
      </div>
    </div>

    {finishError && <p className="wiz-error">{finishError}</p>}
  </>
);
