import pc from "picocolors";
import { homedir } from "node:os";

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

export function tildeify(dir: string): string {
  const home = homedir();
  return dir === home
    ? "~"
    : dir.startsWith(home + "/")
      ? "~" + dir.slice(home.length)
      : dir;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function toolBadge(tool: string): string {
  switch (tool) {
    case "claude":
      return pc.magenta("claude  ");
    case "codex":
      return pc.cyan("codex   ");
    case "opencode":
      return pc.yellow("opencode");
    default:
      return tool.padEnd(8);
  }
}

export function dim(s: string): string {
  return pc.dim(s);
}

export function bold(s: string): string {
  return pc.bold(s);
}

/** Format token counts as 12.3k / 4.5M — for picker hints and previews. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, "") + "M";
}
