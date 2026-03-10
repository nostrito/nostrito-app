import React, { useState } from "react";
import { avatarClass } from "../utils/ui";

interface AvatarProps {
  picture?: string | null;
  pubkey: string;
  className: string;
  fallbackClassName?: string;
  clickable?: boolean;
}

export const Avatar: React.FC<AvatarProps> = ({ picture, pubkey, className, fallbackClassName, clickable }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const initial = pubkey.charAt(0).toUpperCase();
  const fbClass = fallbackClassName ?? `${className}-fallback`;
  const colorClass = avatarClass(pubkey);
  const clickAttrs = clickable ? { "data-pubkey": pubkey, style: { cursor: "pointer" } as React.CSSProperties } : {};

  if (!picture || imgFailed) {
    return <div className={`${className} ${fbClass} ${colorClass}`} {...clickAttrs}>{initial}</div>;
  }

  return (
    <>
      <img
        src={picture}
        className={className}
        onError={() => setImgFailed(true)}
        {...clickAttrs}
      />
    </>
  );
};
