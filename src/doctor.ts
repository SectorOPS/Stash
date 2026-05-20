import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import pc from "picocolors";
import type { Tool } from "./types";
import { tildeify } from "./format";

/**
 * stash doctor — quick health check of the assumptions each discovery module
 * makes about its respective tool's on-disk format.
 *
 * For each of claude / codex / opencode:
 *   1. detect whether the CLI is installed and its version
 *   2. find one session on disk
 *   3. parse the bits the rest of stash relies on (title field, cwd field,
 *      message count source, etc.)
 *   4. report ok/warn/error with a one-line explanation
 *
 * Exits non-zero on any *error* (warnings — e.g. "tool not installed" — don't
 * fail the check).
 */

export interface CheckResult {
  tool: Tool;
  status: "ok" | "warn" | "error";
  installedVersion: string | null;
  sample: string | null;
  detail: string;
}

const STORAGE_HINTS: Record<Tool, string> = {
  claude: "~/.claude/projects/<encoded-path>/<uuid>.jsonl",
  codex: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
  opencode: "~/.local/share/opencode/opencode.db (sqlite)",
};

export async function runDoctor(): Promise<number> {
  const padTool = (t: string) => t.padEnd(9);
  console.log(pc.bold("stash doctor"));
  console.log(pc.dim("─".repeat(58)));

  const results = await Promise.all([
    checkClaude(),
    checkCodex(),
    checkOpencode(),
  ]);

  for (const r of results) {
    const icon =
      r.status === "ok"
        ? pc.green("✓")
        : r.status === "warn"
          ? pc.yellow("!")
          : pc.red("✗");
    const ver = (r.installedVersion ?? pc.dim("not installed")).padEnd(13);
    console.log(`${icon} ${padTool(r.tool)} ${ver} ${r.detail}`);
    if (r.sample) {
      console.log(`  ${pc.dim("sample: " + tildeify(r.sample))}`);
    }
  }

  const errors = results.filter((r) => r.status === "error").length;
  const warns = results.filter((r) => r.status === "warn").length;

  console.log(pc.dim("─".repeat(58)));
  if (errors > 0) {
    console.log(
      pc.red(`${errors} error(s)`) +
        (warns ? pc.yellow(`, ${warns} warning(s)`) : "") +
        ". Open an issue at https://github.com/SectorOPS/Stash/issues with this output.",
    );
    return 1;
  }
  if (warns > 0) {
    console.log(
      pc.yellow(`${warns} warning(s).`) +
        " Stash will work but won't see sessions from skipped tools.",
    );
    return 0;
  }
  console.log(pc.green("All systems go."));
  return 0;
}

async function execVersion(bin: string): Promise<string | null> {
  const raw = await new Promise<string | null>((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) =>
      resolve(code === 0 ? out.trim().split("\n", 1)[0] ?? null : null),
    );
  });
  if (!raw) return null;
  // Strip product-name noise like "claude 2.1.133 (Claude Code)" or
  // "codex-cli 0.129.0" — keep just the semver-looking token.
  const m = raw.match(/\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?/);
  return m ? m[0] : raw;
}

async function findFirstJsonl(root: string): Promise<string | null> {
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
      if (s.isDirectory()) {
        queue.push(full);
      } else if (s.isFile() && entry.endsWith(".jsonl") && s.size > 0) {
        return full;
      }
    }
  }
  return null;
}

