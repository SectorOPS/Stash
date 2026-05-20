import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { Registry, RegisteredProject, Tool } from "./types";

const CONFIG_HOME =
  process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
export const REGISTRY_PATH = join(CONFIG_HOME, "stash", "registry.json");

const EMPTY: Registry = { version: 1, projects: [] };

function sanitize(entry: unknown): RegisteredProject | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e["name"] !== "string" || !e["name"]) return null;
  if (typeof e["dir"] !== "string" || !e["dir"]) return null;
  const tool = e["defaultTool"];
  if (tool !== "claude" && tool !== "codex" && tool !== "opencode") return null;
  return {
    name: e["name"],
    dir: e["dir"],
    defaultTool: tool,
    skipPermissions: Boolean(e["skipPermissions"]),
    newWindow: e["newWindow"] === undefined ? true : Boolean(e["newWindow"]),
    lastSessionId:
      typeof e["lastSessionId"] === "string" ? e["lastSessionId"] : undefined,
    lastTool:
      e["lastTool"] === "claude" ||
      e["lastTool"] === "codex" ||
      e["lastTool"] === "opencode"
        ? e["lastTool"]
        : undefined,
    addedAt:
      typeof e["addedAt"] === "string" ? e["addedAt"] : new Date().toISOString(),
    updatedAt:
      typeof e["updatedAt"] === "string"
        ? e["updatedAt"]
        : new Date().toISOString(),
  };
}

export async function loadRegistry(): Promise<Registry> {
  const file = Bun.file(REGISTRY_PATH);
  if (!(await file.exists())) return structuredClone(EMPTY);
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as Partial<Registry>;
    const raw = Array.isArray(parsed.projects) ? parsed.projects : [];
    const projects: RegisteredProject[] = [];
    for (const item of raw) {
      const ok = sanitize(item);
      if (ok) projects.push(ok);
    }
    return { version: 1, projects };
  } catch (err) {
    console.error(`stash: registry at ${REGISTRY_PATH} is unreadable.`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

export async function saveRegistry(reg: Registry): Promise<void> {
  if (!existsSync(dirname(REGISTRY_PATH))) {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  }
  await Bun.write(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

export function findByName(
  reg: Registry,
  name: string,
): RegisteredProject | null {
  const lower = name.toLowerCase();
  return (
    reg.projects.find((p) => p.name.toLowerCase() === lower) ??
    reg.projects.find((p) => p.name.toLowerCase().startsWith(lower)) ??
    null
  );
}

export function findByDir(
  reg: Registry,
  dir: string,
): RegisteredProject | null {
  return reg.projects.find((p) => p.dir === dir) ?? null;
}

export function upsertProject(
  reg: Registry,
  project: Omit<RegisteredProject, "addedAt" | "updatedAt"> &
    Partial<Pick<RegisteredProject, "addedAt" | "updatedAt">>,
): RegisteredProject {
  const now = new Date().toISOString();
  const existingIdx = reg.projects.findIndex((p) => p.dir === project.dir);
  if (existingIdx >= 0) {
    const merged: RegisteredProject = {
      ...reg.projects[existingIdx]!,
      ...project,
      updatedAt: now,
    };
    reg.projects[existingIdx] = merged;
    return merged;
  }
  const created: RegisteredProject = {
    addedAt: now,
    updatedAt: now,
    ...project,
  };
  reg.projects.push(created);
  return created;
}

export function removeProject(reg: Registry, name: string): boolean {
  const idx = reg.projects.findIndex(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (idx < 0) return false;
  reg.projects.splice(idx, 1);
  return true;
}

export function recordLastSession(
  reg: Registry,
  dir: string,
  tool: Tool,
  sessionId: string | null,
): void {
  const proj = findByDir(reg, dir);
  if (!proj) return;
  proj.lastTool = tool;
  if (sessionId) proj.lastSessionId = sessionId;
  proj.updatedAt = new Date().toISOString();
}
