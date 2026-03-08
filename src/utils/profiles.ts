import { invoke } from "@tauri-apps/api/core";

export interface ProfileInfo {
  pubkey: string;
  name: string | null;
  display_name: string | null;
  picture: string | null;
  nip05: string | null;
  about: string | null;
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

export function profileDisplayName(profile: ProfileInfo | undefined, pubkey: string): string {
  if (profile) {
    if (profile.name) return profile.name;
    if (profile.display_name) return profile.display_name;
  }
  return shortPubkey(pubkey);
}

function shortPubkey(pk: string): string {
  if (pk.length > 12) return pk.slice(0, 6) + "..." + pk.slice(-4);
  return pk;
}
