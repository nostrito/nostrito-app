import React from "react";

interface BadgeProps {
  text: string;
  className: string;
  variant?: string;
  id?: string;
}

export const Badge: React.FC<BadgeProps> = ({ text, className, variant, id }) => {
  const cls = variant ? `${className} ${variant}` : className;
  return <span className={cls} id={id}>{text}</span>;
};
