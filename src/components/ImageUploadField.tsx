/** Reusable image URL field with Blossom upload button.
 *  Shows a text input for the URL + an upload button that opens a file picker,
 *  uploads to a Blossom server, and populates the URL field on success. */
import React, { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { IconUpload } from "./Icon";

interface ImageUploadFieldProps {
  label: string;
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
  /** Extra CSS class for the text input (e.g. "wiz-input wiz-input-sm" in wizard) */
  inputClassName?: string;
  /** Extra CSS class for the label wrapper */
  labelClassName?: string;
}

export const ImageUploadField: React.FC<ImageUploadFieldProps> = ({
  label, value, onChange, placeholder, inputClassName, labelClassName,
}) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = useCallback(async () => {
    setError(null);
    try {
      const filePath = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (!filePath || typeof filePath !== "string") return;

      setUploading(true);
      const url = await invoke<string>("upload_to_blossom", { filePath });
      onChange(url);
    } catch (err) {
      let msg = typeof err === "string" ? err : (err as any)?.message || "Upload failed";
      if (msg.includes("signer") || msg.includes("nsec") || msg.includes("signing")) {
        msg = "no signing method configured — add your key in settings to upload";
      }
      setError(msg);
      console.warn("[upload]", msg);
    } finally {
      setUploading(false);
    }
  }, [onChange]);

  return (
    <label className={labelClassName || "profile-edit-label"}>
      {label}
      <div className="image-upload-row">
        <input
          type="text"
          className={`${inputClassName || "profile-edit-input"} image-upload-input`}
          value={value}
          onChange={(e) => { setError(null); onChange(e.target.value); }}
          placeholder={placeholder || "https://..."}
        />
        <button
          type="button"
          className="image-upload-btn"
          onClick={handleUpload}
          disabled={uploading}
          title="upload image"
        >
          {uploading
            ? <span className="image-upload-spinner" />
            : <span className="icon"><IconUpload /></span>
          }
        </button>
      </div>
      {error && <span className="image-upload-error">{error}</span>}
    </label>
  );
};
