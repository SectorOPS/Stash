import { homedir } from "node:os";
import { join } from "node:path";
import { unlink, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Session, Tool } from "./types";

export interface DeleteResult {
  session: Session;
  ok: boolean;
  error?: string;
}

/**
 * Permanently delete the on-disk artifacts for a session across each tool.
 * Returns one result per requested session so the caller can report success
 * and surface any failures.
 */
export async function deleteSessions(
  sessions: Session[],
): Promise<DeleteResult[]> {
  const results: DeleteResult[] = [];
  for (const s of sessions) {
    try {
      switch (s.tool) {
        case "claude":
          await deleteClaude(s);
          break;
        case "codex":
          await deleteCodex(s);
          break;
        case "opencode":
          await deleteOpencode(s);
          break;
      }
      results.push({ session: s, ok: true });
    } catch (err) {
      results.push({
        session: s,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function deleteClaude(s: Session): Promise<void> {
  // Encoded project dir = path with "/" and "." both replaced by "-".
  const encoded = "-" + s.directory.replace(/^\//, "").replaceAll("/", "-").replaceAll(".", "-");
  const candidate = join(homedir(), ".claude", "projects", encoded, `${s.id}.jsonl`);
  if (existsSync(candidate)) {
    await unlink(candidate);
    return;
  }
  // Fallback: walk every project dir and look for a file with this id.
  // Handles cases where the project dir name has dashes/dots that didn't
  // round-trip cleanly through the encoding.
  const root = join(homedir(), ".claude", "projects");
  const projectDirs = await readdir(root).catch(() => []);
  for (const enc of projectDirs) {
    const full = join(root, enc, `${s.id}.jsonl`);
    if (existsSync(full)) {
      await unlink(full);
      return;
    }
  }
  throw new Error(`claude session file for ${s.id} not found`);
}

async function deleteCodex(s: Session): Promise<void> {
  const sessionsRoot = join(homedir(), ".codex", "sessions");
  const indexFile = join(homedir(), ".codex", "session_index.jsonl");

  // Walk YYYY/MM/DD to find the rollout-*-<id>.jsonl file.
  const found = await findCodexFile(sessionsRoot, s.id);
  if (!found) {
    throw new Error(`codex rollout file for ${s.id} not found`);
  }
  await unlink(found);

  // Strip the entry from the index (best effort — corrupt entries are
  // skipped silently, matching the read path).
  if (existsSync(indexFile)) {
    const text = await Bun.file(indexFile).text().catch(() => "");
    const keep: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.id === s.id) continue;
        keep.push(line);
      } catch {
        keep.push(line); // preserve malformed lines verbatim
      }
    }
    await Bun.write(indexFile, keep.join("\n") + (keep.length ? "\n" : ""));
  }
}

async function findCodexFile(
  root: string,
  id: string,
): Promise<string | null> {
  if (!existsSync(root)) return null;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        queue.push(full);
      } else if (st.isFile() && entry.endsWith(`-${id}.jsonl`)) {
        return full;
      }
    }
  }
  return null;
}

async function deleteOpencode(s: Session): Promise<void> {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) throw new Error("opencode database not found");
  const db = new Database(dbPath);
  try {
    const info = db
      .query<unknown, [string]>(`DELETE FROM session WHERE id = ?`)
      .run(s.id);
    if (info.changes === 0) {
      throw new Error(`opencode session ${s.id} not found in database`);
    }
  } finally {
    db.close();
  }
}

export function findDuplicateSessions(sessions: Session[]): Session[][] {
  // Group sessions whose normalised titles match within the same tool. Useful
  // for surfacing "delete duplicates" candidates.
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = `${s.tool}:${normalize(s.title)}`;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const dups: Session[][] = [];
  for (const arr of groups.values()) {
    if (arr.length > 1) {
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
      dups.push(arr);
    }
  }
  return dups;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function tool(s: Session): Tool {
  return s.tool;
}
