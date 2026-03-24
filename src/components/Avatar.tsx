import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { avatarClass } from "../utils/ui";

interface AvatarProps {
  picture?: string | null;
  pictureLocal?: string | null;
  pubkey: string;
  className: string;
  fallbackClassName?: string;
  clickable?: boolean;
}

export const Avatar: React.FC<AvatarProps> = ({ picture, pictureLocal, pubkey, className, fallbackClassName, clickable }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const initial = pubkey.charAt(0).toUpperCase();
  const fbClass = fallbackClassName ?? `${className}-fallback`;
  const colorClass = avatarClass(pubkey);
  const clickAttrs = clickable ? { "data-pubkey": pubkey, style: { cursor: "pointer" } as React.CSSProperties } : {};

  const src = pictureLocal ? convertFileSrc(pictureLocal) : picture;

  if (!src || imgFailed) {
    return <div className={`${className} ${fbClass} ${colorClass}`} {...clickAttrs}>{initial}</div>;
  }

  return (
    <>
      <img
        src={src}
        className={className}
        onError={() => setImgFailed(true)}
        {...clickAttrs}
      />
    </>
  );
};
