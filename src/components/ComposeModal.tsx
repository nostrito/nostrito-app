import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconX, IconSend, IconCheck, IconAlertTriangle } from "./Icon";
import { profileDisplayName, type ProfileInfo } from "../utils/profiles";
import { useSigningContext } from "../context/SigningContext";
import type { NostrEvent } from "../types/nostr";

type Phase = "compose" | "signing" | "broadcasting" | "success" | "error";
type Mode = "note" | "article";

interface ComposeModalProps {
  onClose: () => void;
  onPublished?: (event: NostrEvent) => void;
  replyTo?: NostrEvent | null;
  replyToProfile?: ProfileInfo;
}

export const ComposeModal: React.FC<ComposeModalProps> = ({ onClose, onPublished, replyTo, replyToProfile }) => {
  const { signingMode } = useSigningContext();
  const [phase, setPhase] = useState<Phase>("compose");
  const [mode, setMode] = useState<Mode>("note");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePublish = useCallback(async () => {
    if (mode === "note" && !content.trim()) return;
    if (mode === "article" && (!title.trim() || !content.trim())) return;

    const isRemote = signingMode === "bunker" || signingMode === "connect";
    setPhase(isRemote ? "signing" : "broadcasting");

    try {
      if (mode === "note") {
        let rootId: string | undefined;
        let rootPubkey: string | undefined;

        if (replyTo) {
          const eTags = replyTo.tags.filter((t: string[]) => t[0] === "e");
          const rootTag = eTags.find((t: string[]) => t.length >= 4 && t[3] === "root");
          if (rootTag) {
            rootId = rootTag[1];
            const rootPTag = replyTo.tags.find((t: string[]) => t[0] === "p");
            rootPubkey = rootPTag?.[1];
          }
        }

        const published = await invoke<NostrEvent>("publish_note", {
          content: content.trim(),
          replyTo: replyTo?.id ?? null,
          replyToPubkey: replyTo?.pubkey ?? null,
          rootId: rootId ?? null,
          rootPubkey: rootPubkey ?? null,
        });
        onPublished?.(published);
      } else {
        const ht = hashtags.trim()
          ? hashtags.split(",").map((t) => t.trim()).filter(Boolean)
          : null;

        await invoke("publish_article", {
          title: title.trim(),
          content: content.trim(),
          summary: summary.trim() || null,
          dTag: null,
          image: imageUrl.trim() || null,
          hashtags: ht,
        });
      }

      setPhase("success");
      setTimeout(() => onClose(), 400);
    } catch (err: any) {
      console.error("[compose] publish failed:", err);
      setErrorMsg(typeof err === "string" ? err : err?.message || "Failed to publish");
      setPhase("error");
    }
  }, [mode, content, title, summary, imageUrl, hashtags, replyTo, signingMode, onClose, onPublished]);

  const handleRetry = () => {
    setErrorMsg("");
    setPhase("compose");
  };

  const canPublish = mode === "note"
    ? content.trim().length > 0
    : title.trim().length > 0 && content.trim().length > 0;

  return (
    <div className="wallet-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wallet-modal" style={{ width: 520 }}>
        <div className="wallet-modal-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="icon"><IconSend /></span>
            {phase === "success" ? "published!" : replyTo ? "reply" : "new post"}
          </span>
          <button className="wallet-modal-close" onClick={onClose}><IconX /></button>
        </div>

        <div className="wallet-modal-body">
          {phase === "compose" && (
            <>
              {!replyTo && (
                <div className="compose-mode-tabs">
                  <button
                    className={`compose-mode-tab${mode === "note" ? " active" : ""}`}
                    onClick={() => setMode("note")}
                  >note</button>
                  <button
                    className={`compose-mode-tab${mode === "article" ? " active" : ""}`}
                    onClick={() => setMode("article")}
                  >article</button>
                </div>
              )}

              {replyTo && (
                <div className="compose-reply-context">
                  <span className="compose-reply-author">
                    replying to {profileDisplayName(replyToProfile, replyTo.pubkey)}
                  </span>
                  <div className="compose-reply-preview">
                    {replyTo.content.slice(0, 120)}{replyTo.content.length > 120 ? "\u2026" : ""}
                  </div>
                </div>
              )}

              {mode === "article" && !replyTo && (
                <>
                  <input
                    className="compose-field"
                    placeholder="Title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <input
                    className="compose-field"
                    placeholder="Summary (optional)"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                </>
              )}

              <textarea
                className={`compose-textarea${mode === "article" ? " article-content" : ""}`}
                placeholder={replyTo ? "Write your reply\u2026" : mode === "note" ? "What's on your mind?" : "Write your article content (markdown supported)\u2026"}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                autoFocus
              />

              {mode === "article" && !replyTo && (
                <>
                  <input
                    className="compose-field"
                    placeholder="Cover image URL (optional)"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                  />
                  <input
                    className="compose-field"
                    placeholder="Hashtags, comma separated (optional)"
                    value={hashtags}
                    onChange={(e) => setHashtags(e.target.value)}
                  />
                </>
              )}
            </>
          )}

          {phase === "signing" && (
            <div style={{ textAlign: "center", padding: 32, color: "var(--text-muted)" }}>
              <div style={{ marginBottom: 8, fontSize: "0.92rem" }}>waiting for remote signer...</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
                approve the signing request in your signer app
              </div>
            </div>
          )}

          {phase === "broadcasting" && (
            <div style={{ textAlign: "center", padding: 32, color: "var(--text-muted)" }}>
              <div style={{ fontSize: "0.92rem" }}>signing &amp; broadcasting...</div>
            </div>
          )}

          {phase === "success" && (
            <div className="compose-success" style={{ justifyContent: "center", padding: 24 }}>
              <span className="icon"><IconCheck /></span>
              {mode === "note" ? (replyTo ? "reply published!" : "note published!") : "article published!"}
            </div>
          )}

          {phase === "error" && (
            <div style={{ textAlign: "center", padding: 16 }}>
              <span className="icon" style={{ color: "#ef4444" }}><IconAlertTriangle /></span>
              <p className="compose-error" style={{ marginTop: 8 }}>{errorMsg}</p>
              <button
                className="compose-publish-btn"
                style={{ margin: "12px auto 0" }}
                onClick={handleRetry}
              >try again</button>
            </div>
          )}
        </div>

        {phase === "compose" && (
          <div className="compose-footer">
            <span className="compose-status">
              {signingMode !== "nsec" && <span title={`signing via ${signingMode}`}>remote signer · </span>}
              {content.length > 0 && `${content.length} chars`}
            </span>
            <button
              className="compose-publish-btn"
              disabled={!canPublish}
              onClick={handlePublish}
            >
              <span className="icon"><IconSend /></span>
              publish
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