async function checkClaude(): Promise<CheckResult> {
  const version = await execVersion("claude");
  const root = join(homedir(), ".claude", "projects");
  const sample = await findFirstJsonl(root);

  if (!version && !sample) {
    return {
      tool: "claude",
      status: "warn",
      installedVersion: null,
      sample: null,
      detail: `not installed and no sessions at ${STORAGE_HINTS.claude}`,
    };
  }
  if (!sample) {
    return {
      tool: "claude",
      status: "warn",
      installedVersion: version,
      sample: null,
      detail: `installed but no sessions yet (${STORAGE_HINTS.claude})`,
    };
  }

  try {
    const f = Bun.file(sample);
    const text = await f.slice(0, Math.min(f.size, 128 * 1024)).text();
    const lines = text.split("\n").filter(Boolean);
    let sawUser = false;
    let sawTitleOrPrompt = false;
    for (const line of lines.slice(0, 200)) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "user" || obj?.role === "user") sawUser = true;
        if (
          obj?.type === "ai-title" ||
          obj?.type === "last-prompt" ||
          obj?.type === "summary"
        ) {
          sawTitleOrPrompt = true;
        }
      } catch {
        // skip malformed lines
      }
    }
    if (!sawUser) {
      return {
        tool: "claude",
        status: "error",
        installedVersion: version,
        sample,
        detail:
          "parsed the file but found no 'user' message — JSONL schema may have changed",
      };
    }
    return {
      tool: "claude",
      status: "ok",
      installedVersion: version,
      sample,
      detail: sawTitleOrPrompt
        ? "parsed session, title metadata present"
        : "parsed session (no ai-title/last-prompt yet — fine for new sessions)",
    };
  } catch (err) {
    return {
      tool: "claude",
      status: "error",
      installedVersion: version,
      sample,
      detail: `failed to read session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkCodex(): Promise<CheckResult> {
  const version = await execVersion("codex");
  const root = join(homedir(), ".codex", "sessions");
  const sample = await findFirstJsonl(root);

  if (!version && !sample) {
    return {
      tool: "codex",
      status: "warn",
      installedVersion: null,
      sample: null,
      detail: `not installed and no sessions at ${STORAGE_HINTS.codex}`,
    };
  }
  if (!sample) {
    return {
      tool: "codex",
      status: "warn",
      installedVersion: version,
      sample: null,
      detail: `installed but no sessions yet (${STORAGE_HINTS.codex})`,
    };
  }

  try {
    const f = Bun.file(sample);
    const head = await f.slice(0, Math.min(f.size, 32 * 1024)).text();
    const firstLine = head.split("\n", 1)[0] ?? "";
    if (!firstLine) {
      return {
        tool: "codex",
        status: "error",
        installedVersion: version,
        sample,
        detail: "rollout file is empty — codex format may have changed",
      };
    }
    let obj: { type?: string; payload?: { cwd?: unknown } };
    try {
      obj = JSON.parse(firstLine);
    } catch {
      return {
        tool: "codex",
        status: "error",
        installedVersion: version,
        sample,
        detail: "rollout's first line isn't valid JSON",
      };
    }
    if (obj?.type !== "session_meta") {
      return {
        tool: "codex",
        status: "error",
        installedVersion: version,
        sample,
        detail: `expected first line type "session_meta", got "${obj?.type ?? "?"}"`,
      };
    }
    if (typeof obj?.payload?.cwd !== "string") {
      return {
        tool: "codex",
        status: "error",
        installedVersion: version,
        sample,
        detail: "session_meta payload missing string `cwd` — codex rollout schema drift",
      };
    }
    return {
      tool: "codex",
      status: "ok",
      installedVersion: version,
      sample,
      detail: "parsed rollout (session_meta.payload.cwd present)",
    };
  } catch (err) {
    return {
      tool: "codex",
      status: "error",
      installedVersion: version,
      sample,
      detail: `failed to read rollout: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkOpencode(): Promise<CheckResult> {
  const version = await execVersion("opencode");
  const dbPath = join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "opencode.db",
  );

  if (!existsSync(dbPath)) {
    return {
      tool: "opencode",
      status: version ? "warn" : "warn",
      installedVersion: version,
      sample: null,
      detail: version
        ? `installed but ${STORAGE_HINTS.opencode} not found yet`
        : `not installed (${STORAGE_HINTS.opencode})`,
    };
  }

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      tool: "opencode",
      status: "error",
      installedVersion: version,
      sample: dbPath,
      detail: `couldn't open sqlite db: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // Verify the columns stash reads against — schema drift here is the
    // failure mode we most want to catch early.
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(session);")
      .all()
      .map((r) => r.name);
    const required = ["id", "directory", "title", "time_updated", "time_archived"];
    const missing = required.filter((c) => !cols.includes(c));
    if (missing.length > 0) {
      return {
        tool: "opencode",
        status: "error",
        installedVersion: version,
        sample: dbPath,
        detail: `session table missing columns: ${missing.join(", ")}`,
      };
    }
    const count = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM session WHERE time_archived IS NULL",
      )
      .get()?.n ?? 0;
    if (count === 0) {
      return {
        tool: "opencode",
        status: "warn",
        installedVersion: version,
        sample: dbPath,
        detail: "no active sessions in db",
      };
    }
    return {
      tool: "opencode",
      status: "ok",
      installedVersion: version,
      sample: dbPath,
      detail: `parsed sqlite db (${count} active session${count === 1 ? "" : "s"})`,
    };
  } catch (err) {
    return {
      tool: "opencode",
      status: "error",
      installedVersion: version,
      sample: dbPath,
      detail: `failed query: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    db.close();
  }
}
