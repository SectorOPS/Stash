import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import type { ProjectGroup } from "./types";

const HOME = homedir();

/** Path prefixes that we always treat as clutter when a session is recorded
 *  with that directory as `cwd`. Most of these are caches / runtime data
 *  dirs that the AI CLIs were almost certainly invoked from by accident. */
const CLUTTER_PREFIXES: string[] = [
  `${HOME}/.cache`,
  `${HOME}/.config`,
  `${HOME}/.local`,
  `${HOME}/Library`,
  `${HOME}/Downloads`,
  `${HOME}/.npm`,
  `${HOME}/.yarn`,
  `${HOME}/.pnpm`,
  `${HOME}/.bun`,
  `${HOME}/.deno`,
  `${HOME}/.cargo`,
  `${HOME}/.rustup`,
  `${HOME}/.gem`,
  `${HOME}/.docker`,
  `${HOME}/.codex`,
  `${HOME}/.claude`,
  `${HOME}/.opencode`,
  `${HOME}/.vscode`,
  `${HOME}/.cursor`,
  `${HOME}/.zsh_sessions`,
  `${HOME}/.Trash`,
  `${HOME}/.lmstudio`,
  `${HOME}/test`,
  `${HOME}/tmp`,
  "/tmp",
  "/var",
  "/private/tmp",
  "/private/var",
];

/** Exact paths that are clutter. `$HOME` itself is the big one — claude
 *  shouldn't have a "project" rooted at your entire home dir. */
const CLUTTER_EXACT = new Set([HOME, "/", ""]);

export function isClutterDir(dir: string): boolean {
  if (CLUTTER_EXACT.has(dir)) return true;
  for (const prefix of CLUTTER_PREFIXES) {
    if (dir === prefix) return true;
    if (dir.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Return the subset of `groups` that should be hidden from the picker by
 * default. Registered projects are *always* kept visible — the user has
 * explicitly opted them in.
 */
export function clutterGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.filter(
    (g) => !g.registered && isClutterDir(g.directory),
  );
}

/** Inverse of clutterGroups — what we keep visible. */
export function visibleGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.filter(
    (g) => g.registered || !isClutterDir(g.directory),
  );
}

/** Groups whose project directory no longer exists on disk. Used by the
 *  Sweep flow as a second axis of "clearly stale". */
export function missingDirGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.filter((g) => {
    if (g.registered) return false;
    try {
      return !statSync(g.directory).isDirectory();
    } catch {
      return true;
    }
  });
}

/** What the Sweep Clutter action would purge: union of clutter + missing
 *  dirs, deduped by directory. */
export function sweepable(groups: ProjectGroup[]): ProjectGroup[] {
  const seen = new Set<string>();
  const out: ProjectGroup[] = [];
  for (const g of [...clutterGroups(groups), ...missingDirGroups(groups)]) {
    if (seen.has(g.directory)) continue;
    seen.add(g.directory);
    out.push(g);
  }
  return out;
}

/** Tag explaining *why* a group qualifies as sweepable. Surfaced in the
 *  preview shown before the user confirms a sweep. */
export function clutterReason(g: ProjectGroup): string {
  if (isClutterDir(g.directory)) return "system/cache path";
  if (!existsSync(g.directory)) return "directory no longer exists";
  return "stale";
}
