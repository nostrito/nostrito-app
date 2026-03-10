/** Shared formatting utilities used across the app */

export function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

export function shortPubkey(pk: string): string {
  if (pk.length > 12) return pk.slice(0, 6) + "..." + pk.slice(-4);
  return pk;
}

export function timeAgo(ts: number, withSuffix = true): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  const suffix = withSuffix ? " ago" : "";
  if (diff < 60) return `${diff}s${suffix}`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m${suffix}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h${suffix}`;
  return `${Math.floor(diff / 86400)}d${suffix}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}
