import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Session } from "../types";

const CODEX_ROOT = join(homedir(), ".codex");
const SESSIONS_ROOT = join(CODEX_ROOT, "sessions");
const INDEX_FILE = join(CODEX_ROOT, "session_index.jsonl");

interface IndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readIndex(): Promise<Map<string, IndexEntry>> {
  const map = new Map<string, IndexEntry>();
  if (!(await exists(INDEX_FILE))) return map;
  const text = await Bun.file(INDEX_FILE).text().catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as IndexEntry;
      if (obj.id) map.set(obj.id, obj);
    } catch {
      // ignore malformed lines
    }
  }
  return map;
}

async function* walkSessionFiles(
  dir: string,
): AsyncGenerator<{ path: string; mtimeMs: number }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walkSessionFiles(full);
    } else if (s.isFile() && entry.endsWith(".jsonl")) {
      yield { path: full, mtimeMs: s.mtimeMs };
    }
  }
}

function parseRolloutFilename(name: string): { id: string } | null {
  // rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000000.jsonl
  // The last 5 dash-separated tokens before .jsonl form the UUID.
  const base = name.endsWith(".jsonl") ? name.slice(0, -6) : name;
  const parts = base.split("-");
  if (parts.length < 5) return null;
  const uuid = parts.slice(-5).join("-");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    uuid,
  )) {
    return null;
  }
  return { id: uuid };
}

async function readSessionMeta(
  file: string,
): Promise<{ cwd: string | null; threadName: string | null }> {
  // session_meta is the first line of every rollout file. We only need the
  // first chunk.
  const f = Bun.file(file);
  const slice = f.slice(0, Math.min(f.size, 32 * 1024));
  const text = await slice.text();
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (!firstLine) return { cwd: null, threadName: null };
  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type === "session_meta" && obj.payload) {
      return {
        cwd: typeof obj.payload.cwd === "string" ? obj.payload.cwd : null,
        threadName:
          typeof obj.payload.thread_name === "string"
            ? obj.payload.thread_name
            : null,
      };
    }
  } catch {
    // ignore
  }
  return { cwd: null, threadName: null };
}

export async function discoverCodex(): Promise<Session[]> {
  if (!(await exists(SESSIONS_ROOT))) return [];

  const index = await readIndex();
  const sessions: Session[] = [];

  // Collect rollout files (with mtime). Reading session_meta from every file
  // is the expensive part, so run them in parallel.
  const found: { path: string; mtimeMs: number; id: string }[] = [];
  for await (const { path, mtimeMs } of walkSessionFiles(SESSIONS_ROOT)) {
    const name = path.split("/").pop()!;
    const parsed = parseRolloutFilename(name);
    if (!parsed) continue;
    found.push({ path, mtimeMs, id: parsed.id });
  }

  const results = await Promise.all(
    found.map(async (f) => {
      const meta = await readSessionMeta(f.path);
      const idx = index.get(f.id);
      const title =
        idx?.thread_name?.trim() ||
        meta.threadName?.trim() ||
        `session ${f.id.slice(0, 8)}`;
      const dir = meta.cwd;
      if (!dir) return null;
      const updatedAt = idx?.updated_at
        ? Date.parse(idx.updated_at)
        : f.mtimeMs;
      const session: Session = {
        tool: "codex",
        id: f.id,
        title,
        directory: dir,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : f.mtimeMs,
      };
      return session;
    }),
  );

  for (const s of results) if (s) sessions.push(s);
  return sessions;
}
