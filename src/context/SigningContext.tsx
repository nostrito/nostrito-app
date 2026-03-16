/** SigningProvider — tracks whether user has write capability (nsec or bunker) */
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface SigningContextValue {
  /** true when user has nsec/bunker and can sign events */
  canWrite: boolean;
  /** Current mode string: "nsec" | "read-only" */
  signingMode: string;
  /** Force re-check (e.g. after settings change) */
  refresh: () => void;
}

const SigningContext = createContext<SigningContextValue>({
  canWrite: false,
  signingMode: "read-only",
  refresh: () => {},
});

export const useSigningContext = () => useContext(SigningContext);

/** Convenience hook — returns true when user can sign events */
export function useCanWrite(): boolean {
  return useSigningContext().canWrite;
}

export const SigningProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [signingMode, setSigningMode] = useState("read-only");

  const refresh = useCallback(async () => {
    try {
      const mode = await invoke<string>("get_signing_mode");
      setSigningMode(mode);
    } catch {
      setSigningMode("read-only");
    }
  }, []);

  // Check on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for backend event when signing mode changes
  useEffect(() => {
    const unlisten = listen<string>("signing-mode-changed", (event) => {
      setSigningMode(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const canWrite = signingMode === "nsec";

  return (
    <SigningContext.Provider value={{ canWrite, signingMode, refresh }}>
      {children}
    </SigningContext.Provider>
  );
};
