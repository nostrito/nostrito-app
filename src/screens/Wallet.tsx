import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { IconZap, IconX, IconSearch } from "../components/Icon";
import { useCanWrite } from "../context/SigningContext";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WalletInfo {
  wallet_type: string;
  connected: boolean;
  alias: string | null;
}

interface WalletTransaction {
  payment_hash: string;
  bolt11: string | null;
  amount: number;
  fee: number | null;
  memo: string | null;
  status: string;
  created_at: number;
  preimage: string | null;
  linked_zap_event: string | null;
}

interface DecodedInvoice {
  amount_sats: number | null;
  description: string | null;
  payment_hash: string | null;
  expiry: number;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatSats(sats: number): string {
  const abs = Math.abs(sats);
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return abs.toLocaleString();
}

/* ------------------------------------------------------------------ */
/*  Setup View                                                         */
/* ------------------------------------------------------------------ */

const WalletSetup: React.FC<{ onConnected: () => void }> = ({ onConnected }) => {
  const canWrite = useCanWrite();
  const [tab, setTab] = useState<"create" | "nwc" | "lnbits">(canWrite ? "create" : "nwc");
  const [nwcUri, setNwcUri] = useState("");
  const [lnbitsUrl, setLnbitsUrl] = useState("");
  const [lnbitsKey, setLnbitsKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectNwc = async () => {
    if (!nwcUri.startsWith("nostr+walletconnect://")) {
      setError("URI must start with nostr+walletconnect://");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await invoke("wallet_connect_nwc", { nwcUri });
      onConnected();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const connectLnbits = async () => {
    if (!lnbitsUrl || !lnbitsKey) {
      setError("Both URL and admin key are required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await invoke("wallet_connect_lnbits", { url: lnbitsUrl, adminKey: lnbitsKey });
      onConnected();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="wallet-page-inner">
      <div className="wallet-setup-card">
        <div className="wallet-setup-header">
          <span className="icon"><IconZap /></span>
          <span>connect a lightning wallet</span>
        </div>

        <div className="wallet-setup-tabs">
          {canWrite && (
            <button
              className={`wallet-setup-tab${tab === "create" ? " active" : ""}`}
              onClick={() => { setTab("create"); setError(null); }}
            >
              create wallet
            </button>
          )}
          <button
            className={`wallet-setup-tab${tab === "nwc" ? " active" : ""}`}
            onClick={() => { setTab("nwc"); setError(null); }}
          >
            NWC
          </button>
          <button
            className={`wallet-setup-tab${tab === "lnbits" ? " active" : ""}`}
            onClick={() => { setTab("lnbits"); setError(null); }}
          >
            LNbits
          </button>
        </div>

        {tab === "create" && canWrite && (
          <div className="wallet-setup-form">
            <p className="wallet-setup-hint">
              auto-create a custodial lightning wallet at zaps.nostr-wot.com.
              fast and easy — you can always switch to your own wallet later.
            </p>
            <button
              className="wallet-setup-connect-btn"
              disabled={provisioning}
              onClick={async () => {
                setProvisioning(true);
                setError(null);
                try {
                  await invoke("wallet_provision");
                  onConnected();
                } catch (e: any) {
                  setError(typeof e === "string" ? e : e?.message || "Provisioning failed");
                } finally {
                  setProvisioning(false);
                }
              }}
            >
              {provisioning ? "creating wallet..." : "create wallet"}
            </button>
          </div>
        )}

        {tab === "nwc" && (
          <div className="wallet-setup-form">
            <label className="wallet-setup-label">nostr wallet connect URI</label>
            <input
              type="text"
              className="wallet-setup-input"
              placeholder="nostr+walletconnect://..."
              value={nwcUri}
              onChange={(e) => setNwcUri(e.target.value)}
              spellCheck={false}
            />
            <p className="wallet-setup-hint">
              get this from your NWC-compatible wallet (Alby, Mutiny, etc.)
            </p>
            <button
              className="wallet-setup-connect-btn"
              disabled={loading || !nwcUri}
              onClick={connectNwc}
            >
              {loading ? "connecting..." : "connect"}
            </button>
          </div>
        )}

        {tab === "lnbits" && (
          <div className="wallet-setup-form">
            <label className="wallet-setup-label">LNbits instance URL</label>
            <input
              type="text"
              className="wallet-setup-input"
              placeholder="https://legend.lnbits.com"
              value={lnbitsUrl}
              onChange={(e) => setLnbitsUrl(e.target.value)}
              spellCheck={false}
            />
            <label className="wallet-setup-label">admin key</label>
            <input
              type="password"
              className="wallet-setup-input"
              placeholder="paste your admin key"
              value={lnbitsKey}
              onChange={(e) => setLnbitsKey(e.target.value)}
              spellCheck={false}
            />
            <button
              className="wallet-setup-connect-btn"
              disabled={loading || !lnbitsUrl || !lnbitsKey}
              onClick={connectLnbits}
            >
              {loading ? "connecting..." : "connect"}
            </button>
          </div>
        )}

        {error && <div className="wallet-setup-error">{error}</div>}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Dashboard View                                                     */
/* ------------------------------------------------------------------ */

const WalletDashboard: React.FC<{
  info: WalletInfo;
  onDisconnected: () => void;
}> = ({ info, onDisconnected }) => {
  const navigate = useNavigate();

  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [txOffset, setTxOffset] = useState(0);
  const [txHasMore, setTxHasMore] = useState(true);
  const [txSearch, setTxSearch] = useState("");

  // Modals
  const [showReceive, setShowReceive] = useState(false);
  const [receiveAmount, setReceiveAmount] = useState("");
  const [receiveMemo, setReceiveMemo] = useState("");
  const [receiveInvoice, setReceiveInvoice] = useState("");
  const [receiveLoading, setReceiveLoading] = useState(false);
  const [receiveCopied, setReceiveCopied] = useState(false);

  const [showSend, setShowSend] = useState(false);
  const [sendBolt11, setSendBolt11] = useState("");
  const [sendPreview, setSendPreview] = useState<DecodedInvoice | null>(null);
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState(false);

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      const res = await invoke<{ balance: number }>("wallet_get_balance");
      setBalance(res.balance);
    } catch {
      setBalance(null);
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  const fetchTransactions = useCallback(async (offset: number, append: boolean) => {
    try {
      const txs = await invoke<WalletTransaction[]>("wallet_list_transactions", {
        limit: 20,
        offset,
      });
      if (append) {
        setTransactions((prev) => [...prev, ...txs]);
      } else {
        setTransactions(txs);
      }
      setTxHasMore(txs.length === 20);
      setTxOffset(offset + txs.length);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchBalance();
    fetchTransactions(0, false);
  }, [fetchBalance, fetchTransactions]);

  const handleDisconnect = async () => {
    try {
      await invoke("wallet_disconnect");
      onDisconnected();
    } catch (e: any) {
      console.error("Disconnect failed:", e);
    }
  };

  // Receive flow
  const handleCreateInvoice = async () => {
    const amt = parseInt(receiveAmount);
    if (!amt || amt <= 0) return;
    setReceiveLoading(true);
    try {
      const res = await invoke<{ bolt11: string; payment_hash: string }>("wallet_make_invoice", {
        amount: amt,
        memo: receiveMemo || null,
      });
      setReceiveInvoice(res.bolt11);
    } catch {
      // silently fail
    } finally {
      setReceiveLoading(false);
    }
  };

  const copyInvoice = () => {
    navigator.clipboard.writeText(receiveInvoice);
    setReceiveCopied(true);
    setTimeout(() => setReceiveCopied(false), 2000);
  };

  // Send flow
  const handleDecodeBolt11 = async (bolt11: string) => {
    setSendBolt11(bolt11);
    setSendPreview(null);
    setSendError(null);
    if (!bolt11.trim()) return;
    try {
      const decoded = await invoke<DecodedInvoice>("wallet_decode_bolt11", { invoice: bolt11 });
      setSendPreview(decoded);
    } catch {
      setSendError("Could not decode invoice");
    }
  };

  const handlePayInvoice = async () => {
    setSendLoading(true);
    setSendError(null);
    try {
      await invoke("wallet_pay_invoice", { bolt11: sendBolt11 });
      setSendSuccess(true);
      fetchBalance();
      fetchTransactions(0, false);
    } catch (e: any) {
      setSendError(String(e));
    } finally {
      setSendLoading(false);
    }
  };

  const filteredTxs = txSearch
    ? transactions.filter(
        (tx) =>
          tx.memo?.toLowerCase().includes(txSearch.toLowerCase()) ||
          String(Math.abs(tx.amount)).includes(txSearch)
      )
    : transactions;

  return (
    <div className="wallet-page-inner">
      {/* Balance Card */}
      <div className="wallet-balance-card">
        <div className="wallet-balance-top">
          <span className="wallet-balance-label">balance</span>
          <span className="wallet-type-badge">{info.wallet_type}</span>
        </div>
        <div className="wallet-balance-row">
          <span className="wallet-balance-value">
            {balanceLoading ? "..." : balance !== null ? formatSats(balance) : "--"}
          </span>
          <span className="wallet-balance-unit">sats</span>
        </div>
        <div className="wallet-action-row">
          <button className="wallet-action-btn" onClick={() => {
            setShowReceive(true);
            setReceiveAmount("");
            setReceiveMemo("");
            setReceiveInvoice("");
          }}>
            <span className="icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg></span>
            receive
          </button>
          <button className="wallet-action-btn" onClick={() => {
            setShowSend(true);
            setSendBolt11("");
            setSendPreview(null);
            setSendError(null);
            setSendSuccess(false);
          }}>
            <span className="icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg></span>
            send
          </button>
          <button className="wallet-action-btn" onClick={fetchBalance} disabled={balanceLoading}>
            <span className="icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" /></svg></span>
            refresh
          </button>
        </div>
      </div>

      {/* Transactions */}
      <div className="wallet-tx-section">
        <div className="wallet-tx-header">
          <span className="wallet-tx-title">transactions</span>
          <div className="wallet-tx-search">
            <span className="icon"><IconSearch /></span>
            <input
              type="text"
              placeholder="search..."
              value={txSearch}
              onChange={(e) => setTxSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="wallet-tx-list">
          {filteredTxs.length === 0 && (
            <div className="wallet-tx-empty">no transactions yet</div>
          )}
          {filteredTxs.map((tx, i) => (
            <div key={tx.payment_hash + i} className="wallet-tx-row">
              <span className={`wallet-tx-dir ${tx.amount >= 0 ? "incoming" : "outgoing"}`}>
                {tx.amount >= 0 ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                )}
              </span>
              <div className="wallet-tx-info">
                <span className="wallet-tx-memo">{tx.memo || (tx.amount >= 0 ? "received" : "sent")}</span>
                <span className="wallet-tx-time">{timeAgo(tx.created_at)}</span>
              </div>
              <span className={`wallet-tx-amount ${tx.amount >= 0 ? "incoming" : "outgoing"}`}>
                {tx.amount >= 0 ? "+" : ""}{formatSats(tx.amount)} sats
              </span>
              {tx.linked_zap_event && (
                <button
                  className="wallet-zap-link"
                  onClick={() => navigate(`/note/${tx.linked_zap_event}`)}
                  title="View linked zap event"
                >
                  <IconZap />
                </button>
              )}
            </div>
          ))}
        </div>
        {txHasMore && !txSearch && (
          <div className="wallet-tx-more">
            <button
              className="storage-load-more-btn"
              onClick={() => fetchTransactions(txOffset, true)}
            >
              show more
            </button>
          </div>
        )}
      </div>

      {/* Disconnect */}
      <div className="wallet-footer">
        {info.alias && <span className="wallet-footer-alias">{info.alias}</span>}
        <button className="wallet-disconnect-btn" onClick={handleDisconnect}>
          disconnect wallet
        </button>
      </div>

      {/* Receive Modal */}
      {showReceive && (
        <div className="wallet-modal-overlay" onClick={() => setShowReceive(false)}>
          <div className="wallet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wallet-modal-header">
              <span>receive</span>
              <button className="wallet-modal-close" onClick={() => setShowReceive(false)}>
                <IconX />
              </button>
            </div>
            {!receiveInvoice ? (
              <div className="wallet-modal-body">
                <label className="wallet-setup-label">amount (sats)</label>
                <input
                  type="number"
                  className="wallet-setup-input"
                  placeholder="21000"
                  value={receiveAmount}
                  onChange={(e) => setReceiveAmount(e.target.value)}
                  min="1"
                />
                <label className="wallet-setup-label">memo (optional)</label>
                <input
                  type="text"
                  className="wallet-setup-input"
                  placeholder="what's this for?"
                  value={receiveMemo}
                  onChange={(e) => setReceiveMemo(e.target.value)}
                />
                <button
                  className="wallet-setup-connect-btn"
                  disabled={receiveLoading || !receiveAmount}
                  onClick={handleCreateInvoice}
                >
                  {receiveLoading ? "creating..." : "create invoice"}
                </button>
              </div>
            ) : (
              <div className="wallet-modal-body">
                <label className="wallet-setup-label">lightning invoice</label>
                <div className="wallet-invoice-display">{receiveInvoice}</div>
                <button className="wallet-setup-connect-btn" onClick={copyInvoice}>
                  {receiveCopied ? "copied!" : "copy invoice"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Send Modal */}
      {showSend && (
        <div className="wallet-modal-overlay" onClick={() => setShowSend(false)}>
          <div className="wallet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wallet-modal-header">
              <span>send</span>
              <button className="wallet-modal-close" onClick={() => setShowSend(false)}>
                <IconX />
              </button>
            </div>
            <div className="wallet-modal-body">
              {sendSuccess ? (
                <div className="wallet-send-success">
                  <span className="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></svg></span>
                  <span>payment sent!</span>
                </div>
              ) : (
                <>
                  <label className="wallet-setup-label">bolt11 invoice</label>
                  <textarea
                    className="wallet-setup-input wallet-send-textarea"
                    placeholder="paste a lightning invoice..."
                    value={sendBolt11}
                    onChange={(e) => handleDecodeBolt11(e.target.value)}
                    spellCheck={false}
                    rows={3}
                  />
                  {sendPreview && (
                    <div className="wallet-send-preview">
                      {sendPreview.amount_sats !== null && (
                        <div className="wallet-send-preview-row">
                          <span>amount</span>
                          <span className="wallet-send-preview-val">{formatSats(sendPreview.amount_sats)} sats</span>
                        </div>
                      )}
                      {sendPreview.description && (
                        <div className="wallet-send-preview-row">
                          <span>description</span>
                          <span className="wallet-send-preview-val">{sendPreview.description}</span>
                        </div>
                      )}
                      <div className="wallet-send-preview-row">
                        <span>expires</span>
                        <span className="wallet-send-preview-val">{Math.floor(sendPreview.expiry / 60)} min</span>
                      </div>
                    </div>
                  )}
                  {sendError && <div className="wallet-setup-error">{sendError}</div>}
                  <button
                    className="wallet-setup-connect-btn"
                    disabled={sendLoading || !sendBolt11}
                    onClick={handlePayInvoice}
                  >
                    {sendLoading ? "paying..." : "pay invoice"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Main Wallet Component                                              */
/* ------------------------------------------------------------------ */

export const Wallet: React.FC = () => {
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const checkStatus = useCallback(async () => {
    try {
      const status = await invoke<WalletInfo | null>("wallet_get_status");
      setWalletInfo(status);
    } catch {
      setWalletInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  if (loading) {
    return <div className="wallet-page-inner"><div className="wallet-loading">loading wallet...</div></div>;
  }

  if (!walletInfo) {
    return <WalletSetup onConnected={checkStatus} />;
  }

  return <WalletDashboard info={walletInfo} onDisconnected={checkStatus} />;
};
