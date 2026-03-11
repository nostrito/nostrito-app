import { invoke } from "@tauri-apps/api/core";
import { shortPubkey } from "./format";

export interface ProfileInfo {
  pubkey: string;
  name: string | null;
  display_name: string | null;
  picture: string | null;
  nip05: string | null;
  about: string | null;
  banner: string | null;
  website: string | null;
  lud16: string | null;
}

const profileCache = new Map<string, ProfileInfo>();

export async function getProfiles(pubkeys: string[]): Promise<Map<string, ProfileInfo>> {
  const unique = [...new Set(pubkeys)];
  const missing = unique.filter((pk) => !profileCache.has(pk));
  if (missing.length > 0) {
    try {
      const profiles = await invoke<ProfileInfo[]>("get_profiles", { pubkeys: missing });
      profiles.forEach((p) => profileCache.set(p.pubkey, p));
    } catch (e) {
      console.warn("[profiles] Failed to fetch profiles:", e);
    }
  }
  return profileCache;
}

export function getCachedProfile(pubkey: string): ProfileInfo | undefined {
  return profileCache.get(pubkey);
}

/** Invalidate cached profile so the next getProfiles call re-fetches from DB */
export function invalidateProfileCache(pubkey: string): void {
  profileCache.delete(pubkey);
}

export function profileDisplayName(profile: ProfileInfo | undefined, pubkey: string): string {
  if (profile) {
    if (profile.name) return profile.name;
    if (profile.display_name) return profile.display_name;
  }
  return shortPubkey(pubkey);
}

