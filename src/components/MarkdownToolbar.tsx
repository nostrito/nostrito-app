import React, { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  IconBold, IconItalic, IconHeading, IconLink, IconQuote,
  IconCode, IconList, IconListOrdered, IconMinus,
  IconImage, IconEye, IconEyeOff,
} from "./Icon";
import { applyToolbarAction, type ToolbarAction } from "../utils/markdownToolbar";

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  onContentChange: (newContent: string) => void;
  showPreview: boolean;
  onTogglePreview: () => void;
}

const BUTTONS: { action: ToolbarAction; Icon: React.FC; title: string }[] = [
  { action: "bold",      Icon: IconBold,        title: "Bold (Ctrl+B)" },
  { action: "italic",    Icon: IconItalic,      title: "Italic (Ctrl+I)" },
  { action: "heading",   Icon: IconHeading,     title: "Heading" },
  { action: "link",      Icon: IconLink,        title: "Link (Ctrl+K)" },
  { action: "quote",     Icon: IconQuote,       title: "Blockquote" },
  { action: "code",      Icon: IconCode,        title: "Code" },
  { action: "ul",        Icon: IconList,        title: "Bullet list" },
  { action: "ol",        Icon: IconListOrdered,  title: "Numbered list" },
  { action: "hr",        Icon: IconMinus,       title: "Horizontal rule" },
];

export const MarkdownToolbar: React.FC<MarkdownToolbarProps> = ({
  textareaRef, content, onContentChange, showPreview, onTogglePreview,
}) => {
  const [uploading, setUploading] = useState(false);

  const handleAction = useCallback((action: ToolbarAction, imageUrl?: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? content.length;
    const end = ta?.selectionEnd ?? content.length;
    const result = applyToolbarAction(content, start, end, action, imageUrl);
    onContentChange(result.newContent);
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(result.cursorStart, result.cursorEnd);
      }
    });
  }, [textareaRef, content, onContentChange]);

  const handleImageUpload = useCallback(async () => {
    try {
      const filePath = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (!filePath || typeof filePath !== "string") return;
      setUploading(true);
      const url = await invoke<string>("upload_to_blossom", { filePath });
      handleAction("image", url);
    } catch (err) {
      console.warn("[toolbar-upload]", err);
    } finally {
      setUploading(false);
    }
  }, [handleAction]);

  return (
    <div className="md-toolbar">
      {BUTTONS.map(({ action, Icon, title }) => (
        <button
          key={action}
          type="button"
          className="md-toolbar-btn"
          title={title}
          onClick={() => handleAction(action)}
          disabled={showPreview}
        >
          <span className="icon"><Icon /></span>
        </button>
      ))}
      <span className="md-toolbar-separator" />
      <button
        type="button"
        className="md-toolbar-btn"
        title="Insert image"
        onClick={handleImageUpload}
        disabled={uploading || showPreview}
      >
        {uploading
          ? <span className="image-upload-spinner" />
          : <span className="icon"><IconImage /></span>
        }
      </button>
      <span className="md-toolbar-spacer" />
      <button
        type="button"
        className={`md-toolbar-btn${showPreview ? " preview-active" : ""}`}
        title={showPreview ? "Edit" : "Preview"}
        onClick={onTogglePreview}
      >
        <span className="icon">{showPreview ? <IconEyeOff /> : <IconEye />}</span>
      </button>
    </div>
  );
};
