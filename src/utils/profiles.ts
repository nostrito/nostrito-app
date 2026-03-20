import { shortPubkey } from "./format";

export interface ProfileInfo {
  pubkey: string;
  name: string | null;
  display_name: string | null;
  picture: string | null;
  picture_local: string | null;
  nip05: string | null;
  about: string | null;
  banner: string | null;
  website: string | null;
  lud16: string | null;
}

export function profileDisplayName(profile: ProfileInfo | undefined, pubkey: string): string {
  if (profile) {
    if (profile.name) return profile.name;
    if (profile.display_name) return profile.display_name;
  }
  return shortPubkey(pubkey);
}
