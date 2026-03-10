import { useState, useEffect } from "react";
import { getProfiles, type ProfileInfo } from "../utils/profiles";

export function useProfiles(pubkeys: string[]): Map<string, ProfileInfo> {
  const [profiles, setProfiles] = useState<Map<string, ProfileInfo>>(new Map());

  useEffect(() => {
    if (pubkeys.length === 0) return;
    let cancelled = false;
    getProfiles(pubkeys).then((map) => {
      if (!cancelled) setProfiles(new Map(map));
    });
    return () => {
      cancelled = true;
    };
    // Stringify pubkeys to stabilize dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkeys.join(",")]);

  return profiles;
}
