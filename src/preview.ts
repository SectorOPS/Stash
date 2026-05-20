import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Session } from "./types";

export interface SessionPreview {
  lastUser: string | null;
  lastAssistant: string | null;
  /** approximate total messages in the session (cheap counts only) */
  messageCount: number | null;
  /** input + output tokens summed across the session, when the tool records
   *  them in its own metadata. Null when not exposed. */
  totalTokens: number | null;
}

const EMPTY: SessionPreview = {
  lastUser: null,
  lastAssistant: null,
  messageCount: null,
  totalTokens: null,
};

export async function previewSession(s: Session): Promise<SessionPreview> {
  try {
    switch (s.tool) {
      case "claude":
        return await previewClaude(s);
      case "codex":
        return await previewCodex(s);
      case "opencode":
        return await previewOpencode(s);
    }
  } catch {
    return EMPTY;
  }
}

/** Trim long messages for inline display in a `note` block. */
export function shortenForPreview(text: string, maxLines = 4, maxChars = 320): string {
  const cleaned = text.replace(/\r/g, "").trim();
  const lines = cleaned.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  if (lines.length > maxLines) out += "\n…";
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
  return out;
}

/* ─────────────────────────────────  claude  ───────────────────────────────── */

async function previewClaude(s: Session): Promise<SessionPreview> {
  const root = join(homedir(), ".claude", "projects");
  const file = await locateClaudeJsonl(root, s.id);
  if (!file) return EMPTY;

  // Full file read — Claude sessions max out at a few MB, and we need to
  // touch every line anyway to sum usage tokens accurately.
  const text = await Bun.file(file).text();
  const lines = text.split("\n");

  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  let count = 0;
  let tokens = 0;

  // Walk the whole file once to count messages and sum tokens.
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"type":"user"') && !line.includes('"isMeta":true')) {
      count++;
    } else if (line.includes('"type":"assistant"')) {
      count++;
      // The token tally only needs to touch assistant lines; parse those.
      try {
        const o = JSON.parse(line);
        const usage = o?.message?.usage;
        if (usage && typeof usage.output_tokens === "number") {
          tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        }
      } catch {
        // skip malformed
      }
    }
  }

  // Walk backwards for the last user / last assistant text content.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastUser && lastAssistant) break;
    const line = lines[i];
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o?.type === "user" && !o.isMeta && !lastUser) {
        const t = extractClaudeText(o.message);
        if (t && !looksLikeMeta(t)) lastUser = t;
      } else if (o?.type === "assistant" && !lastAssistant) {
        const t = extractClaudeText(o.message);
        if (t) lastAssistant = t;
      }
    } catch {
      // ignore malformed
    }
  }

  return {
    lastUser,
    lastAssistant,
    messageCount: count || null,
    totalTokens: tokens > 0 ? tokens : null,
  };
}

function extractClaudeText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { content?: unknown };
  const c = m.content;
  if (typeof c === "string") return c.trim() || null;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined || null;
  }
  return null;
}

function looksLikeMeta(text: string): boolean {
  return (
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command") ||
    text.startsWith("<system-reminder")
  );
}

async function locateClaudeJsonl(root: string, id: string): Promise<string | null> {
  if (!existsSync(root)) return null;
  const dirs = await readdir(root).catch(() => []);
  for (const d of dirs) {
    const full = join(root, d, `${id}.jsonl`);
    if (existsSync(full)) return full;
  }
  return null;
}

/* ─────────────────────────────────  codex  ───────────────────────────────── */

async function previewCodex(s: Session): Promise<SessionPreview> {
  const root = join(homedir(), ".codex", "sessions");
  const file = await locateCodexRollout(root, s.id);
  if (!file) return EMPTY;

  const text = await Bun.file(file).text();
  const lines = text.split("\n");

  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  let count = 0;
  let tokens = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o?.type !== "response_item") continue;
      const p = o.payload;
      if (!p || p.type !== "message") continue;
      const text = extractCodexText(p.content);
      if (!text) continue;
      if (p.role === "user" && !lastUser && !looksLikeMeta(text)) lastUser = text;
      else if (p.role === "assistant" && !lastAssistant) lastAssistant = text;
      if (lastUser && lastAssistant) break;
    } catch {
      // ignore malformed
    }
  }

  // Forward pass for the count.
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"type":"response_item"') && line.includes('"type":"message"')) {
      count++;
    }
  }

  return {
    lastUser,
    lastAssistant,
    messageCount: count || null,
    totalTokens: tokens > 0 ? tokens : null,
  };
}

function extractCodexText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if ((it.type === "input_text" || it.type === "output_text" || it.type === "text") &&
            typeof it.text === "string") {
          parts.push(it.text);
        }
      }
    }
    const joined = parts.join("\n").trim();
    return joined || null;
  }
  return null;
}

async function locateCodexRollout(root: string, id: string): Promise<string | null> {
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
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) queue.push(full);
      else if (s.isFile() && entry.endsWith(`-${id}.jsonl`)) return full;
    }
  }
  return null;
}

/* ─────────────────────────────────  opencode  ──────────────────────────────── */

async function previewOpencode(s: Session): Promise<SessionPreview> {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return EMPTY;

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return EMPTY;
  }

  try {
    interface MsgRow {
      id: string;
      data: string;
    }
    interface PartRow {
      message_id: string;
      data: string;
    }

    const msgs = db
      .query<MsgRow, [string]>(
        `SELECT id, data FROM message
         WHERE session_id = ?
         ORDER BY time_created DESC
         LIMIT 50`,
      )
      .all(s.id);

    if (msgs.length === 0) return EMPTY;

    // Build per-message text by concatenating "text"-type parts.
    const ids = msgs.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const parts = db
      .query<PartRow, string[]>(
        `SELECT message_id, data FROM part
         WHERE message_id IN (${placeholders})
         ORDER BY time_created ASC`,
      )
      .all(...ids);

    const textByMsg = new Map<string, string[]>();
    for (const part of parts) {
      try {
        const d = JSON.parse(part.data);
        if (d?.type === "text" && typeof d.text === "string") {
          const arr = textByMsg.get(part.message_id) ?? [];
          arr.push(d.text);
          textByMsg.set(part.message_id, arr);
        }
      } catch {}
    }

    let lastUser: string | null = null;
    let lastAssistant: string | null = null;
    let tokens = 0;

    for (const m of msgs) {
      let role: string | null = null;
      try {
        const d = JSON.parse(m.data);
        role = d?.role ?? null;
        if (d?.tokens) {
          const t = d.tokens;
          tokens += (t.input ?? 0) + (t.output ?? 0);
        }
      } catch {}
      const text = (textByMsg.get(m.id) ?? []).join("\n").trim();
      if (!text) continue;
      if (role === "user" && !lastUser && !looksLikeMeta(text)) lastUser = text;
      else if (role === "assistant" && !lastAssistant) lastAssistant = text;
      if (lastUser && lastAssistant) break;
    }

    const total = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM message WHERE session_id = ?",
      )
      .get(s.id)?.n ?? 0;

    return {
      lastUser,
      lastAssistant,
      messageCount: total || null,
      totalTokens: tokens > 0 ? tokens : null,
    };
  } catch {
    return EMPTY;
  } finally {
    db.close();
  }
}
