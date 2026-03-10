import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface TitlebarProps {
  title: string;
}

export const Titlebar: React.FC<TitlebarProps> = ({ title }) => {
  const close = () => getCurrentWindow().close();
  const minimize = () => getCurrentWindow().minimize();
  const maximize = () => getCurrentWindow().toggleMaximize();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-buttons">
        <button className="tb-btn tb-close" onClick={close} title="Close" />
        <button className="tb-btn tb-minimize" onClick={minimize} title="Minimize" />
        <button className="tb-btn tb-maximize" onClick={maximize} title="Maximize" />
      </div>
      <div className="titlebar-title">{title}</div>
      <div style={{ width: 52 }} />
    </div>
  );
};
