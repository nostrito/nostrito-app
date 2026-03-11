/** ProfileProvider — batched, cached profile loading via React context */
import React, { createContext, useContext, useCallback, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProfileInfo } from "../utils/profiles";

interface ProfileContextValue {
  getProfile: (pubkey: string) => ProfileInfo | undefined;
  ensureProfiles: (pubkeys: string[]) => void;
  profileVersion: number;
}

const ProfileContext = createContext<ProfileContextValue>({
  getProfile: () => undefined,
  ensureProfiles: () => {},
  profileVersion: 0,
});

export const useProfileContext = () => useContext(ProfileContext);

/** Hook to get a single profile reactively */
export function useProfile(pubkey: string | undefined): ProfileInfo | undefined {
  const ctx = useProfileContext();
  useEffect(() => {
    if (pubkey) ctx.ensureProfiles([pubkey]);
  }, [pubkey, ctx]);
  // Reading profileVersion subscribes this component to cache updates
  void ctx.profileVersion;
  return pubkey ? ctx.getProfile(pubkey) : undefined;
}

/** Hook to get multiple profiles reactively */
export function useProfiles(pubkeys: string[]): Map<string, ProfileInfo> {
  const ctx = useProfileContext();
  useEffect(() => {
    if (pubkeys.length > 0) ctx.ensureProfiles(pubkeys);
  }, [pubkeys, ctx]);
  void ctx.profileVersion;

  const map = new Map<string, ProfileInfo>();
  for (const pk of pubkeys) {
    const p = ctx.getProfile(pk);
    if (p) map.set(pk, p);
  }
  return map;
}

const BATCH_DELAY_MS = 50;

export const ProfileProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const cacheRef = useRef(new Map<string, ProfileInfo>());
  const pendingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileVersion, setProfileVersion] = useState(0);

  const flush = useCallback(async () => {
    timerRef.current = null;
    const batch = [...pendingRef.current];
    pendingRef.current.clear();

    // Filter out already-cached
    const missing = batch.filter((pk) => !cacheRef.current.has(pk));
    if (missing.length === 0) return;

    try {
      const profiles = await invoke<ProfileInfo[]>("get_profiles", { pubkeys: missing });
      for (const p of profiles) {
        cacheRef.current.set(p.pubkey, p);
      }
      // Mark missing pubkeys with no profile so we don't re-fetch
      for (const pk of missing) {
        if (!cacheRef.current.has(pk)) {
          cacheRef.current.set(pk, {
            pubkey: pk,
            name: null,
            display_name: null,
            picture: null,
            nip05: null,
            about: null,
            banner: null,
            website: null,
            lud16: null,
          });
        }
      }
      setProfileVersion((v) => v + 1);
    } catch (e) {
      console.warn("[ProfileProvider] batch fetch failed:", e);
    }
  }, []);

  const ensureProfiles = useCallback(
    (pubkeys: string[]) => {
      let added = false;
      for (const pk of pubkeys) {
        if (!cacheRef.current.has(pk) && !pendingRef.current.has(pk)) {
          pendingRef.current.add(pk);
          added = true;
        }
      }
      if (added && !timerRef.current) {
        timerRef.current = setTimeout(flush, BATCH_DELAY_MS);
      }
    },
    [flush],
  );

  const getProfile = useCallback((pubkey: string): ProfileInfo | undefined => {
    return cacheRef.current.get(pubkey) ?? undefined;
  }, []);

  // Listen for profile-updated events from backend
  useEffect(() => {
    const unlisten = listen<string>("profile-updated", (event) => {
      const pk = event.payload;
      // Invalidate and re-fetch
      cacheRef.current.delete(pk);
      pendingRef.current.add(pk);
      if (!timerRef.current) {
        timerRef.current = setTimeout(flush, BATCH_DELAY_MS);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [flush]);

  return (
    <ProfileContext.Provider value={{ getProfile, ensureProfiles, profileVersion }}>
      {children}
    </ProfileContext.Provider>
  );
};
