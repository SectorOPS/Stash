import { basename } from "node:path";
import { discoverClaude } from "./claude";
import { discoverCodex } from "./codex";
import { discoverOpencode } from "./opencode";
import { visibleGroups, clutterGroups } from "../clutter";
import type {
  ProjectGroup,
  RegisteredProject,
  Session,
} from "../types";

export interface DiscoveredState {
  sessions: Session[];
  /** Visible to the user (clutter + missing dirs filtered out). */
  groups: ProjectGroup[];
  /** Everything we found, before filtering — needed for the Sweep action. */
  allGroups: ProjectGroup[];
  /** Just the clutter portion. */
  hiddenGroups: ProjectGroup[];
}

export async function discoverAll(
  registered: RegisteredProject[],
): Promise<DiscoveredState> {
  const [a, b, c] = await Promise.all([
    discoverClaude(),
    discoverCodex(),
    discoverOpencode(),
  ]);
  const sessions = [...a, ...b, ...c];

  const byDir = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = normalizeDir(s.directory);
    const arr = byDir.get(key);
    if (arr) arr.push(s);
    else byDir.set(key, [s]);
  }

  // Make sure every registered project shows up even if it has no sessions.
  for (const p of registered) {
    const key = normalizeDir(p.dir);
    if (!byDir.has(key)) byDir.set(key, []);
  }

  const regByDir = new Map<string, RegisteredProject>();
  for (const p of registered) regByDir.set(normalizeDir(p.dir), p);

  const groups: ProjectGroup[] = [];
  for (const [dir, items] of byDir) {
    items.sort((x, y) => y.updatedAt - x.updatedAt);
    const reg = regByDir.get(dir) ?? null;
    const latest = items[0]?.updatedAt ?? 0;
    groups.push({
      directory: dir,
      displayName: reg?.name ?? (basename(dir) || dir),
      sessions: items,
      registered: reg,
      latest: Math.max(
        latest,
        reg ? Date.parse(reg.updatedAt) || 0 : 0,
      ),
    });
  }

  groups.sort((a, b) => b.latest - a.latest);
  const visible = visibleGroups(groups);
  const hidden = clutterGroups(groups);
  return {
    sessions,
    groups: visible,
    allGroups: groups,
    hiddenGroups: hidden,
  };
}

function normalizeDir(dir: string): string {
  if (!dir) return dir;
  // Trim trailing slash, except for root.
  if (dir.length > 1 && dir.endsWith("/")) return dir.slice(0, -1);
  return dir;
}
