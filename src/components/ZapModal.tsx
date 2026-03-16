import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconZap, IconX, IconCheck, IconAlertTriangle, IconWallet } from "./Icon";

interface ZapModalProps {
  eventId: string;
  recipientPubkey: string;
  recipientLud16: string | null;
  onClose: () => void;
}

type Phase = "loading" | "no-wallet" | "no-lud16" | "amount-select" | "sending" | "success" | "error";

interface WalletStatus {
  wallet_type: string;
  connected: boolean;
  alias: string | null;
}

const ZAP_PRESETS = [
  { sats: 17, label: "17", message: "nice!" },
  { sats: 21, label: "21", message: "great post!" },
  { sats: 100, label: "100", message: "solid content" },
  { sats: 500, label: "500", message: "this is awesome" },
  { sats: 1000, label: "1k", message: "incredible work" },
  { sats: 5000, label: "5k", message: "legendary!" },
];

export const ZapModal: React.FC<ZapModalProps> = ({ eventId, recipientPubkey, recipientLud16, onClose }) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [balance, setBalance] = useState<number>(0);
  const [selectedAmount, setSelectedAmount] = useState<number>(21);
  const [customAmount, setCustomAmount] = useState<string>("");
  const [message, setMessage] = useState<string>("great post!");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [hasNsec, setHasNsec] = useState<boolean>(false);

  // Wallet connection sub-state
  const [connectTab, setConnectTab] = useState<"create" | "nwc" | "lnbits">("create");
  const [nwcUri, setNwcUri] = useState("");
  const [lnbitsUrl, setLnbitsUrl] = useState("");
  const [lnbitsKey, setLnbitsKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");

  // Check wallet status on mount
  useEffect(() => {
    (async () => {
      try {
        // Check signing mode
        const mode = await invoke<string>("get_signing_mode");
        setHasNsec(mode === "nsec");

        if (!recipientLud16) {
          setPhase("no-lud16");
          return;
        }

        const status = await invoke<WalletStatus | null>("wallet_get_status");
        if (!status || !status.connected) {
          setPhase("no-wallet");
          return;
        }

        // Get balance
        const balData = await invoke<{ balance: number }>("wallet_get_balance");
        setBalance(balData.balance);
        setPhase("amount-select");
      } catch (err) {
        setPhase("no-wallet");
      }
    })();
  }, [recipientLud16]);

  const effectiveAmount = customAmount ? parseInt(customAmount, 10) || 0 : selectedAmount;
  const insufficientBalance = effectiveAmount > balance;

  const handlePresetClick = (sats: number, msg: string) => {
    setSelectedAmount(sats);
    setCustomAmount("");
    setMessage(msg);
  };

  const handleCustomAmountChange = (val: string) => {
    setCustomAmount(val.replace(/[^0-9]/g, ""));
    if (val) setSelectedAmount(0);
  };

  const handleMaxClick = () => {
    setCustomAmount(String(balance));
    setSelectedAmount(0);
  };

  const handleSendZap = useCallback(async () => {
    if (effectiveAmount <= 0 || insufficientBalance) return;
    setPhase("sending");
    try {
      await invoke("send_zap", {
        recipientPubkey,
        eventId,
        lud16: recipientLud16,
        amountSats: effectiveAmount,
        comment: message || null,
      });
      setPhase("success");
    } catch (err: any) {
      setErrorMsg(typeof err === "string" ? err : err?.message || "Zap failed");
      setPhase("error");
    }
  }, [effectiveAmount, insufficientBalance, recipientPubkey, eventId, recipientLud16, message]);

  const handleProvision = async () => {
    setConnecting(true);
    setConnectError("");
    try {
      await invoke("wallet_provision");
      const balData = await invoke<{ balance: number }>("wallet_get_balance");
      setBalance(balData.balance);
      setPhase("amount-select");
    } catch (err: any) {
      setConnectError(typeof err === "string" ? err : err?.message || "Provisioning failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectNwc = async () => {
    if (!nwcUri.trim()) return;
    setConnecting(true);
    setConnectError("");
    try {
      await invoke("wallet_connect_nwc", { nwcUri: nwcUri.trim() });
      const balData = await invoke<{ balance: number }>("wallet_get_balance");
      setBalance(balData.balance);
      setPhase("amount-select");
    } catch (err: any) {
      setConnectError(typeof err === "string" ? err : err?.message || "NWC connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectLnbits = async () => {
    if (!lnbitsUrl.trim() || !lnbitsKey.trim()) return;
    setConnecting(true);
    setConnectError("");
    try {
      await invoke("wallet_connect_lnbits", { url: lnbitsUrl.trim(), adminKey: lnbitsKey.trim() });
      const balData = await invoke<{ balance: number }>("wallet_get_balance");
      setBalance(balData.balance);
      setPhase("amount-select");
    } catch (err: any) {
      setConnectError(typeof err === "string" ? err : err?.message || "LNbits connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleRetry = () => {
    setErrorMsg("");
    setPhase("amount-select");
  };

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="wallet-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wallet-modal" style={{ width: 420 }}>
        <div className="wallet-modal-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="icon" style={{ color: "#facc15" }}><IconZap /></span>
            {phase === "no-wallet" ? "connect wallet" : phase === "success" ? "zap sent!" : "send zap"}
          </span>
          <button className="wallet-modal-close" onClick={onClose}><IconX /></button>
        </div>

        <div className="wallet-modal-body">
          {/* Loading */}
          {phase === "loading" && (
            <div style={{ textAlign: "center", padding: 24, color: "var(--text-muted)" }}>loading...</div>
          )}

          {/* No lightning address */}
          {phase === "no-lud16" && (
            <div style={{ textAlign: "center", padding: 16 }}>
              <span className="icon" style={{ color: "var(--text-muted)" }}><IconAlertTriangle /></span>
              <p style={{ color: "var(--text-dim)", fontSize: "0.88rem", marginTop: 8 }}>
                this user has no lightning address — zapping is not available.
              </p>
            </div>
          )}

          {/* No wallet connected */}
          {phase === "no-wallet" && (
            <>
              <div className="wallet-setup-tabs">
                {hasNsec && (
                  <button
                    className={`wallet-setup-tab${connectTab === "create" ? " active" : ""}`}
                    onClick={() => setConnectTab("create")}
                  >create wallet</button>
                )}
                <button
                  className={`wallet-setup-tab${connectTab === "nwc" ? " active" : ""}`}
                  onClick={() => setConnectTab("nwc")}
                >NWC</button>
                <button
                  className={`wallet-setup-tab${connectTab === "lnbits" ? " active" : ""}`}
                  onClick={() => setConnectTab("lnbits")}
                >LNbits</button>
              </div>

              {connectTab === "create" && hasNsec && (
                <div className="wallet-setup-form">
                  <p className="wallet-setup-hint" style={{ marginBottom: 8 }}>
                    auto-create a custodial wallet at zaps.nostr-wot.com.
                    fast and easy — you can always switch later.
                  </p>
                  <button
                    className="wallet-setup-connect-btn"
                    onClick={handleProvision}
                    disabled={connecting}
                  >
                    {connecting ? "creating wallet..." : "create wallet"}
                  </button>
                </div>
              )}

              {connectTab === "nwc" && (
                <div className="wallet-setup-form">
                  <label className="wallet-setup-label">NWC connection URI</label>
                  <input
                    className="wallet-setup-input"
                    placeholder="nostr+walletconnect://..."
                    value={nwcUri}
                    onChange={(e) => setNwcUri(e.target.value)}
                  />
                  <button
                    className="wallet-setup-connect-btn"
                    onClick={handleConnectNwc}
                    disabled={connecting || !nwcUri.trim()}
                  >
                    {connecting ? "connecting..." : "connect"}
                  </button>
                </div>
              )}

              {connectTab === "lnbits" && (
                <div className="wallet-setup-form">
                  <label className="wallet-setup-label">LNbits instance URL</label>
                  <input
                    className="wallet-setup-input"
                    placeholder="https://legend.lnbits.com"
                    value={lnbitsUrl}
                    onChange={(e) => setLnbitsUrl(e.target.value)}
                  />
                  <label className="wallet-setup-label">admin key</label>
                  <input
                    className="wallet-setup-input"
                    placeholder="admin key"
                    value={lnbitsKey}
                    onChange={(e) => setLnbitsKey(e.target.value)}
                  />
                  <button
                    className="wallet-setup-connect-btn"
                    onClick={handleConnectLnbits}
                    disabled={connecting || !lnbitsUrl.trim() || !lnbitsKey.trim()}
                  >
                    {connecting ? "connecting..." : "connect"}
                  </button>
                </div>
              )}

              {connectError && <div className="wallet-setup-error">{connectError}</div>}
            </>
          )}

          {/* Amount selection */}
          {phase === "amount-select" && (
            <>
              <div className="zap-balance-row">
                <span className="icon" style={{ color: "#facc15" }}><IconWallet /></span>
                <span>{balance.toLocaleString()} sats</span>
              </div>

              <div className="zap-preset-grid">
                {ZAP_PRESETS.map((p) => (
                  <button
                    key={p.sats}
                    className={`zap-preset-btn${!customAmount && selectedAmount === p.sats ? " active" : ""}`}
                    onClick={() => handlePresetClick(p.sats, p.message)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="zap-custom-row">
                <input
                  className="wallet-setup-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="custom amount"
                  value={customAmount}
                  onChange={(e) => handleCustomAmountChange(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="zap-max-btn"
                  onClick={handleMaxClick}
                >max</button>
              </div>

              {insufficientBalance && effectiveAmount > 0 && (
                <div className="zap-insufficient">insufficient balance</div>
              )}

              <input
                className="wallet-setup-input zap-message-input"
                type="text"
                placeholder="optional message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={280}
              />

              <button
                className="wallet-setup-connect-btn"
                style={{ background: "#facc15", color: "#000" }}
                disabled={effectiveAmount <= 0 || insufficientBalance}
                onClick={handleSendZap}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  zap {effectiveAmount > 0 ? effectiveAmount.toLocaleString() : ""} sats
                </span>
              </button>
            </>
          )}

          {/* Sending */}
          {phase === "sending" && (
            <div style={{ textAlign: "center", padding: 24, color: "var(--text-muted)" }}>
              <div style={{ marginBottom: 8 }}>sending zap...</div>
              <div style={{ fontSize: "0.78rem" }}>{effectiveAmount.toLocaleString()} sats</div>
            </div>
          )}

          {/* Success */}
          {phase === "success" && (
            <div className="zap-success">
              <span className="icon"><IconCheck /></span>
              <div>zap sent!</div>
              <div style={{ fontSize: "0.82rem", color: "var(--text-dim)" }}>
                {effectiveAmount.toLocaleString()} sats
              </div>
            </div>
          )}

          {/* Error */}
          {phase === "error" && (
            <div style={{ textAlign: "center", padding: 16 }}>
              <span className="icon" style={{ color: "#ef4444" }}><IconAlertTriangle /></span>
              <p style={{ color: "#ef4444", fontSize: "0.82rem", marginTop: 8 }}>{errorMsg}</p>
              <button
                className="wallet-setup-connect-btn"
                style={{ marginTop: 12 }}
                onClick={handleRetry}
              >try again</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
