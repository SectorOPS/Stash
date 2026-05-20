import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Session } from "../types";

const CLAUDE_ROOT = join(homedir(), ".claude", "projects");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude encodes `/home/user/code/my-widget` as
 * `-home-user-code-my-widget`. The decode is ambiguous when any path segment
 * contains `-`, so we walk the real filesystem and pick the longest matching
 * child at each step.
 */
async function decodeProjectDir(encoded: string): Promise<string> {
  // Claude maps both "/" and "." to "-" in path component names, then joins
  // segments with "-". A naive `.split("-")` is therefore ambiguous: e.g.
  // "-home-user--cache-x" must decode to "/home/user/.cache/x". We walk the
  // real filesystem, choosing the longest matching child at each level. When
  // we see consecutive "-" we treat the second as encoding a "." prefix.
  if (!encoded.startsWith("-")) return encoded;
  const tokens = encoded.slice(1).split("-");
  const fallback = "/" + tokens.filter((t) => t !== "").join("/");
  const result = await walk("/", tokens, 0);
  return result ?? fallback;
}

async function walk(
  base: string,
  tokens: string[],
  i: number,
): Promise<string | null> {
  if (i >= tokens.length) return base;
  let children: Set<string>;
  try {
    children = new Set(await readdir(base));
  } catch {
    return null;
  }

  // Build candidate "next segment" strings by taking 1..N tokens from i,
  // joined with "-". We also try prefixing with "." if the encoding had a
  // "-" immediately before (empty token).
  // We always try longest first to prefer dashes-in-name over deeper splits.
  for (let take = tokens.length - i; take >= 1; take--) {
    const slice = tokens.slice(i, i + take);
    // Skip if the slice begins with an empty token (those are dot markers
    // handled below — slices starting with "" without a dot prefix would
    // produce a leading dash like "-cache", which is not a valid dir name).
    if (slice[0] === "") continue;
    // The string formed from these tokens, treating internal empties as
    // literal dashes. Trailing empties imply a "-" suffix which is unusual
    // but harmless; we just include them.
    const joined = slice.join("-");
    const variants = [joined];
    if (!joined.startsWith(".")) variants.push("." + joined);
    for (const cand of variants) {
      if (!children.has(cand)) continue;
      const next = join(base, cand);
      let nextI = i + take;
      // If the next token after our slice is empty, that empty token was a
      // dot-prefix marker for the segment AFTER it; consume the empty and
      // mark the following segment as starting with a dot. We do this by
      // not skipping the next token entirely — we let the recursive call
      // handle it via the "." + joined variant on its first iteration.
      const sub = await walk(next, tokens, nextI);
      if (sub) return sub;
    }
  }
  // Try consuming an empty token as a dot-prefix marker and forcing a "."
  // prefix on the next segment.
  if (tokens[i] === "") {
    for (let take = tokens.length - i - 1; take >= 1; take--) {
      const slice = tokens.slice(i + 1, i + 1 + take);
      if (slice.length === 0 || slice[0] === "") continue;
      const cand = "." + slice.join("-");
      if (children.has(cand)) {
        const next = join(base, cand);
        const sub = await walk(next, tokens, i + 1 + take);
        if (sub) return sub;
      }
    }
  }
  return null;
}

async function readRange(
  file: string,
  start: number,
  end: number,
): Promise<string> {
  const f = Bun.file(file);
  const clampedStart = Math.max(0, Math.min(f.size, start));
  const clampedEnd = Math.max(clampedStart, Math.min(f.size, end));
  if (clampedStart === clampedEnd) return "";
  return await f.slice(clampedStart, clampedEnd).text();
}

function findInLines(
  text: string,
  marker: string,
  type: string,
  field: string,
  pickLast: boolean,
): string | null {
  const lines = text.split("\n");
  // last-prompt is updated in place near the end of the file — pick the
  // latest occurrence. ai-title appears once and is stable.
  const range = pickLast ? lines.slice().reverse() : lines;
  for (const line of range) {
    if (!line.includes(marker)) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === type && typeof obj[field] === "string") {
        return obj[field];
      }
    } catch {}
  }
  return null;
}

async function extractTitle(file: string): Promise<string | null> {
  const f = Bun.file(file);
  const HEAD = 128 * 1024;
  const TAIL = 32 * 1024;

  // The ai-title line lands near the top of the file once claude has
  // generated a title, so the head window catches it cheaply.
  const head = await readRange(file, 0, HEAD);
  const aiTitle = findInLines(head, '"ai-title"', "ai-title", "aiTitle", false);
  if (aiTitle) return aiTitle;

  // The last-prompt line tracks the most recent user prompt and is appended
  // toward the end of the file, so look there too. Files smaller than HEAD
  // are already fully covered.
  let lastPrompt = findInLines(head, '"last-prompt"', "last-prompt", "lastPrompt", true);
  if (!lastPrompt && f.size > HEAD) {
    const tail = await readRange(file, f.size - TAIL, f.size);
    lastPrompt = findInLines(tail, '"last-prompt"', "last-prompt", "lastPrompt", true);
  }
  if (lastPrompt) {
    const cleaned = lastPrompt.replace(/\s+/g, " ").trim();
    return cleaned.length > 80 ? cleaned.slice(0, 79) + "…" : cleaned;
  }
  return null;
}

export async function discoverClaude(): Promise<Session[]> {
  if (!(await exists(CLAUDE_ROOT))) return [];
  const projectDirs = await readdir(CLAUDE_ROOT).catch(() => []);
  const sessions: Session[] = [];

  // When stash is invoked from inside an active Claude Code conversation,
  // that session's .jsonl is being written to live — listing it makes
  // deletes look like they don't take. The CLI exposes the active id via
  // CLAUDE_CODE_SESSION_ID, so we drop just that row from discovery.
  const activeId = process.env["CLAUDE_CODE_SESSION_ID"] ?? "";

  for (const enc of projectDirs) {
    const projectPath = join(CLAUDE_ROOT, enc);
    let st;
    try {
      st = await stat(projectPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const decoded = await decodeProjectDir(enc);

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    const jobs = files
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (file) => {
        const id = file.slice(0, -".jsonl".length);
        if (id === activeId) return null;
        const full = join(projectPath, file);
        let s;
        try {
          s = await stat(full);
        } catch {
          return null;
        }
        if (!s.isFile() || s.size === 0) return null;

        const title =
          (await extractTitle(full)) ?? `session ${id.slice(0, 8)}`;
        const session: Session = {
          tool: "claude",
          id,
          title,
          directory: decoded,
          updatedAt: s.mtimeMs,
        };
        return session;
      });

    const found = await Promise.all(jobs);
    for (const s of found) if (s) sessions.push(s);
  }
  return sessions;
}
