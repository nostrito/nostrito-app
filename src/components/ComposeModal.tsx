import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { IconX, IconSend, IconCheck, IconAlertTriangle, IconImage } from "./Icon";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { ImageUploadField } from "./ImageUploadField";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { renderMarkdown } from "../utils/markdown";
import { applyToolbarAction, type ToolbarAction } from "../utils/markdownToolbar";
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
  const [cwText, setCwText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Article preview
  const [showPreview, setShowPreview] = useState(false);

  // Note image upload
  const [noteUploading, setNoteUploading] = useState(false);
  const [noteUploadError, setNoteUploadError] = useState<string | null>(null);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);

    // Detect @mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\S*)$/);

    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionStart(cursorPos - atMatch[0].length);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const handleMentionSelect = useCallback(async (pubkey: string, _displayName: string) => {
    try {
      const npub = await invoke<string>("hex_to_npub", { hexPubkey: pubkey });
      const before = content.slice(0, mentionStart);
      const afterIdx = mentionStart + 1 + (mentionQuery?.length ?? 0); // +1 for @
      const after = content.slice(afterIdx);
      setContent(`${before}nostr:${npub} ${after}`);
      setMentionQuery(null);
      // Focus back on textarea
      setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (err) {
      console.warn("[compose] mention select failed:", err);
    }
  }, [content, mentionStart, mentionQuery]);

  // Note mode: image upload → insert URL at cursor
  const handleNoteImageUpload = useCallback(async () => {
    setNoteUploadError(null);
    try {
      const filePath = await open({
        multiple: false, directory: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (!filePath || typeof filePath !== "string") return;
      setNoteUploading(true);
      const url = await invoke<string>("upload_to_blossom", { filePath });
      const ta = textareaRef.current;
      if (ta) {
        const pos = ta.selectionStart;
        const before = content.slice(0, pos);
        const after = content.slice(pos);
        const pad = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
        setContent(before + pad + url + "\n" + after);
        setTimeout(() => {
          ta.focus();
          const newPos = before.length + pad.length + url.length + 1;
          ta.selectionStart = ta.selectionEnd = newPos;
        }, 0);
      } else {
        setContent(prev => prev + "\n" + url);
      }
    } catch (err) {
      let msg = typeof err === "string" ? err : (err as any)?.message || "Upload failed";
      if (msg.includes("signer") || msg.includes("nsec") || msg.includes("signing")) {
        msg = "no signing method configured — add your key in settings to upload";
      }
      setNoteUploadError(msg);
    } finally {
      setNoteUploading(false);
    }
  }, [content]);

  // Article mode: keyboard shortcuts for toolbar actions
  const handleArticleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    let action: ToolbarAction | null = null;
    if (e.key === "b") action = "bold";
    else if (e.key === "i") action = "italic";
    else if (e.key === "k") action = "link";
    if (action) {
      e.preventDefault();
      const ta = textareaRef.current;
      const start = ta?.selectionStart ?? content.length;
      const end = ta?.selectionEnd ?? content.length;
      const result = applyToolbarAction(content, start, end, action);
      setContent(result.newContent);
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus();
          ta.setSelectionRange(result.cursorStart, result.cursorEnd);
        }
      });
    }
  }, [content]);

  // Clear mention state when toggling preview
  const handleTogglePreview = useCallback(() => {
    setShowPreview(p => !p);
    setMentionQuery(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !mentionQuery) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, mentionQuery]);

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
          contentWarning: cwText.trim() || null,
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
  }, [mode, content, title, summary, imageUrl, hashtags, cwText, replyTo, signingMode, onClose, onPublished]);

  const handleRetry = () => {
    setErrorMsg("");
    setPhase("compose");
  };

  const canPublish = mode === "note"
    ? content.trim().length > 0
    : title.trim().length > 0 && content.trim().length > 0;

  return (
    <div className="wallet-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wallet-modal" style={{ width: mode === "article" ? 780 : 520 }}>
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
                    onClick={() => { setMode("note"); setShowPreview(false); }}
                  >note</button>
                  <button
                    className={`compose-mode-tab${mode === "article" ? " active" : ""}`}
                    onClick={() => setMode("article")}
                  >article</button>
                </div>
              )}

              {replyTo && (() => {
                // Kind 6 reposts store the original event as JSON in content
                let preview = replyTo.content;
                if (replyTo.kind === 6) {
                  try { preview = JSON.parse(replyTo.content)?.content ?? preview; } catch {}
                }
                return (
                  <div className="compose-reply-context">
                    <span className="compose-reply-author">
                      replying to {profileDisplayName(replyToProfile, replyTo.pubkey)}
                    </span>
                    <div className="compose-reply-preview">
                      {preview.slice(0, 120)}{preview.length > 120 ? "\u2026" : ""}
                    </div>
                  </div>
                );
              })()}

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

              {mode === "note" && (
                <div className="compose-cw-row">
                  <button
                    className={`compose-cw-toggle${cwText !== "" ? " active" : ""}`}
                    onClick={() => setCwText(cwText !== "" ? "" : "Sensitive content")}
                    title="content warning (NIP-36)"
                  >
                    <span className="icon"><IconAlertTriangle /></span>
                    CW
                  </button>
                  {cwText !== "" && (
                    <input
                      className="compose-field"
                      placeholder="Content warning reason..."
                      value={cwText}
                      onChange={(e) => setCwText(e.target.value)}
                      style={{ flex: 1 }}
                    />
                  )}
                </div>
              )}

              {/* Article: markdown toolbar */}
              {mode === "article" && !replyTo && (
                <MarkdownToolbar
                  textareaRef={textareaRef}
                  content={content}
                  onContentChange={setContent}
                  showPreview={showPreview}
                  onTogglePreview={handleTogglePreview}
                />
              )}

              {/* Content area: preview or editor */}
              {mode === "article" && showPreview ? (
                <div
                  className="compose-preview reader-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(content || "*nothing to preview*") }}
                />
              ) : (
                <div className="compose-editor-area" style={{ position: "relative" }}>
                  <textarea
                    ref={textareaRef}
                    className={`compose-textarea${mode === "article" ? " article-content" : ""}`}
                    placeholder={replyTo ? "Write your reply\u2026" : mode === "note" ? "What's on your mind?" : "Write your article content (markdown supported)\u2026"}
                    value={content}
                    onChange={handleContentChange}
                    onKeyDown={mode === "article" ? handleArticleKeyDown : undefined}
                    autoFocus
                  />
                  {mentionQuery !== null && (
                    <MentionAutocomplete
                      query={mentionQuery}
                      onSelect={handleMentionSelect}
                      onClose={() => setMentionQuery(null)}
                    />
                  )}
                </div>
              )}

              {mode === "article" && !replyTo && (
                <>
                  <ImageUploadField
                    label=""
                    value={imageUrl}
                    onChange={setImageUrl}
                    placeholder="Cover image URL (optional)"
                    inputClassName="compose-field image-upload-input"
                    labelClassName="compose-cover-upload"
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
            <div className="compose-footer-left">
              {mode === "note" && (
                <button
                  className="compose-img-btn"
                  onClick={handleNoteImageUpload}
                  disabled={noteUploading}
                  title="upload image"
                >
                  {noteUploading
                    ? <span className="image-upload-spinner" />
                    : <span className="icon"><IconImage /></span>
                  }
                </button>
              )}
              {noteUploadError && <span className="compose-upload-error">{noteUploadError}</span>}
            </div>
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
