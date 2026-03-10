import React, { createContext, useContext, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProfileInfo } from "../utils/profiles";

interface AppContextValue {
  isInitialized: boolean;
  ownProfile: ProfileInfo | null;
  appStatus: { relay_port: number; relay_running: boolean } | null;
  setInitialized: (v: boolean) => void;
  refreshOwnProfile: () => void;
}

const AppContext = createContext<AppContextValue>({
  isInitialized: false,
  ownProfile: null,
  appStatus: null,
  setInitialized: () => {},
  refreshOwnProfile: () => {},
});

export const useAppContext = () => useContext(AppContext);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isInitialized, setInitialized] = useState(false);
  const [ownProfile, setOwnProfile] = useState<ProfileInfo | null>(null);
  const [appStatus, setAppStatus] = useState<{ relay_port: number; relay_running: boolean } | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    invoke<{ initialized: boolean; relay_port: number; relay_running: boolean }>("get_status")
      .then((status) => {
        setInitialized(status.initialized);
        setAppStatus({ relay_port: status.relay_port, relay_running: status.relay_running });
        setChecked(true);
      })
      .catch(() => {
        const fallback = localStorage.getItem("nostrito_initialized") === "true";
        setInitialized(fallback);
        setChecked(true);
      });
  }, []);

  const refreshOwnProfile = () => {
    invoke<ProfileInfo | null>("get_own_profile")
      .then(setOwnProfile)
      .catch(() => {});
  };

  useEffect(() => {
    if (isInitialized) refreshOwnProfile();
  }, [isInitialized]);

  if (!checked) return null;

  return (
    <AppContext.Provider value={{ isInitialized, ownProfile, appStatus, setInitialized, refreshOwnProfile }}>
      {children}
    </AppContext.Provider>
  );
};
