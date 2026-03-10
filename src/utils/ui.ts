/** Shared UI helpers used across screens */

export const AVATAR_CLASSES = ["av1", "av2", "av3", "av4", "av5", "av6", "av7"];

export function avatarClass(pubkey: string): string {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  return AVATAR_CLASSES[Math.abs(hash) % AVATAR_CLASSES.length];
}

export function kindLabel(kind: number): { tag: string; cls: string } {
  switch (kind) {
    case 1: return { tag: "note", cls: "ev-kind-note" };
    case 6: return { tag: "repost", cls: "ev-kind-repost" };
    case 30023: return { tag: "long-form", cls: "ev-kind-long" };
    default: return { tag: `k:${kind}`, cls: "ev-kind-note" };
  }
}
